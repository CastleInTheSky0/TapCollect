import { randomUUID } from 'node:crypto'
import { WebContentsView, type BrowserWindow } from 'electron'
import type { TaskConfig } from '@shared/types'
import { taskOutputMappings } from '@shared/output-template'
import {
  countDynamicSelectorMatches,
  isReadyDynamicPageChange,
  resolveDynamicDetailClick,
  resolveDynamicDomAction,
  type DynamicDetailDomActionResult,
  type DynamicDomActionResult,
  type DynamicPageAdvance,
  type DynamicPageProvider,
  type DynamicPageSession,
  type DynamicPageSnapshot
} from '@main/core/dynamic-page'
import { allowedCustomRequestHeaders } from '@main/core/http-client'

const dynamicDomActionSource = resolveDynamicDomAction.toString()
const dynamicDetailClickSource = resolveDynamicDetailClick.toString()
const dynamicSelectorCountSource = countDynamicSelectorMatches.toString()
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
  private readonly detailSelectors: TaskConfig['listItem'][]

  constructor(
    private readonly hostWindow: BrowserWindow,
    private readonly view: WebContentsView,
    private readonly task: TaskConfig,
    private readonly startUrl: string,
    private readonly allowedHostname: string
  ) {
    this.detailSelectors = taskOutputMappings(task).flatMap((mapping) => {
      if (mapping.mode === 'page' && mapping.pageSource === 'detail') {
        return [{ selectorType: mapping.selectorType, selector: mapping.selector }]
      }
      if (mapping.mode !== 'merge') return []
      return mapping.mergeValues
        .filter((value) => value.mode === 'page' && value.pageSource === 'detail')
        .map((value) => ({ selectorType: value.selectorType, selector: value.selector }))
    })
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
    const action = await this.executeDetailClick(itemIndex)
    if (action.kind === 'error') throw new Error(action.reason)

    const timeoutMs = this.task.request.timeoutSeconds * 1_000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await wait(POLL_INTERVAL_MS)
      this.assertAlive()
      this.assertAllowedPage()
      const snapshot = await this.readSnapshot()
      const detailMatchCount = await this.readDetailMatchCount()
      if (
        snapshot.url !== listSnapshot.url ||
        (snapshot.html !== listSnapshot.html &&
          (detailMatchCount > 0 ||
            (this.detailSelectors.length === 0 && snapshot.itemCount === 0)))
      ) {
        await wait(POLL_INTERVAL_MS * 2)
        this.assertAlive()
        this.assertAllowedPage()
        return {
          html: await this.readDocumentHtml(),
          url: this.view.webContents.getURL(),
          itemCount: 0,
          signature: ''
        }
      }
    }
    throw new Error(`点击后页面在 ${this.task.request.timeoutSeconds} 秒内没有进入详情`)
  }

  async returnToList(): Promise<DynamicPageSnapshot> {
    this.assertAlive()
    const previous = this.latestSnapshot
    if (!previous) throw new Error('没有可返回的动态列表页状态')
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

  private async readDocumentHtml(): Promise<string> {
    return this.executeInMainFrame<string>(
      'document.documentElement ? document.documentElement.outerHTML : ""',
      true
    )
  }

  private async readDetailMatchCount(): Promise<number> {
    if (this.detailSelectors.length === 0) return 0
    return this.executeInMainFrame<number>(
      `(${dynamicSelectorCountSource})(document,${JSON.stringify(this.detailSelectors)})`,
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

  async create(task: TaskConfig, requestedStartUrl?: string): Promise<DynamicPageSession> {
    const startUrl =
      requestedStartUrl?.trim() ||
      task.listPageRules.map((value) => value.trim()).find(Boolean) ||
      task.listUrl
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
