import { BrowserWindow, WebContentsView } from 'electron'
import type {
  PreviewBounds,
  PreviewEvaluateRequest,
  PreviewEvaluateResult,
  PreviewPickRequest,
  PreviewPickResult
} from '@shared/types'
import { resolvePreviewSelection } from '@main/core/preview-selector'

const previewSelectionResolverSource = resolvePreviewSelection.toString()
const previewPickStateKey = '__tapcollectPreviewPickState'
const previewPickPending = '__tapcollect_preview_pick_pending__'
const previewPickMissing = '__tapcollect_preview_pick_missing__'
const previewPickPollIntervalMs = 50

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const decodePreviewPickResult = (serialized: string): PreviewPickResult => {
  let envelope: unknown
  try {
    envelope = JSON.parse(serialized)
  } catch {
    throw new Error('网页点选结果格式无效，请重新点选')
  }

  if (!isRecord(envelope)) throw new Error('网页点选结果格式无效，请重新点选')
  if (envelope.status === 'error') {
    throw new Error(
      typeof envelope.message === 'string' && envelope.message
        ? envelope.message
        : '无法识别点选节点'
    )
  }
  if (envelope.status !== 'success' || !isRecord(envelope.result)) {
    throw new Error('网页点选结果格式无效，请重新点选')
  }

  const result = envelope.result
  if (
    typeof result.cancelled !== 'boolean' ||
    typeof result.selector !== 'string' ||
    (result.selectorType !== 'css' && result.selectorType !== 'xpath') ||
    typeof result.matchCount !== 'number' ||
    !Number.isInteger(result.matchCount) ||
    result.matchCount < 0 ||
    typeof result.sample !== 'string'
  ) {
    throw new Error('网页点选结果格式无效，请重新点选')
  }

  return {
    cancelled: result.cancelled,
    selector: result.selector,
    selectorType: result.selectorType,
    matchCount: result.matchCount,
    sample: result.sample
  }
}

const validatePreviewUrl = (value: string): string => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('预览只支持 HTTP/HTTPS 地址')
  return url.toString()
}

const normalizeBounds = (bounds: PreviewBounds): PreviewBounds => ({
  x: Math.max(0, Math.round(bounds.x)),
  y: Math.max(0, Math.round(bounds.y)),
  width: Math.max(1, Math.round(bounds.width)),
  height: Math.max(1, Math.round(bounds.height))
})

export class PreviewService {
  private view: WebContentsView | null = null
  private pickSequence = 0

  constructor(private readonly window: BrowserWindow) {}

  async open(url: string, bounds: PreviewBounds): Promise<boolean> {
    const target = validatePreviewUrl(url)
    if (!this.view) this.createView()
    this.view?.setBounds(normalizeBounds(bounds))
    await this.view?.webContents.loadURL(target)
    return true
  }

  async navigate(url: string): Promise<boolean> {
    if (!this.view) throw new Error('网页预览尚未打开')
    await this.view.webContents.loadURL(validatePreviewUrl(url))
    return true
  }

  setBounds(bounds: PreviewBounds): boolean {
    if (!this.view) return false
    this.view.setBounds(normalizeBounds(bounds))
    return true
  }

  close(): boolean {
    if (!this.view) return false
    this.window.contentView.removeChildView(this.view)
    this.view.webContents.close()
    this.view = null
    return true
  }

