import { randomUUID } from 'node:crypto'
import { WebContentsView, type BrowserWindow } from 'electron'
import type { TaskConfig } from '@shared/types'
import { taskOutputMappings } from '@shared/output-template'
import {
  readDynamicDetailRenderState,
  isReadyDynamicPageChange,
  resolveDynamicDetailClick,
  resolveDynamicDomAction,
  type DynamicDetailDomActionResult,
  type DynamicDetailLocator,
  type DynamicDetailRenderState,
  type DynamicDomActionResult,
  type DynamicPageAdvance,
  type DynamicPageProvider,
  type DynamicPageSession,
  type DynamicPageSnapshot
} from '@main/core/dynamic-page'
import { allowedCustomRequestHeaders } from '@main/core/http-client'
import { AccessProtectionError, RequestInterruptedError, isAccessInterruption, parseRetryAfter } from '@main/core/access-errors'
import type { AccessCoordinator } from './access-coordinator'
import type { AccessProfileService } from './access-profile-service'
import { profileMatchesUrl } from '@shared/access-profile'

const dynamicDomActionSource = resolveDynamicDomAction.toString()
const dynamicDetailClickSource = resolveDynamicDetailClick.toString()
const dynamicDetailRenderSource = readDynamicDetailRenderState.toString()
const POLL_INTERVAL_MS = 150
const DETAIL_STABLE_MS = 450

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

