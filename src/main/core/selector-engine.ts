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

const nodeText = (node: Node): string => node.textContent ?? ''

const nodeHtml = (node: Node): string => {
  if (node.nodeType === node.ELEMENT_NODE) return (node as Element).innerHTML
  return nodeText(node)
}

const nodeAttribute = (node: Node, attribute: string): string => {
  if (node.nodeType === node.ATTRIBUTE_NODE) return node.nodeValue ?? ''
  if (node.nodeType === node.ELEMENT_NODE) {
    return (node as Element).getAttribute(attribute) ?? ''
  }
  return ''
}

export const extractRawValue = (root: QueryRoot, mapping: PageExtractionConfig): string => {
  const matches = selectNodes(root, mapping.selectorType, mapping.selector)
  const selected = mapping.matchMode === 'all' ? matches : matches.slice(0, 1)
  const values = selected.map((node) => {
    if (mapping.extraction === 'html') return nodeHtml(node)
    if (mapping.extraction === 'attribute') return nodeAttribute(node, mapping.attribute)
    return nodeText(node)
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
