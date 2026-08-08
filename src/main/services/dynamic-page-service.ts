import { randomUUID } from 'node:crypto'
import { WebContentsView, type BrowserWindow } from 'electron'
import type { TaskConfig } from '@shared/types'
import {
  isReadyDynamicPageChange,
  resolveDynamicDomAction,
  type DynamicDomActionResult,
  type DynamicPageAdvance,
  type DynamicPageProvider,
  type DynamicPageSession,
  type DynamicPageSnapshot
} from '@main/core/dynamic-page'
import { allowedCustomRequestHeaders } from '@main/core/http-client'

const dynamicDomActionSource = resolveDynamicDomAction.toString()
const POLL_INTERVAL_MS = 150

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

  constructor(
    private readonly hostWindow: BrowserWindow,
    private readonly view: WebContentsView,
    private readonly task: TaskConfig,
    private readonly startUrl: string,
    private readonly allowedHostname: string
  ) {}

  async initialize(): Promise<void> {
    const timeoutMs = this.task.request.timeoutSeconds * 1_000
    await withTimeout(
      this.view.webContents.loadURL(this.startUrl),
      timeoutMs,
      `动态列表页加载超过 ${this.task.request.timeoutSeconds} 秒`
    )
    this.assertAllowedPage()

    const deadline = Date.now() + timeoutMs
    let snapshot = await this.readSnapshot()
    while (snapshot.itemCount === 0 && Date.now() < deadline) {
      await wait(POLL_INTERVAL_MS)
      snapshot = await this.readSnapshot()
    }
    this.latestSnapshot = snapshot
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

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.hostWindow.isDestroyed()) {
      try {
        this.hostWindow.contentView.removeChildView(this.view)
      } catch {
        // The parent window may already be tearing down its child views.
      }
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
  }

  private async readSnapshot(): Promise<DynamicPageSnapshot> {
    const result = await this.execute('snapshot')
    if (result.kind !== 'snapshot') throw new Error('无法读取动态列表页 DOM')
    this.assertAllowedPage(result.url)
    return {
      html: result.html,
      url: result.url,
      itemCount: result.itemCount,
      signature: result.signature
    }
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
    return this.view.webContents.executeJavaScript(
      `(${dynamicDomActionSource})(${payload})`,
      true
    ) as Promise<DynamicDomActionResult>
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
    if (this.closed || this.hostWindow.isDestroyed() || this.view.webContents.isDestroyed()) {
      throw new Error('动态分页网页实例已关闭')
    }
  }

  markBlockedNavigation(url: string): void {
    this.blockedNavigation = url
  }
}

export class ElectronDynamicPageProvider implements DynamicPageProvider {
  constructor(private readonly hostWindow: BrowserWindow) {}

  async create(task: TaskConfig): Promise<DynamicPageSession> {
    const startUrl = task.listPageRules.map((value) => value.trim()).find(Boolean) ?? task.listUrl
    const parsed = validateHttpUrl(startUrl)
    const allowedHostname = parsed.hostname.toLowerCase()
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: true,
        backgroundThrottling: false,
        partition: `web-info-collector-dynamic-${randomUUID()}`
      }
    })
    view.setBackgroundColor('#ffffff')
    view.setBounds({ x: 100_000, y: 0, width: 1, height: 1 })
    view.webContents.setUserAgent(task.request.userAgent)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.session.setPermissionCheckHandler(() => false)
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false)
    )

    const customHeaders = allowedCustomRequestHeaders(task.request)
    view.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        const headers = { ...details.requestHeaders }
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

    const session = new ElectronDynamicPageSession(
      this.hostWindow,
      view,
      task,
      parsed.toString(),
      allowedHostname
    )
    const guardNavigation = (event: Electron.Event, url: string): void => {
      try {
        if (validateHttpUrl(url).hostname.toLowerCase() === allowedHostname) return
      } catch {
        // Invalid and non-HTTP navigation is blocked below.
      }
      event.preventDefault()
      session.markBlockedNavigation(url)
    }
    view.webContents.on('will-navigate', guardNavigation)
    view.webContents.on('will-redirect', guardNavigation)
    this.hostWindow.contentView.addChildView(view)

    try {
      await session.initialize()
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }
}
