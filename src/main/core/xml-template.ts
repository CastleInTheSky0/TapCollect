import {
  DOMParser,
  XMLSerializer,
  type Attr,
  type Document,
  type Element,
  type Node
} from '@xmldom/xmldom'
import formatXml from 'xml-formatter'
import type {
  ExtractedRecord,
  FieldMapping,
  XmlFieldDefinition,
  XmlTemplateConfig,
  XmlTreeNode
} from '@shared/types'
import { createFieldMapping } from '@shared/defaults'
import { resolveFieldValue } from './field-values'

const rejectDoctype = (content: string): void => {
  if (/<!DOCTYPE/i.test(content)) throw new Error('XML 模板不允许包含 DTD')
}

export const parseXml = (content: string): Document => {
  rejectDoctype(content)
  return new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') throw new Error(message)
    }
  }).parseFromString(content, 'application/xml')
}

const elementChildren = (element: Element): Element[] =>
  Array.from({ length: element.childNodes.length }, (_, index) => element.childNodes.item(index))
    .filter((node): node is Element => node !== null && node.nodeType === 1)

const attributeNodes = (element: Element): Attr[] =>
  Array.from({ length: element.attributes.length }, (_, index) => element.attributes.item(index))
    .filter((attribute): attribute is Attr => attribute !== null)

const buildTree = (element: Element, path: string): XmlTreeNode => ({
  path,
  name: element.nodeName,
  kind: 'element',
  children: [
    ...attributeNodes(element).map((attribute) => ({
      path: `${path}/@${attribute.name}`,
      name: `@${attribute.name}`,
      kind: 'attribute' as const,
      children: []
    })),
    ...elementChildren(element).map((child) => buildTree(child, `${path}/${child.nodeName}`))
  ]
})

export const inspectXmlTree = (content: string): XmlTreeNode[] => {
  const document = parseXml(content)
  const root = document.documentElement
  if (!root) throw new Error('XML 模板缺少根节点')
  return [buildTree(root, `/${root.nodeName}`)]
}

const findElementByAbsolutePath = (document: Document, path: string): Element | null => {
  const parts = path.split('/').filter(Boolean)
  const root = document.documentElement
  if (!root || parts.length === 0 || root.nodeName !== parts[0]) return null
  let current: Element = root
  for (const part of parts.slice(1)) {
    const next = elementChildren(current).find((child) => child.nodeName === part)
    if (!next) return null
    current = next
  }
  return current
}

const hasCdata = (element: Element): boolean =>
  Array.from({ length: element.childNodes.length }, (_, index) => element.childNodes.item(index)).some(
    (node) => node !== null && node.nodeType === 4
  )

