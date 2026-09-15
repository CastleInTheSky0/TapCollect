import { BrowserWindow, net, type OnHeadersReceivedListenerDetails } from 'electron'
import type { TaskConfig } from '@shared/types'
import { profileMatchesUrl } from '@shared/access-profile'
import { HttpClient } from '@main/core/http-client'
import { RequestInterruptedError, parseRetryAfter } from '@main/core/access-errors'
import { resourceErrorPageReason, resourceResponseHtml } from '@main/core/resource-response'
import type { AccessProfileLease } from './access-profile-service'
import type { AccessCoordinator } from './access-coordinator'

export interface VerificationRequest {
  id: string
  url: string
  resource: boolean
  task: TaskConfig
  profile?: AccessProfileLease | undefined
}

export interface ManualVerificationProvider {
  open(request: VerificationRequest, closed: () => void): void
  close(id: string): void
  probe(request: VerificationRequest, signal: AbortSignal): Promise<void>
}

/** 验证网页没有应用 preload；凭据和窗口操作始终留在主进程。 */
export class ManualVerificationService implements ManualVerificationProvider {
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly http: HttpClient

  constructor(private readonly access: AccessCoordinator) {
    this.http = new HttpClient((input, init) => (net.fetch as typeof fetch)(input, init), access)
  }

  open(request: VerificationRequest, closed: () => void): void {
    const existing = this.windows.get(request.id)
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return }
    if (!request.profile || !profileMatchesUrl(request.profile, request.url)) {
      throw new Error('网页登录需要任务绑定与触发地址来源一致的访问配置，请取消本次运行后调整配置')
    }
    const window = this.createWindow(request, true)
    this.windows.set(request.id, window)
    window.once('closed', () => {
      if (this.windows.get(request.id) !== window) return
      this.windows.delete(request.id)
      closed()
    })
    // 加载失败或关闭都不代表验证成功；用户可重新打开后再确认。
    void window.loadURL(request.url).catch(() => {})
  }

  close(id: string): void {
    const window = this.windows.get(id)
    this.windows.delete(id)
    if (window && !window.isDestroyed()) window.destroy()
  }

  async probe(request: VerificationRequest, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new RequestInterruptedError()
    if (request.resource) {
      const result = await this.http.fetchResource(request.url, request.task.request)
      if (result.kind !== 'success') throw new Error('触发资源仍不可访问')
      const reader = result.response.body?.getReader()
      const chunks: Buffer[] = []
      let length = 0
      try {
        while (reader && length < 262144) {
          const chunk = await reader.read()
          if (chunk.done) break
          const bytes = Buffer.from(chunk.value).subarray(0, 262144 - length)
          chunks.push(bytes)
          length += bytes.length
        }
      } finally { await reader?.cancel() }
      if (signal.aborted) throw new RequestInterruptedError()
      const html = resourceResponseHtml(Buffer.concat(chunks), result.response.headers.get('content-type'), request.task.request.manualEncoding)
      if (html !== null) {
        this.access.inspectHtml(html, result.finalUrl, true)
        if (resourceErrorPageReason(html)) throw new Error('触发资源仍返回错误页面')
      }
      return
    }
    if (request.task.pagination.mode !== 'click' || !request.profile || !profileMatchesUrl(request.profile, request.url)) {
      const result = await this.http.fetchHtml(request.url, request.task.request)
      if (result.kind !== 'success') throw new Error('触发页面仍不可访问')
      return
    }
    await this.access.run(request.url, request.task.request.delayMs, () => this.probeBrowser(request, signal))
  }

  private async probeBrowser(request: VerificationRequest, signal: AbortSignal): Promise<void> {
    let response: OnHeadersReceivedListenerDetails | undefined
    let blocked = false
    const window = this.createWindow(request, false, details => { if (details.resourceType === 'mainFrame') response = details })
    window.webContents.on('will-redirect', (_event, url) => { if (!profileMatchesUrl(request.profile!, url)) blocked = true })
    const abort = (): void => { if (!window.isDestroyed()) window.destroy() }
    signal.addEventListener('abort', abort, { once: true })
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        window.loadURL(request.url),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('验证探测超时')), request.task.request.timeoutSeconds * 1000)
        })
      ])
      if (signal.aborted) throw new RequestInterruptedError()
      if (blocked || !response) throw new Error('验证页面未能在访问配置来源内加载')
      const hostname = new URL(request.url).hostname.toLowerCase()
      const duration = parseRetryAfter(Object.entries(response.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]?.[0] ?? null)
      if (duration > 0) throw this.access.protect(hostname, '按 Retry-After 等待', Date.now() + duration)
      if (response.statusCode < 200 || response.statusCode >= 400) throw new Error('验证页面仍不可访问')
      const snapshot = await window.webContents.executeJavaScript('({ url: location.href, html: document.documentElement.outerHTML })') as { url: string; html: string }
      if (signal.aborted) throw new RequestInterruptedError()
      this.access.inspectHtml(snapshot.html, snapshot.url)
    } finally {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (!window.isDestroyed()) window.destroy()
    }
  }

  private createWindow(request: VerificationRequest, show: boolean, response?: (details: OnHeadersReceivedListenerDetails) => void): BrowserWindow {
    const profile = request.profile!
    const title = `人工验证 · ${new URL(request.url).hostname}`
    const window = new BrowserWindow({
      width: 1040, height: 780, minWidth: 640, minHeight: 480, show, title, autoHideMenuBar: true,
      webPreferences: { session: profile.session, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    })
    profile.attach(window.webContents, response)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (event: Electron.Event, url: string): void => {
      if (!profileMatchesUrl(profile, url)) event.preventDefault()
    }
    window.webContents.on('will-navigate', guard)
    window.webContents.on('will-redirect', guard)
    window.webContents.on('page-title-updated', event => { event.preventDefault(); window.setTitle(title) })
    const download = (event: Electron.Event, _item: Electron.DownloadItem, contents: Electron.WebContents): void => {
      if (contents === window.webContents) event.preventDefault()
    }
    profile.session.on('will-download', download)
    window.once('closed', () => profile.session.removeListener('will-download', download))
    return window
  }
}