const validateHttpUrl = (value: string): URL => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('动态分页只支持 HTTP/HTTPS 列表地址')
  }
  return url
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class ElectronDynamicPageSession implements DynamicPageSession {
  private latestSnapshot: DynamicPageSnapshot | null = null
  private blockedNavigation = ''
  private closed = false
  private closing: Promise<void> | null = null
  private detailView: WebContentsView | null = null
  private detailClickActive = false
  private detailNavigationError: Error | null = null
  private readonly signal: AbortSignal | undefined
  private readonly detailLocators: DynamicDetailLocator[]

  constructor(
    private readonly hostWindow: BrowserWindow,
    private readonly listView: WebContentsView,
    private readonly task: TaskConfig,
    private readonly startUrl: string,
    private readonly allowedHostname: string,
    private readonly access: AccessCoordinator | undefined,
    private readonly createDetailView: () => WebContentsView,
    private readonly permitsUrl: (url: string) => boolean
  ) {
    this.signal = access?.signal
    this.detailLocators = taskOutputMappings(task).flatMap((mapping) => {
      if (mapping.mode === 'page' && mapping.pageSource === 'detail') {
        return [
          {
            selectorType: mapping.selectorType,
            selector: mapping.selector,
            startMarker: mapping.startMarker,
            endMarker: mapping.endMarker,
            extraction: mapping.extraction,
            attribute: mapping.attribute,
            matchMode: mapping.matchMode
          }
        ]
      }
      if (mapping.mode !== 'merge') return []
      return mapping.mergeValues
        .filter((value) => value.mode === 'page' && value.pageSource === 'detail')
        .map((value) => ({
          selectorType: value.selectorType,
          selector: value.selector,
          startMarker: value.startMarker,
          endMarker: value.endMarker,
          extraction: value.extraction,
          attribute: value.attribute,
          matchMode: value.matchMode
        }))
    })
  }

  private get view(): WebContentsView {
    return this.detailView ?? this.listView
  }

  handleDetailWindowOpen(details: Electron.HandlerDetails): void {
    if (!this.detailClickActive || this.detailView) return
    try {
      this.assertAlive()
      if (!this.permitsUrl(details.url)) throw new Error('详情新窗口地址不在允许的站点或访问配置来源内')
      if (details.postBody) throw new Error('点击式详情不支持通过新窗口提交表单')
      const detailView = this.createDetailView()
      this.detailView = detailView
      void detailView.webContents.loadURL(details.url, { httpReferrer: details.referrer }).catch((error: unknown) => {
        if (this.detailView === detailView) this.detailNavigationError = error instanceof Error ? error : new Error(String(error))
      })
    } catch (error) {
      this.detailNavigationError = error instanceof Error ? error : new Error(String(error))
    }
  }

  async initialize(): Promise<void> {
    const timeoutMs = this.task.request.timeoutSeconds * 1_000
    const navigationDeadline = Date.now() + timeoutMs
    const navigation: {
      state: 'loading' | 'loaded' | 'failed'
      error: unknown
    } = { state: 'loading', error: null }
    let renderedDeadline: number | null = null
    let latestReadableSnapshot: DynamicPageSnapshot | null = null
    let latestSnapshotError: unknown = null
    let domReady = false
    const markDomReady = (): void => {
      domReady = true
    }

    this.view.webContents.on('dom-ready', markDomReady)
    try {
      void this.view.webContents.loadURL(this.startUrl).then(
        () => {
          navigation.state = 'loaded'
        },
        (error: unknown) => {
          navigation.state = 'failed'
          navigation.error = error
        }
      )

      for (;;) {
        this.assertAlive()
        if (domReady || navigation.state === 'loaded') {
          try {
            const snapshot = await this.readSnapshot()
            latestReadableSnapshot = snapshot
            latestSnapshotError = null
            if (snapshot.itemCount > 0) {
              this.latestSnapshot = snapshot
              return
            }
          } catch (error) {
            if (isAccessInterruption(error)) throw error
            latestSnapshotError = error
          }
        }

        const now = Date.now()
        if (navigation.state === 'failed') {
          throw navigation.error instanceof Error
            ? navigation.error
            : new Error(String(navigation.error || '动态列表页加载失败'))
        }
        if (navigation.state === 'loaded') {
          renderedDeadline ??= now + timeoutMs
          if (now >= renderedDeadline) {
            if (latestReadableSnapshot) {
              this.latestSnapshot = latestReadableSnapshot
              return
            }
            throw latestSnapshotError instanceof Error
              ? latestSnapshotError
              : new Error('无法读取动态列表页 DOM')
          }
        } else if (now >= navigationDeadline) {
          throw new Error(`动态列表页加载超过 ${this.task.request.timeoutSeconds} 秒`)
        }

        await wait(POLL_INTERVAL_MS)
      }
    } finally {
      if (!this.view.webContents.isDestroyed()) {
        this.view.webContents.off('dom-ready', markDomReady)
      }
    }
  }

  async current(): Promise<DynamicPageSnapshot> {
    this.assertAlive()
    this.latestSnapshot = await this.readSnapshot()
    return this.latestSnapshot
  }

  async advance(): Promise<DynamicPageAdvance> {
    this.assertAlive()
    const previous = this.latestSnapshot ?? (await this.current())
    const action = await this.execute('click')
    if (action.kind === 'end') return action
    if (action.kind !== 'clicked') throw new Error('动态分页按钮没有执行点击')

    const timeoutMs = this.task.request.timeoutSeconds * 1_000
    const deadline = Date.now() + timeoutMs
    let lastError: unknown = null
    let sawEmptyChange = false
    while (Date.now() < deadline) {
      await wait(POLL_INTERVAL_MS)
      this.assertAlive()
      try {
        const snapshot = await this.readSnapshot()
        if (isReadyDynamicPageChange(previous, snapshot)) {
          this.latestSnapshot = snapshot
          return { kind: 'page', snapshot }
        }
        if (snapshot.itemCount === 0 && snapshot.signature !== previous.signature) {
          sawEmptyChange = true
        }
      } catch (error) {
        if (isAccessInterruption(error)) throw error
        lastError = error
      }
    }
    if (this.blockedNavigation) {
      throw new Error(`动态列表页试图跳转到不同 hostname：${this.blockedNavigation}`)
    }
    if (lastError && this.view.webContents.isDestroyed()) {
      throw lastError
    }
    return {
      kind: 'end',
      reason: sawEmptyChange
        ? `点击后列表在 ${this.task.request.timeoutSeconds} 秒内没有渲染出新数据`
        : `点击后列表内容在 ${this.task.request.timeoutSeconds} 秒内没有变化`
    }
  }

  async openDetail(itemIndex: number): Promise<DynamicPageSnapshot> {
    this.assertAlive()
    const listSnapshot = this.latestSnapshot ?? (await this.current())
    const before = await this.readDetailRenderState()
    const timeoutMs = this.task.request.timeoutSeconds * 1_000
    const deadline = Date.now() + timeoutMs
    let stableSignature = ''
    let stableSince = Date.now()
    let latestDetail: DynamicPageSnapshot | null = null
    this.detailNavigationError = null
    this.detailClickActive = true
    try {
      const action = await this.executeDetailClick(itemIndex)
      if (action.kind === 'error') throw new Error(action.reason)
      while (Date.now() < deadline) {
        await wait(POLL_INTERVAL_MS)
        this.assertAlive()
        if (this.detailNavigationError) throw this.detailNavigationError
        if (this.blockedNavigation) this.assertAllowedPage()
        try {
          // A new main frame can briefly be unreadable while navigation commits.
          const state = await this.readDetailRenderState()
          const snapshot = await this.readSnapshot()
          const changed = snapshot.url !== listSnapshot.url ||
            (state.signature !== before.signature && state.matchCount > 0) ||
            (this.detailLocators.length === 0 && snapshot.html !== listSnapshot.html && snapshot.itemCount === 0)
          if (!changed) continue
          latestDetail = { ...snapshot, itemCount: 0, signature: '' }
          const signature = `${snapshot.url}\n${state.signature}`
          if (signature !== stableSignature) {
            stableSignature = signature
            stableSince = Date.now()
          }
          if (state.populatedCount === this.detailLocators.length && Date.now() - stableSince >= DETAIL_STABLE_MS) {
            return latestDetail
          }
        } catch (error) {
          if (isAccessInterruption(error)) throw error
          if (this.blockedNavigation) this.assertAllowedPage()
        }
      }
      // Optional/missing fields retain their normal extraction semantics at the
      // bounded deadline; a selector existing with an empty value is not ready.
      if (latestDetail) return latestDetail
      throw new Error(`点击后页面在 ${this.task.request.timeoutSeconds} 秒内没有进入详情`)
    } finally {
      this.detailClickActive = false
    }
  }

  async returnToList(): Promise<DynamicPageSnapshot> {
    this.assertAlive()
    const previous = this.latestSnapshot
    if (!previous) throw new Error('没有可返回的动态列表页状态')
    this.detailClickActive = false
    this.detailNavigationError = null
    this.blockedNavigation = ''
    if (this.detailView) {
      await this.closeView(this.detailView)
      this.detailView = null
      return this.current()
    }
    const timeoutMs = this.task.request.timeoutSeconds * 1_000
    try {
      const current = await this.readSnapshot()
      if (current.url === previous.url && current.itemCount > 0) {
        this.latestSnapshot = current
        return current
      }
    } catch {
      // A partially changed document is recovered through history or reload below.
    }
    await this.executeInMainFrame('window.history.back()', true)
    const fromHistory = await this.waitForList(previous.url, timeoutMs)
    if (fromHistory) return fromHistory

    await withTimeout(
      this.view.webContents.loadURL(previous.url),
      timeoutMs,
      `重新加载列表页超过 ${this.task.request.timeoutSeconds} 秒`
    )
    const fromReload = await this.waitForList(previous.url, timeoutMs)
    if (fromReload) return fromReload
    throw new Error(`详情返回列表超过 ${this.task.request.timeoutSeconds} 秒`)
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.detailClickActive = false
    this.closing = (async () => {
      if (this.detailView) await this.closeView(this.detailView)
      this.detailView = null
      await this.closeView(this.listView)
    })()
    return this.closing
  }

  private async closeView(view: WebContentsView): Promise<void> {
    if (!this.hostWindow.isDestroyed()) {
      try {
        this.hostWindow.contentView.removeChildView(view)
      } catch {
        // The parent window may already be tearing down its child views.
      }
    }
    if (!view.webContents.isDestroyed()) {
      await new Promise<void>((resolve) => {
        view.webContents.once('destroyed', resolve)
        view.webContents.close({ waitForBeforeUnload: false })
      })
    }
  }

  private async readSnapshot(): Promise<DynamicPageSnapshot> {
    const result = await this.execute('snapshot')
    if (result.kind !== 'snapshot') throw new Error('无法读取动态列表页 DOM')
    this.assertAllowedPage(result.url)
    this.access?.inspectHtml(result.html, result.url)
    return {
      html: result.html,
      url: result.url,
      itemCount: result.itemCount,
      signature: result.signature
    }
  }

  private async readDetailRenderState(): Promise<DynamicDetailRenderState> {
    return this.executeInMainFrame<DynamicDetailRenderState>(
      `(${dynamicDetailRenderSource})(document,${JSON.stringify(this.detailLocators)})`,
      true
    )
  }

  private async waitForList(url: string, timeoutMs: number): Promise<DynamicPageSnapshot | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await wait(POLL_INTERVAL_MS)
      this.assertAlive()
      try {
        const snapshot = await this.readSnapshot()
        if (snapshot.itemCount > 0 && snapshot.url === url) {
          this.latestSnapshot = snapshot
          return snapshot
        }
      } catch {
        // The router can briefly expose an incomplete document while returning.
      }
    }
    return null
  }

  private async executeDetailClick(itemIndex: number): Promise<DynamicDetailDomActionResult> {
    this.assertAlive()
    const payload = [
      'document',
      JSON.stringify(this.task.listItem),
      JSON.stringify(this.task.detail.link),
      JSON.stringify(itemIndex)
    ].join(',')
    return this.executeInMainFrame<DynamicDetailDomActionResult>(
      `(${dynamicDetailClickSource})(${payload})`,
      true
    )
  }

  private async execute(action: 'snapshot' | 'click'): Promise<DynamicDomActionResult> {
    this.assertAlive()
    const payload = [
      'document',
      JSON.stringify(action),
      JSON.stringify(this.task.listItem),
      JSON.stringify(this.task.pagination.nextButton),
      'window.location.href'
    ].join(',')
    return this.executeInMainFrame<DynamicDomActionResult>(
      `(${dynamicDomActionSource})(${payload})`,
      true
    )
  }

  private async executeInMainFrame<T>(code: string, userGesture = false): Promise<T> {
    this.assertAlive()
    const frame = this.view.webContents.mainFrame
    if (frame.isDestroyed()) throw new Error('动态分页网页主框架已关闭')
    return frame.executeJavaScript(code, userGesture) as Promise<T>
  }

  private assertAllowedPage(value = this.view.webContents.getURL()): void {
    if (this.blockedNavigation) {
      throw new Error(`动态列表页试图跳转到不同 hostname：${this.blockedNavigation}`)
    }
    const current = validateHttpUrl(value)
    if (current.hostname.toLowerCase() !== this.allowedHostname) {
      throw new Error(`动态列表页跳转到不同 hostname：${current.toString()}`)
    }
  }

  private assertAlive(): void {
    const protection = this.access?.getProtection(this.allowedHostname)
    if (protection && (protection.kind === 'action-required' || protection.until > Date.now())) throw new AccessProtectionError(protection)
    if (this.signal?.aborted) throw new RequestInterruptedError()
    if (this.closed || this.hostWindow.isDestroyed() || this.view.webContents.isDestroyed()) {
      throw new Error('动态分页网页实例已关闭')
    }
  }

  markBlockedNavigation(url: string): void {
    this.blockedNavigation = url
  }
}