const detectCdataElementNames = (content: string): Set<string> => {
  const names = new Set<string>()
  const pattern = /<([A-Za-z_][\w:.-]*)\b[^>]*>\s*<!\[CDATA\[/g
  for (const match of content.matchAll(pattern)) {
    if (match[1]) names.add(match[1])
  }
  return names
}

const collectFields = (
  record: Element,
  cdataElementNames: Set<string>,
  prefix = ''
): XmlFieldDefinition[] => {
  const fields: XmlFieldDefinition[] = []
  for (const attribute of attributeNodes(record)) {
    const path = prefix ? `${prefix}/@${attribute.name}` : `@${attribute.name}`
    fields.push({
      path,
      name: `@${attribute.name}`,
      kind: 'attribute',
      cdata: false,
      sampleValue: attribute.value
    })
  }

  for (const child of elementChildren(record)) {
    const path = prefix ? `${prefix}/${child.nodeName}` : child.nodeName
    const children = elementChildren(child)
    if (children.length === 0) {
      fields.push({
        path,
        name: child.nodeName,
        kind: 'element',
        cdata: hasCdata(child) || cdataElementNames.has(child.nodeName),
        sampleValue: child.textContent ?? ''
      })
    } else {
      fields.push(...collectFields(child, cdataElementNames, path))
    }
  }
  return fields
}

export const detectXmlEncoding = (content: string): string => {
  const match = content.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i)
  return match?.[1] ?? 'UTF-8'
}

export const configureXmlRecord = (
  content: string,
  fileName: string,
  recordPath: string,
  importedAt = new Date().toISOString()
): XmlTemplateConfig => {
  const document = parseXml(content)
  const record = findElementByAbsolutePath(document, recordPath)
  if (!record) throw new Error('未找到指定的 XML 记录节点')
  const fields = collectFields(record, detectCdataElementNames(content))
  if (fields.length === 0) throw new Error('记录节点下没有可映射字段')
  return {
    fileName,
    content,
    encoding: detectXmlEncoding(content),
    recordPath,
    fields,
    mappings: fields.map(createFieldMapping),
    importedAt
  }
}

const findRelativeTarget = (record: Element, path: string): Element | Attr | null => {
  const parts = path.split('/').filter(Boolean)
  let current = record
  for (const [index, part] of parts.entries()) {
    if (part.startsWith('@')) {
      if (index !== parts.length - 1) return null
      return current.getAttributeNode(part.slice(1))
    }
    const next = elementChildren(current).find((child) => child.nodeName === part)
    if (!next) return null
    current = next
  }
  return current
}

const clearChildren = (element: Element): void => {
  while (element.firstChild) element.removeChild(element.firstChild)
}

const appendCdata = (document: Document, element: Element, value: string): void => {
  clearChildren(element)
  const parts = value.split(']]>')
  parts.forEach((part, index) => {
    const suffix = index < parts.length - 1 ? ']]' : ''
    const prefix = index > 0 ? '>' : ''
    element.appendChild(document.createCDATASection(`${prefix}${part}${suffix}`))
  })
}

const setTargetValue = (
  document: Document,
  target: Element | Attr,
  value: string,
  definition: XmlFieldDefinition
): void => {
  if (target.nodeType === target.ATTRIBUTE_NODE) {
    target.value = value
    return
  }
  const element = target as Element
  if (definition.cdata) appendCdata(document, element, value)
  else {
    clearChildren(element)
    element.appendChild(document.createTextNode(value))
  }
}

const mappingValue = (
  mapping: FieldMapping,
  definition: XmlFieldDefinition,
  record: ExtractedRecord
): string | null => {
  if (mapping.mode === 'unconfigured') {
    throw new Error(`字段 ${definition.path} 尚未配置`)
  }
  if (mapping.mode === 'preserve') return null
  return resolveFieldValue(mapping, definition, record)
}

export const renderXmlBatch = (
  template: XmlTemplateConfig,
  records: ExtractedRecord[]
): string => {
  const document = parseXml(template.content)
  const sample = findElementByAbsolutePath(document, template.recordPath)
  if (!sample?.parentNode) throw new Error('XML 记录节点无效')
  const parent = sample.parentNode

  for (const record of records) {
    const clone = sample.cloneNode(true) as Element
    for (const definition of template.fields) {
      const mapping = template.mappings.find((candidate) => candidate.fieldPath === definition.path)
      if (!mapping) throw new Error(`字段 ${definition.path} 未配置`)
      const value = mappingValue(mapping, definition, record)
      if (value === null) continue
      const target = findRelativeTarget(clone, definition.path)
      if (!target) throw new Error(`XML 字段路径不存在：${definition.path}`)
      setTargetValue(document, target, value, definition)
    }
    parent.insertBefore(clone, sample)
  }
  parent.removeChild(sample)

  const serialized = new XMLSerializer().serializeToString(document)
  return formatXml(serialized, {
    indentation: '    ',
    lineSeparator: '\r\n',
    collapseContent: true,
    throwOnFailure: true,
    strictMode: true
  })
}

export const validateXmlOutput = (content: string): void => {
  parseXml(content)
}

export const findXmlRecordNode = (content: string, recordPath: string): Node | null =>
  findElementByAbsolutePath(parseXml(content), recordPath)
