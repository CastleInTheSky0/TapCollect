import fontoxpath from 'fontoxpath'
import type { PageExtractionConfig, SelectorType } from '@shared/types'

const { evaluateXPathToNodes } = fontoxpath

type QueryRoot = Document | Element

const selectCss = (root: QueryRoot, selector: string): Node[] =>
  Array.from(root.querySelectorAll(selector))

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

const SCRIPT_CONTENT_SELECTOR = 'script,noscript'

const isScriptContentNode = (node: Node): boolean => {
  if (node.nodeType === node.ELEMENT_NODE) {
    return (node as Element).matches(SCRIPT_CONTENT_SELECTOR)
  }
  return Boolean(node.parentElement?.closest(SCRIPT_CONTENT_SELECTOR))
}

const cloneWithoutScriptContent = (element: Element): Element => {
  const clone = element.cloneNode(true) as Element
  clone.querySelectorAll(SCRIPT_CONTENT_SELECTOR).forEach((child) => child.remove())
  return clone
}

const nodeText = (node: Node, stripScriptContent: boolean): string => {
  if (!stripScriptContent) return node.textContent ?? ''
  if (isScriptContentNode(node)) return ''
  if (node.nodeType === node.ELEMENT_NODE) {
    return cloneWithoutScriptContent(node as Element).textContent ?? ''
  }
  return node.textContent ?? ''
}

const nodeHtml = (node: Node, stripScriptContent: boolean): string => {
  if (stripScriptContent && isScriptContentNode(node)) return ''
  if (node.nodeType === node.ELEMENT_NODE) {
    const element = node as Element
    return stripScriptContent ? cloneWithoutScriptContent(element).innerHTML : element.innerHTML
  }
  return nodeText(node, stripScriptContent)
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
  const matches = selectNodes(root, mapping.selectorType, mapping.selector)
  const selected = mapping.matchMode === 'all' ? matches : matches.slice(0, 1)
  const values = selected.map((node) => {
    if (mapping.extraction === 'html') return nodeHtml(node, stripScriptContent)
    if (mapping.extraction === 'attribute') return nodeAttribute(node, mapping.attribute)
    return nodeText(node, stripScriptContent)
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