export class ElectronDynamicPageProvider implements DynamicPageProvider {
  constructor(private readonly hostWindow: BrowserWindow, private readonly access?: AccessCoordinator, private readonly profiles?: AccessProfileService) {}

  async create(task: TaskConfig, requestedStartUrl?: string): Promise<DynamicPageSession> {
    const startUrl =
      requestedStartUrl?.trim() ||
      task.listPageRules.map((value) => value.trim()).find(Boolean) ||
      task.listUrl
    const parsed = validateHttpUrl(startUrl)
    const allowedHostname = parsed.hostname.toLowerCase()
    if (task.accessProfileId && !this.profiles) throw new Error('访问配置服务不可用')
    const profile = await this.profiles?.acquire(task)
    if (profile && !profileMatchesUrl(profile, startUrl)) { profile.release(); throw new Error('动态页面地址与访问配置来源不匹配') }
    const browserSession = profile ? { session: profile.session } : { partition: `web-info-collector-dynamic-${randomUUID()}` }
    const createView = (): WebContentsView => new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: true,
        backgroundThrottling: false,
        ...browserSession
      }
    })
    const view = createView()
    view.webContents.once('destroyed', () => profile?.release())
    const request = this.access?.requestConfig(task.request) ?? task.request
    view.webContents.session.setPermissionCheckHandler(() => false)
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false)
    )

    const customHeaders = allowedCustomRequestHeaders(request)
    if (!profile) view.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        const headers = { ...details.requestHeaders }
        if (this.access) headers['Accept-Language'] = this.access.language
        try {
          if (new URL(details.url).hostname.toLowerCase() === allowedHostname) {
            for (const entry of customHeaders) headers[entry.key] = entry.value
          }
        } catch {
          // Invalid subresource URLs are left untouched and handled by Chromium.
        }
        callback({ requestHeaders: headers })
      }
    )

    const permitsUrl = (url: string): boolean => {
      try {
        return validateHttpUrl(url).hostname.toLowerCase() === allowedHostname && (!profile || profileMatchesUrl(profile, url))
      } catch {
        return false
      }
    }
    const session = new ElectronDynamicPageSession(
      this.hostWindow,
      view,
      task,
      parsed.toString(),
      allowedHostname,
      this.access,
      () => {
        const detailView = createView()
        try {
          configureView(detailView)
          this.hostWindow.contentView.addChildView(detailView)
          return detailView
        } catch (error) {
          detailView.webContents.close()
          throw error
        }
      },
      permitsUrl
    )
    const onResponse = (details: Electron.OnHeadersReceivedListenerDetails): void => {
        if (!this.access) return
        if (details.resourceType !== 'mainFrame') return
        const status = details.statusCode
        if (status === 401 || status === 403) {
          const header = Object.entries(details.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]?.[0] ?? null
          const duration = parseRetryAfter(header)
          if (duration > 0) this.access.protect(allowedHostname, '按 Retry-After 等待', Date.now() + duration)
          this.access.protect(allowedHostname, `服务器返回 ${status}，请人工检查访问权限后重试`, 0, { taskId: task.id, url: details.url, resource: false })
        }
        else if ([408, 425, 429].includes(status) || status >= 500) {
          const header = Object.entries(details.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]?.[0] ?? null
          const duration = Math.max(parseRetryAfter(header), this.access?.settings.cooldownSeconds ? this.access.settings.cooldownSeconds * 1000 : 60000)
          this.access?.protect(allowedHostname, `动态页面返回 ${status}，站点进入冷却`, Date.now() + duration)
        }
    }
    if (!profile && this.access) view.webContents.session.webRequest.onHeadersReceived((details, callback) => { callback({}); onResponse(details) })
    const guardNavigation = (event: Electron.Event, url: string): void => {
      if (permitsUrl(url)) return
      event.preventDefault()
      session.markBlockedNavigation(url)
    }
    const configureView = (target: WebContentsView): void => {
      target.setBackgroundColor('#ffffff')
      target.setBounds({ x: 100_000, y: 0, width: 1, height: 1 })
      target.webContents.setUserAgent(request.userAgent)
      target.webContents.setWindowOpenHandler((details) => {
        if (target === view) session.handleDetailWindowOpen(details)
        return { action: 'deny' }
      })
      if (profile) profile.attach(target.webContents, onResponse)
      target.webContents.on('will-navigate', guardNavigation)
      target.webContents.on('will-redirect', guardNavigation)
    }
    configureView(view)
    this.hostWindow.contentView.addChildView(view)

    try {
      const access = this.access
      if (!access) { await session.initialize(); return session }
      const scheduled = async <T>(operation: () => Promise<T>): Promise<T> => access.run(startUrl, task.request.delayMs, operation)
      await scheduled(() => session.initialize())
      const inspect = (snapshot: DynamicPageSnapshot): DynamicPageSnapshot => {
        access.inspectHtml(snapshot.html, snapshot.url)
        access.acknowledgeSuccess(snapshot.url)
        return snapshot
      }
      return {
        current: async () => inspect(await session.current()),
        advance: () => scheduled(async () => {
          const result = await session.advance()
          if (result.kind === 'page') inspect(result.snapshot)
          return result
        }),
        openDetail: (index) => scheduled(async () => inspect(await session.openDetail(index))),
        returnToList: () => scheduled(async () => inspect(await session.returnToList())),
        close: () => session.close()
      }
    } catch (error) {
      await session.close()
      throw error
    }
  }
}
