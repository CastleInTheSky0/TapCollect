import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { session, safeStorage, type Session, type WebContents, type OnHeadersReceivedListenerDetails } from 'electron'
import PQueue from 'p-queue'
import { type AccessProfile, type AccessProfileInput, isAccessProfileId, parseProfileCookies, profileMatchesUrl, validateAccessProfile } from '@shared/access-profile'
import type { TaskConfig } from '@shared/types'
import { taskListPageRuleLines } from '@shared/list-page-rules'
import { allowedCustomRequestHeaders } from '@main/core/http-client'
import type { AccessCoordinator, AccessRequestIdentity } from './access-coordinator'
import { atomicWrite } from './task-store'

interface ViewIdentity {
  userAgent: string
  language: string
  headers: Array<{ key: string; value: string }>
  response?: (details: OnHeadersReceivedListenerDetails) => void
}
interface ProfileSession {
  session: Session
  views: Map<number, ViewIdentity>
  restoring: boolean
  pending: Map<string, ManualRequest>
  requests: Map<number, ManualRequest>
}
interface ManualRequest { requestId?: number; redirect?: { status: number; headers: Headers } }
const REQUEST_MARKER = 'x-tapcollect-session-request'

export interface AccessProfileLease extends AccessRequestIdentity {
  id: string
  origin: string
  session: Session
  release(): void
  attach(contents: WebContents, response?: (details: OnHeadersReceivedListenerDetails) => void): void
}

/** Single session/listener owner; metadata and encrypted credentials are separate. */
export class AccessProfileService {
  private readonly profiles = new Map<string, AccessProfileInput>()
  private readonly sessions = new Map<string, ProfileSession>()
  private readonly uses = new Map<string, number>()
  private readonly unreadable = new Set<string>()
  private readonly pendingWrites = new Set<string>()
  private readonly writeFailures = new Set<string>()
  private readonly queue = new PQueue({ concurrency: 1 })
  private readonly partitionPrefix = `tapcollect-profile-${randomUUID()}`

  constructor(private readonly root: string, private readonly access: AccessCoordinator) {}

  private get encrypted(): boolean {
    return safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  }

