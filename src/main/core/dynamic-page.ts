import type { SelectorConfig, TaskConfig } from '@shared/types'

export interface DynamicPageSnapshot {
  html: string
  url: string
  itemCount: number
  signature: string
}

export type DynamicPageAdvance =
  | { kind: 'page'; snapshot: DynamicPageSnapshot }
  | { kind: 'end'; reason: string }

export interface DynamicPageSession {
  current: () => Promise<DynamicPageSnapshot>
  advance: () => Promise<DynamicPageAdvance>
  close: () => Promise<void>
}

export interface DynamicPageProvider {
  create: (task: TaskConfig) => Promise<DynamicPageSession>
}

export const isReadyDynamicPageChange = (
  previous: DynamicPageSnapshot,
  next: DynamicPageSnapshot
): boolean => next.itemCount > 0 && next.signature !== previous.signature

export type DynamicDomActionResult =
  | ({ kind: 'snapshot' } & DynamicPageSnapshot)
  | { kind: 'clicked' }
  | { kind: 'end'; reason: string }

export const resolveDynamicDomAction = (
  root: Document,
  action: 'snapshot' | 'click',
  listItem: SelectorConfig,
  nextButton: SelectorConfig,
  currentUrl: string
): DynamicDomActionResult => {
  const selectElements = (config: SelectorConfig): Element[] => {
    const expression = config.selector.trim()
    if (!expression) return []
    if (config.selectorType === 'css') return Array.from(root.querySelectorAll(expression))
    const result = root.evaluate(expression, root, null, 7, null)
    const elements: Element[] = []
    for (let index = 0; index < result.snapshotLength; index += 1) {
      const node = result.snapshotItem(index)
      if (node?.nodeType === 1) elements.push(node as Element)
    }
    return elements
  }

  if (action === 'click') {
    const next = selectElements(nextButton)[0]
    if (!next) return { kind: 'end', reason: '页面中找不到下一页按钮' }
    const ariaDisabled = next.getAttribute('aria-disabled')?.toLowerCase() === 'true'
    const propertyDisabled = Boolean((next as Element & { disabled?: boolean }).disabled)
    const disabledAttribute = next.hasAttribute('disabled')
    const classDisabled = String(next.getAttribute('class') ?? '')
      .split(/\s+/)
      .some((name) => name.toLowerCase().includes('disabled'))
    if (ariaDisabled || propertyDisabled || disabledAttribute || classDisabled) {
      return { kind: 'end', reason: '下一页按钮已禁用' }
    }

    const clickable = next as Element & { click?: () => void }
    if (typeof clickable.click === 'function') clickable.click()
    else {
      const EventConstructor = root.defaultView?.MouseEvent
      if (!EventConstructor) throw new Error('当前页面无法触发下一页点击事件')
      next.dispatchEvent(new EventConstructor('click', { bubbles: true, cancelable: true }))
    }
    return { kind: 'clicked' }
  }

  const items = selectElements(listItem)
  const content = items.map((element) => element.outerHTML).join('\n')
  let hash = 2_166_136_261
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return {
    kind: 'snapshot',
    html: root.documentElement?.outerHTML ?? '',
    url: currentUrl,
    itemCount: items.length,
    signature: `${items.length}:${(hash >>> 0).toString(16)}`
  }
}
