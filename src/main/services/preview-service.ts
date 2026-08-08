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
    const payload = JSON.stringify(request)
    return this.view.webContents.executeJavaScript(`
      (() => new Promise((resolve, reject) => {
        const request = ${payload};
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
        const eventElement = (event) => {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
          return path.find((entry) => entry instanceof Element && entry !== overlay) || null;
        };
        const fail = (error) => {
          cleanup();
          const message = error instanceof Error ? error.message : String(error);
          reject(new Error(message || '无法识别点选节点'));
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
            cleanup();
            highlight(matches);
            resolve({
              cancelled: false,
              selector,
              selectorType: 'css',
              matchCount: matches.length,
              sample: (target.textContent || '').trim().slice(0, 160)
            });
          } catch (error) {
            fail(error);
          }
        };
        const keydown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          cleanup();
          resolve({ cancelled: true, selector: '', selectorType: 'css', matchCount: 0, sample: '' });
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('click', click, true);
        window.addEventListener('keydown', keydown, true);
      }))()
    `, true) as Promise<PreviewPickResult>
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
