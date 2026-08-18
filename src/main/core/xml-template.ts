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

const repeatedFieldId = (
  element: Element,
  siblings: Element[],
  rejectInvalid = false
): string | null => {
  if (element.nodeName !== 'field') return null
  const sameNameSiblings = siblings.filter((sibling) => sibling.nodeName === element.nodeName)
  if (
    sameNameSiblings.length <= 1 ||
    !sameNameSiblings.every((sibling) => elementChildren(sibling).length === 0)
  ) {
    return null
  }
  const ids = sameNameSiblings.map((sibling) => sibling.getAttribute('id') ?? '')
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
    if (rejectInvalid) throw new Error('同名 field 节点必须具有非空且唯一的 id')
    return null
  }
  return element.getAttribute('id')
}

const elementPathSegment = (
  element: Element,
  siblings: Element[],
  rejectInvalid = false
): string => {
  const id = repeatedFieldId(element, siblings, rejectInvalid)
  return id === null ? element.nodeName : `field[@id="${encodeURIComponent(id)}"]`
}

const parseElementPathSegment = (
  segment: string
): { nodeName: string; id: string | null } | null => {
  const qualified = segment.match(/^([A-Za-z_][\w:.-]*)\[@id="([^"]+)"\]$/)
  if (!qualified) return segment.includes('[') ? null : { nodeName: segment, id: null }
  try {
    return { nodeName: qualified[1]!, id: decodeURIComponent(qualified[2]!) }
  } catch {
    return null
  }
}

const findElementChild = (parent: Element, segment: string): Element | null => {
  const parsed = parseElementPathSegment(segment)
  if (!parsed) return null
  return (
    elementChildren(parent).find(
      (child) =>
        child.nodeName === parsed.nodeName &&
        (parsed.id === null || child.getAttribute('id') === parsed.id)
    ) ?? null
  )
}

const buildTree = (element: Element, path: string, displayName = element.nodeName): XmlTreeNode => {
  const children = elementChildren(element)
  return {
    path,
    name: displayName,
    kind: 'element',
    children: [
      ...attributeNodes(element).map((attribute) => ({
        path: `${path}/@${attribute.name}`,
        name: `@${attribute.name}`,
        kind: 'attribute' as const,
        children: []
      })),
      ...children.map((child) => {
        const id = repeatedFieldId(child, children)
        return buildTree(
          child,
          `${path}/${elementPathSegment(child, children)}`,
          id ?? child.nodeName
        )
      })
    ]
  }
}

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
    const next = findElementChild(current, part)
    if (!next) return null
    current = next
  }
  return current
}

const hasCdata = (element: Element): boolean =>
  Array.from({ length: element.childNodes.length }, (_, index) => element.childNodes.item(index)).some(
    (node) => node !== null && node.nodeType === 4
  )

const cdataDetectionDocument = (content: string): Document =>
  parseXml(content.replaceAll('<![CDATA[', '<![CDATA[__tapcollect_cdata__'))

const collectFields = (
  record: Element,
  cdataRecord: Element,
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

  const children = elementChildren(record)
  const cdataChildren = elementChildren(cdataRecord)
  for (const [index, child] of children.entries()) {
    const segment = elementPathSegment(child, children, true)
    const path = prefix ? `${prefix}/${segment}` : segment
    const grandchildren = elementChildren(child)
    if (grandchildren.length === 0) {
      const id = repeatedFieldId(child, children, true)
      const label = id === null ? '' : (child.getAttribute('name') ?? '').trim()
      fields.push({
        path,
        name: id ?? child.nodeName,
        kind: 'element',
        cdata: hasCdata(cdataChildren[index] ?? child),
        ...(label ? { label } : {}),
        sampleValue: child.textContent ?? ''
      })
    } else {
      fields.push(...collectFields(child, cdataChildren[index] ?? child, path))
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
  const detectionRecord = findElementByAbsolutePath(cdataDetectionDocument(content), recordPath)
  if (!detectionRecord) throw new Error('无法读取 XML 模板的 CDATA 结构')
  const fields = collectFields(record, detectionRecord)
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
    const next = findElementChild(current, part)
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
