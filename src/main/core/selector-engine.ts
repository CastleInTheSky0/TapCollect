import fontoxpath from 'fontoxpath'
import { normalizeContentFilterSelectors } from '@shared/content-filter'
import { normalizeTextPrefix, stripTextPrefix, textMatchesPrefix } from '@shared/text-prefix'
import type { PageExtractionConfig, SelectorType } from '@shared/types'

const { evaluateXPathToNodes } = fontoxpath

type QueryRoot = Document | Element

const selectCss = (root: QueryRoot, selector: string): Node[] => {
  if (selector === ':scope' && root.nodeType === root.ELEMENT_NODE) return [root]
  return Array.from(root.querySelectorAll(selector))
}

const selectXPath = (root: QueryRoot, selector: string): Node[] =>
  evaluateXPathToNodes(selector, root) as Node[]

export const selectNodes = (
  root: QueryRoot,
  selectorType: SelectorType,
  selector: string
): Node[] => {
  const expression = selector.trim()
  if (!expression) return []
  return selectorType === 'css' ? selectCss(root, expression) : selectXPath(root, expression)
}

export const selectMappingNodes = (
  root: QueryRoot,
  mapping: PageExtractionConfig
): Node[] => {
  const matches = selectNodes(root, mapping.selectorType, mapping.selector)
  const textPrefix = normalizeTextPrefix(mapping.textPrefix)
  if (mapping.extraction !== 'text' || !textPrefix) return matches
  return matches.filter((node) => textMatchesPrefix(node.textContent ?? '', textPrefix))
}

const SCRIPT_CONTENT_SELECTOR = 'script,noscript'

export class ContentFilterSelectorError extends Error {
  constructor(readonly selector: string) {
    super(`内容过滤 CSS 选择器“${selector}”无效`)
    this.name = 'ContentFilterSelectorError'
  }
}

const assertContentFilterSelectors = (root: QueryRoot, selectors: string[]): void => {
  for (const selector of selectors) {
    try {
      root.querySelector(selector)
    } catch {
      throw new ContentFilterSelectorError(selector)
    }
  }
}

const isScriptContentNode = (node: Node): boolean => {
  if (node.nodeType === node.ELEMENT_NODE) {
    return (node as Element).matches(SCRIPT_CONTENT_SELECTOR)
  }
  return Boolean(node.parentElement?.closest(SCRIPT_CONTENT_SELECTOR))
}

const isContentFilterMatch = (node: Node, selectors: string[]): boolean => {
  const element = node.nodeType === node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return selectors.some((selector) => Boolean(element?.closest(selector)))
}

const cloneWithoutFilteredContent = (
  element: Element,
  stripScriptContent: boolean,
  selectors: string[]
): Element => {
  const clone = element.cloneNode(true) as Element
  if (stripScriptContent) {
    clone.querySelectorAll(SCRIPT_CONTENT_SELECTOR).forEach((child) => child.remove())
  }
  for (const selector of selectors) {
    clone.querySelectorAll(selector).forEach((child) => child.remove())
  }
  return clone
}

const nodeText = (
  node: Node,
  stripScriptContent: boolean,
  contentFilterSelectors: string[]
): string => {
  if (!stripScriptContent && contentFilterSelectors.length === 0) return node.textContent ?? ''
  if (stripScriptContent && isScriptContentNode(node)) return ''
  if (isContentFilterMatch(node, contentFilterSelectors)) return ''
  if (node.nodeType === node.ELEMENT_NODE) {
    return cloneWithoutFilteredContent(
      node as Element,
      stripScriptContent,
      contentFilterSelectors
    ).textContent ?? ''
  }
  return node.textContent ?? ''
}

const nodeHtml = (
  node: Node,
  stripScriptContent: boolean,
  contentFilterSelectors: string[]
): string => {
  if (
    (stripScriptContent && isScriptContentNode(node)) ||
    isContentFilterMatch(node, contentFilterSelectors)
  ) {
    return ''
  }
  if (node.nodeType === node.ELEMENT_NODE) {
    const element = node as Element
    if (!stripScriptContent && contentFilterSelectors.length === 0) return element.innerHTML
    return cloneWithoutFilteredContent(
      element,
      stripScriptContent,
      contentFilterSelectors
    ).innerHTML
  }
  return nodeText(node, stripScriptContent, contentFilterSelectors)
}

const nodeAttribute = (node: Node, attribute: string): string => {
  if (node.nodeType === node.ATTRIBUTE_NODE) return node.nodeValue ?? ''
  if (node.nodeType === node.ELEMENT_NODE) {
    return (node as Element).getAttribute(attribute) ?? ''
  }
  return ''
}

export const extractRawValue = (
  root: QueryRoot,
  mapping: PageExtractionConfig,
  stripScriptContent = false
): string => {
  const matches = selectMappingNodes(root, mapping)
  const selected = mapping.matchMode === 'all' ? matches : matches.slice(0, 1)
  const contentFilterSelectors =
    mapping.extraction === 'attribute'
      ? []
      : normalizeContentFilterSelectors(mapping.contentFilterSelectors)
  assertContentFilterSelectors(root, contentFilterSelectors)
  const values = selected.map((node) => {
    if (mapping.extraction === 'html') {
      return nodeHtml(node, stripScriptContent, contentFilterSelectors)
    }
    if (mapping.extraction === 'attribute') return nodeAttribute(node, mapping.attribute)
    return stripTextPrefix(
      nodeText(node, stripScriptContent, contentFilterSelectors),
      mapping.textPrefix
    )
  })
  return values.join(mapping.separator)
}

export const cleanTextValue = (value: string, mapping: PageExtractionConfig): string => {
  let result = mapping.trim ? value.trim() : value
  if (mapping.collapseWhitespace) result = result.replace(/\s+/g, ' ')
  for (const replacement of mapping.replacements) {
    if (!replacement.from) continue
    result = result.split(replacement.from).join(replacement.to)
  }
  return result
}