  async pick(request: PreviewPickRequest): Promise<PreviewPickResult> {
    if (!this.view) throw new Error('网页预览尚未打开')
    const view = this.view
    const webContents = view.webContents
    const payload = JSON.stringify(request)
    const token = `${Date.now()}-${(this.pickSequence += 1)}`
    const stateKey = JSON.stringify(previewPickStateKey)
    const serializedToken = JSON.stringify(token)

    try {
      await webContents.executeJavaScript(`
        (() => {
        const request = ${payload};
        const stateKey = ${stateKey};
        const token = ${serializedToken};
        const previousState = window[stateKey];
        if (previousState && typeof previousState.cleanup === 'function') {
          previousState.cleanup();
        }
        const state = { token, result: '', cleanup: null };
        window[stateKey] = state;
        const marker = '__collectorHighlightedElements';
        const clearHighlights = () => {
          const previous = window[marker] || [];
          previous.forEach((entry) => {
            entry.element.style.outline = entry.outline;
            entry.element.style.outlineOffset = entry.outlineOffset;
          });
          window[marker] = [];
        };
        clearHighlights();
        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
          position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
          border: '2px solid #2563eb', background: 'rgba(37, 99, 235, .10)',
          display: 'none', boxSizing: 'border-box'
        });
        overlay.setAttribute('data-tapcollect-preview-picker', token);
        document.documentElement.appendChild(overlay);

        const highlight = (elements) => {
          const entries = elements.map((element) => ({
            element,
            outline: element.style.outline,
            outlineOffset: element.style.outlineOffset
          }));
          elements.forEach((element) => {
            element.style.outline = '2px solid #2563eb';
            element.style.outlineOffset = '1px';
          });
          window[marker] = entries;
        };
        const cleanup = () => {
          window.removeEventListener('mousemove', move, true);
          window.removeEventListener('click', click, true);
          window.removeEventListener('keydown', keydown, true);
          overlay.remove();
        };
        state.cleanup = cleanup;
        const settle = (result) => {
          const currentState = window[stateKey];
          cleanup();
          if (!currentState || currentState.token !== token) return;
          currentState.cleanup = null;
          currentState.result = JSON.stringify(result);
        };
        const eventElement = (event) => {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
          return path.find((entry) => entry instanceof Element && entry !== overlay) || null;
        };
        const fail = (error) => {
          const message = error instanceof Error ? error.message : String(error);
          settle({ status: 'error', message: message || '无法识别点选节点' });
        };
        const move = (event) => {
          const target = eventElement(event);
          if (!target) return;
          const rect = target.getBoundingClientRect();
          Object.assign(overlay.style, {
            display: 'block', left: rect.left + 'px', top: rect.top + 'px',
            width: rect.width + 'px', height: rect.height + 'px'
          });
        };
        const click = (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          const target = eventElement(event);
          if (!target) {
            fail(new Error('无法识别点选节点，请点击列表文字或列表区域后重试'));
            return;
          }
          try {
            const selection = (${previewSelectionResolverSource})(target, request.scopeSelector);
            const selector = selection.selector;
            const matches = selection.matches;
            highlight(matches);
            settle({
              status: 'success',
              result: {
                cancelled: false,
                selector,
                selectorType: 'css',
                matchCount: matches.length,
                sample: (target.textContent || '').trim().slice(0, 160)
              }
            });
          } catch (error) {
            fail(error);
          }
        };
        const keydown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          settle({
            status: 'success',
            result: {
              cancelled: true,
              selector: '',
              selectorType: 'css',
              matchCount: 0,
              sample: ''
            }
          });
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('click', click, true);
        window.addEventListener('keydown', keydown, true);
          return true;
        })()
      `, true)
    } catch (error) {
      if (webContents.isDestroyed() || this.view !== view) {
        throw new Error('网页预览已关闭，点选已取消')
      }
      throw error
    }

    for (;;) {
      let serialized: unknown
      try {
        serialized = await webContents.executeJavaScript(`
          (() => {
            const state = window[${stateKey}];
            if (!state || state.token !== ${serializedToken}) return ${JSON.stringify(previewPickMissing)};
            return state.result || ${JSON.stringify(previewPickPending)};
          })()
        `, true)
      } catch {
        if (webContents.isDestroyed() || this.view !== view) {
          throw new Error('网页预览已关闭，点选已取消')
        }
        throw new Error('预览页面已刷新或跳转，请重新点选')
      }

      if (serialized === previewPickMissing) {
        throw new Error('预览页面已刷新或跳转，请重新点选')
      }
      if (serialized === previewPickPending) {
        await wait(previewPickPollIntervalMs)
        continue
      }
      if (typeof serialized !== 'string') {
        throw new Error('网页点选结果格式无效，请重新点选')
      }
      return decodePreviewPickResult(serialized)
    }
  }

  async evaluate(request: PreviewEvaluateRequest): Promise<PreviewEvaluateResult> {
    if (!this.view) throw new Error('网页预览尚未打开')
    const payload = JSON.stringify(request)
    return this.view.webContents.executeJavaScript(`
      (() => {
        const request = ${payload};
        const marker = '__collectorHighlightedElements';
        const previous = window[marker] || [];
        previous.forEach((entry) => {
          entry.element.style.outline = entry.outline;
          entry.element.style.outlineOffset = entry.outlineOffset;
        });
        window[marker] = [];
        try {
          const scopes = request.scopeSelector
            ? Array.from(document.querySelectorAll(request.scopeSelector))
            : [document];
          if (
            request.scopeSelector &&
            request.scopeSelector !== ':root' &&
            scopes.length === 0
          ) {
            throw new Error(
              '当前预览页找不到已配置的列表项范围；若正在验证详情内容，请先将“页面来源”改为“详情页”'
            );
          }
          const matches = [];
          scopes.forEach((scope) => {
            if (request.selectorType === 'css') {
              matches.push(...scope.querySelectorAll(request.selector));
              return;
            }
            const result = document.evaluate(
              request.selector,
              scope,
              null,
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
              null
            );
            for (let index = 0; index < result.snapshotLength; index += 1) {
              const node = result.snapshotItem(index);
              if (node && node.nodeType === Node.ELEMENT_NODE) matches.push(node);
            }
          });
          const unique = Array.from(new Set(matches));
          window[marker] = unique.map((element) => ({
            element,
            outline: element.style.outline,
            outlineOffset: element.style.outlineOffset
          }));
          unique.forEach((element) => {
            element.style.outline = '2px solid #2563eb';
            element.style.outlineOffset = '1px';
          });
          return {
            matchCount: unique.length,
            sample: unique.length ? (unique[0].textContent || '').trim().slice(0, 160) : '',
            error: ''
          };
        } catch (error) {
          return { matchCount: 0, sample: '', error: error instanceof Error ? error.message : String(error) };
        }
      })()
    `, true) as Promise<PreviewEvaluateResult>
  }

  private createView(): void {
    this.view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: true,
        partition: 'web-info-collector-preview'
      }
    })
    this.view.setBackgroundColor('#ffffff')
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.view.webContents.session.setPermissionCheckHandler(() => false)
    this.view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false)
    )
    this.view.webContents.on('will-navigate', (event, url) => {
      try {
        validatePreviewUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    this.window.contentView.addChildView(this.view)
  }
}