  async initialize(): Promise<void> {
    let rows: unknown
    try { rows = JSON.parse(await readFile(join(this.root, 'access-profiles.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('访问配置文件无法读取，请检查本机数据目录') }
    if (!Array.isArray(rows)) throw new Error('访问配置文件格式无效')
    for (const row of rows) {
      const value = validateAccessProfile(row as AccessProfileInput)
      if (!isAccessProfileId(value.id) || this.profiles.has(value.id)) throw new Error('访问配置标识重复或无效')
      this.profiles.set(value.id, value)
    }
  }

  list(): Promise<AccessProfile[]> {
    return this.queue.add(async () => {
      const result: AccessProfile[] = []
      for (const profile of this.profiles.values()) {
        try { await this.getSession(profile) } catch { this.unreadable.add(profile.id) }
        const cookies = await this.sessions.get(profile.id)?.session.cookies.get({}) ?? []
        result.push({ ...profile, cookieCount: cookies.length,
          storageStatus: this.unreadable.has(profile.id) ? 'unreadable' : this.encrypted ? 'encrypted' : 'memory-only' })
      }
      return result
    }) as Promise<AccessProfile[]>
  }

  save(input: AccessProfileInput): Promise<AccessProfileInput> {
    return this.queue.add(async () => {
      const value = validateAccessProfile(input)
      const old = value.id ? this.requireProfile(value.id) : null
      if (old) {
        this.assertIdle(old.id)
        if (old.origin !== value.origin) throw new Error('已有配置的来源不能修改，请新建访问配置')
      }
      value.id ||= randomUUID()
      const next = new Map(this.profiles).set(value.id, value)
      await this.saveMetadata(next)
      this.profiles.set(value.id, value)
      return { ...value }
    }) as Promise<AccessProfileInput>
  }

  remove(id: string, referenced: () => Promise<boolean>): Promise<boolean> {
    return this.queue.add(async () => {
      this.requireProfile(id)
      this.assertIdle(id)
      if (await referenced()) throw new Error('仍有任务绑定此访问配置，请先在任务中解除绑定')
      await this.clear(id)
      const next = new Map(this.profiles)
      next.delete(id)
      await this.saveMetadata(next)
      this.profiles.delete(id)
      return true
    }) as Promise<boolean>
  }

  importCookies(id: string, json: string): Promise<void> {
    return this.queue.add(async () => {
      const profile = this.requireProfile(id)
      this.assertIdle(id)
      const cookies = parseProfileCookies(json, profile.origin)
      const state = await this.getSession(profile)
      const before = await state.session.cookies.get({})
      state.restoring = true
      try {
        for (const cookie of cookies) await state.session.cookies.set({ ...cookie, url: profile.origin + cookie.path })
        await this.persist(profile, state)
      } catch {
        await state.session.clearStorageData({ storages: ['cookies'] })
        await this.restoreCookies(profile, state, before)
        throw new Error('Cookie 导入失败，原会话已保留；请检查属性和本机凭据存储')
      } finally { state.restoring = false }
    }) as Promise<void>
  }

  clearSession(id: string): Promise<void> {
    return this.queue.add(async () => { this.requireProfile(id); this.assertIdle(id); await this.clear(id) }) as Promise<void>
  }

  acquire(task: Pick<TaskConfig, 'accessProfileId' | 'request' | 'listUrl' | 'listPageRules' | 'pagination'>): Promise<AccessProfileLease | undefined> {
    if (!task.accessProfileId) return Promise.resolve(undefined)
    const effective = this.access.requestConfig(task.request)
    const fallbackLanguage = this.access.language
    return this.queue.add(async () => {
      const profile = this.requireProfile(task.accessProfileId!)
      for (const value of taskListPageRuleLines(task)) {
        if (!profileMatchesUrl(profile, value.replace(/\{page\}/g, '1'))) throw new Error('列表地址与访问配置来源不匹配，请修改地址或重新绑定配置')
      }
      const state = await this.getSession(profile)
      const userAgent = profile.userAgent || effective.userAgent
      const language = profile.language || fallbackLanguage
      const headers = allowedCustomRequestHeaders(effective).filter(({ key }) => !['user-agent', 'accept-language'].includes(key.toLowerCase()))
      this.uses.set(profile.id, (this.uses.get(profile.id) ?? 0) + 1)
      let released = false
      return {
        id: profile.id, origin: profile.origin, session: state.session, userAgent, language,
        fetch: (input, init) => {
          if (released) return Promise.reject(new Error('访问配置会话已关闭'))
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const matches = profileMatchesUrl(profile, url)
          const requestHeaders = new Headers(init?.headers)
          if (!matches) for (const entry of headers) requestHeaders.delete(entry.key)
          return this.fetchWithSession(state, url, { ...init, headers: requestHeaders, credentials: matches ? 'include' : 'omit' })
        },
        attach: (contents, response) => {
          contents.setUserAgent(userAgent)
          state.views.set(contents.id, { userAgent, language, headers, ...(response ? { response } : {}) })
          contents.once('destroyed', () => state.views.delete(contents.id))
        },
        release: () => {
          if (released) return
          released = true
          this.uses.set(profile.id, Math.max(0, (this.uses.get(profile.id) ?? 1) - 1))
        }
      }
    }) as Promise<AccessProfileLease>
  }

  async flush(): Promise<void> {
    await this.queue.add(async () => {
      for (const [id, state] of this.sessions) {
        const profile = this.profiles.get(id)
        if (!profile || this.unreadable.has(id)) continue
        try { await this.persist(profile, state) }
        catch { this.unreadable.add(id); this.writeFailures.add(id) }
      }
    })
    await this.queue.onIdle()
    if (this.writeFailures.size) throw new Error('部分访问配置的 Cookie 未能加密保存，请检查本机安全存储或清除相关登录状态')
  }

  private requireProfile(id: string): AccessProfileInput {
    const profile = this.profiles.get(id)
    if (!isAccessProfileId(id) || !profile) throw new Error('找不到任务绑定的访问配置，请在“基本信息”中重新绑定或选择“不使用访问配置”')
    return profile
  }

  private assertIdle(id: string): void {
    if (this.uses.get(id)) throw new Error('此访问配置正被预览、排队、运行、暂停或测试任务使用，请先关闭预览并结束相关任务')
  }

  private credentialPath(id: string): string { return join(this.root, 'access-credentials', `${id}.bin`) }
  private saveMetadata(rows: Map<string, AccessProfileInput>): Promise<void> {
    return atomicWrite(join(this.root, 'access-profiles.json'), JSON.stringify([...rows.values()], null, 2))
  }

  private async getSession(profile: AccessProfileInput): Promise<ProfileSession> {
    if (this.unreadable.has(profile.id)) throw new Error('访问配置的加密 Cookie 无法读取，请清除登录状态后重新登录')
    const existing = this.sessions.get(profile.id)
    if (existing) return existing
    const ses = session.fromPartition(`${this.partitionPrefix}-${profile.id}`)
    const state: ProfileSession = { session: ses, views: new Map(), restoring: true, pending: new Map(), requests: new Map() }
    ses.setPermissionCheckHandler(() => false)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      callback({ cancel: ['mainFrame', 'subFrame'].includes(details.resourceType) && !profileMatchesUrl(profile, details.url) })
    })
    ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const headers = { ...details.requestHeaders }
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== REQUEST_MARKER) continue
        const pending = state.pending.get(headers[key]!)
        if (pending) { pending.requestId = details.id; state.requests.set(details.id, pending) }
        delete headers[key]
      }
      const identity = state.views.get(details.webContentsId ?? -1)
      if (identity) {
        for (const key of Object.keys(headers)) if (['user-agent', 'accept-language'].includes(key.toLowerCase())) delete headers[key]
        headers['User-Agent'] = identity.userAgent
        headers['Accept-Language'] = identity.language
        if (profileMatchesUrl(profile, details.url)) for (const entry of identity.headers) headers[entry.key] = entry.value
      }
      if (!profileMatchesUrl(profile, details.url)) {
        for (const key of Object.keys(headers)) if (['cookie', 'authorization', 'proxy-authorization', 'referer'].includes(key.toLowerCase())) delete headers[key]
      }
      callback({ requestHeaders: headers })
    })
    ses.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders }
      const pending = state.requests.get(details.id)
      if (pending && details.statusCode >= 300 && details.statusCode < 400) {
        const responseHeaders = new Headers()
        for (const [key, values] of Object.entries(headers)) for (const value of values) responseHeaders.append(key, value)
        pending.redirect = { status: details.statusCode, headers: responseHeaders }
      }
      if (!profileMatchesUrl(profile, details.url)) for (const key of Object.keys(headers)) if (key.toLowerCase() === 'set-cookie') delete headers[key]
      callback({ responseHeaders: headers })
      state.views.get(details.webContentsId ?? -1)?.response?.(details)
    })
    try {
      let encrypted: Buffer | null = null
      try { encrypted = await readFile(this.credentialPath(profile.id)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (encrypted) {
        if (!this.encrypted) throw new Error('secure storage unavailable')
        const stored = JSON.parse(safeStorage.decryptString(encrypted)) as { id: string; origin: string; cookies: Electron.Cookie[] }
        if (stored.id !== profile.id || stored.origin !== profile.origin || !Array.isArray(stored.cookies)) throw new Error('invalid vault')
        await this.restoreCookies(profile, state, stored.cookies)
      }
    } catch {
      await ses.clearStorageData()
      this.unreadable.add(profile.id)
      throw new Error('访问配置的加密 Cookie 无法读取，请清除登录状态后重新登录')
    } finally { state.restoring = false }
    ses.cookies.on('changed', () => {
      if (state.restoring || this.pendingWrites.has(profile.id)) return
      this.pendingWrites.add(profile.id)
      void this.queue.add(async () => {
        try { if (this.profiles.has(profile.id)) await this.persist(profile, state) }
        catch { this.unreadable.add(profile.id); this.writeFailures.add(profile.id) }
        finally { this.pendingWrites.delete(profile.id) }
      })
    })
    this.sessions.set(profile.id, state)
    return state
  }

  private async fetchWithSession(state: ProfileSession, url: string, init: RequestInit): Promise<Response> {
    if (init.redirect !== 'manual') return state.session.fetch(url, init)
    // Electron 43 cancels manual redirects instead of returning the 3xx Response.
    // Correlate its native response to this fetch; the marker is removed before send.
    // HttpClient still schedules every subsequent hop and owns the only retry loop.
    const marker = randomUUID()
    const pending: ManualRequest = {}
    const headers = new Headers(init.headers)
    headers.set(REQUEST_MARKER, marker)
    state.pending.set(marker, pending)
    try { return await state.session.fetch(url, { ...init, headers }) }
    catch (error) {
      if (pending.redirect && !init.signal?.aborted) return new Response(null, pending.redirect)
      throw error
    } finally {
      state.pending.delete(marker)
      if (pending.requestId !== undefined) state.requests.delete(pending.requestId)
    }
  }

  private async restoreCookies(profile: AccessProfileInput, state: ProfileSession, cookies: Electron.Cookie[]): Promise<void> {
    const host = new URL(profile.origin).hostname
    for (const cookie of cookies) {
      const domain = (cookie.domain ?? host).replace(/^\./, '')
      if (host !== domain && !host.endsWith(`.${domain}`)) continue
      if (cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now() / 1000) continue
      await state.session.cookies.set({ url: profile.origin + (cookie.path ?? '/'), name: cookie.name, value: cookie.value,
        path: cookie.path ?? '/', secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly), sameSite: cookie.sameSite,
        ...(!cookie.hostOnly && cookie.domain ? { domain: cookie.domain } : {}),
        ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}) })
    }
  }

  private async persist(profile: AccessProfileInput, state: ProfileSession): Promise<void> {
    if (!this.encrypted) return
    const cookies = await state.session.cookies.get({})
    const content = safeStorage.encryptString(JSON.stringify({ id: profile.id, origin: profile.origin, cookies }))
    await atomicWrite(this.credentialPath(profile.id), content)
  }

  private async clear(id: string): Promise<void> {
    const state = this.sessions.get(id)
    if (state) {
      state.restoring = true
      try { await state.session.clearStorageData(); await state.session.clearCache(); await state.session.closeAllConnections() }
      finally { state.restoring = false }
    }
    await rm(this.credentialPath(id), { force: true })
    this.unreadable.delete(id)
    this.writeFailures.delete(id)
  }
}
