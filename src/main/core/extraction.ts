import { JSDOM } from 'jsdom'
import type {
  ExtractedRecord,
  FieldMapping,
  PageExtractionConfig,
  RecordFailure,
  ResourcePlan,
  TaskConfig
} from '@shared/types'
import {
  processAttributeValue,
  processAttributeValueWithResources,
  processHtmlWithResources,
  type ProcessedResourceValue
} from './html-processing'
import { cleanTextValue, extractRawValue, selectNodes } from './selector-engine'
import { hasSameHostname, resolveHttpUrl } from './url-utils'
import { pageValueEntries } from './field-values'
import { taskOutputFields, taskOutputMappings } from '@shared/output-template'

export interface ListCandidate {
  sequence: number
  collectedAt: string
  page: number
  itemIndex: number
  listUrl: string
  detailRequestUrl: string
  detailUrl: string
  externalUrl: string
  values: Record<string, string>
  resources: ResourcePlan[]
  missingListFields: string[]
}

export interface ExtractListPageResult {
  candidates: ListCandidate[]
  itemCount: number
  matchCounts: Record<string, number[]>
}

const requiredPageMappings = (task: TaskConfig, source: 'list' | 'detail'): FieldMapping[] =>
  taskOutputMappings(task).filter(
    (mapping) => mapping.mode === 'page' && mapping.pageSource === source
  )

const applyFieldCleanup = (value: string, mapping: PageExtractionConfig): string => {
  if (mapping.extraction !== 'html') return cleanTextValue(value, mapping)
  let result = mapping.trim ? value.trim() : value
  for (const replacement of mapping.replacements) {
    if (replacement.from) result = result.split(replacement.from).join(replacement.to)
  }
  return result
}

const extractMappingValue = (
  root: Document | Element,
  mapping: PageExtractionConfig,
  baseUrl: string,
  pageUrl: string,
  task: TaskConfig
): ProcessedResourceValue => {
  const raw = extractRawValue(root, mapping, task.html.cleanHtml)
  if (mapping.extraction === 'html') {
    const processed = processHtmlWithResources(raw, baseUrl, pageUrl, task)
    const value = applyFieldCleanup(processed.value, mapping)
    return {
      value,
      resources: processed.resources.filter((plan) => value.includes(plan.xmlUrl))
    }
  }
  if (mapping.extraction === 'attribute') {
    if (!task.resources.download.enabled && task.resources.addressMode === 'absolute-replace') {
      return {
        value: applyFieldCleanup(
          processAttributeValue(
            raw,
            baseUrl,
            task.html.absolutizeResources,
            task.resourceReplacements
          ),
          mapping
        ),
        resources: []
      }
    }
    const matches = selectNodes(root, mapping.selectorType, mapping.selector)
    const selected = mapping.matchMode === 'all' ? matches : matches.slice(0, 1)
    const processedValues = selected.map((node) => {
      const element =
        node.nodeType === node.ATTRIBUTE_NODE
          ? (node as Attr).ownerElement
          : node.nodeType === node.ELEMENT_NODE
            ? (node as Element)
            : null
      const attributeName =
        node.nodeType === node.ATTRIBUTE_NODE ? node.nodeName : mapping.attribute
      const attributeValue =
        node.nodeType === node.ATTRIBUTE_NODE
          ? node.nodeValue ?? ''
          : element?.getAttribute(mapping.attribute) ?? ''
      return processAttributeValueWithResources(
        attributeValue,
        element,
        attributeName,
        baseUrl,
        pageUrl,
        task
      )
    })
    const value = applyFieldCleanup(
      processedValues.map((processed) => processed.value).join(mapping.separator),
      mapping
    )
    return {
      value,
      resources: processedValues
        .flatMap((processed) => processed.resources)
        .filter((plan) => value.includes(plan.xmlUrl))
    }
  }
  return { value: applyFieldCleanup(raw, mapping), resources: [] }
}

const extractDetailHref = (item: Element, task: TaskConfig): string => {
  const matches = selectNodes(item, task.detail.link.selectorType, task.detail.link.selector)
  const first = matches[0]
  if (!first) return ''
  if (first.nodeType === first.ATTRIBUTE_NODE) return first.nodeValue ?? ''
  if (first.nodeType === first.ELEMENT_NODE) {
    return (first as Element).getAttribute(task.detail.linkAttribute) ?? ''
  }
  return ''
}

const initialValues = (task: TaskConfig): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const field of taskOutputFields(task)) values[field.path] = ''
  return values
}

const missingRequiredFields = (
  mappings: FieldMapping[],
  values: Record<string, string>
): string[] =>
  mappings
    .filter((mapping) => mapping.required && !(values[mapping.fieldPath] ?? '').trim())
    .map((mapping) => mapping.fieldPath)

export const extractListPage = (
  task: TaskConfig,
  html: string,
  pageUrl: string,
  page: number,
  sequenceStart: number
): ExtractListPageResult => {
  const dom = new JSDOM(html, { url: pageUrl })
  const { document } = dom.window
  const baseUrl = document.baseURI || pageUrl
  const items = selectNodes(document, task.listItem.selectorType, task.listItem.selector).filter(
    (node): node is Element => node.nodeType === node.ELEMENT_NODE
  )
  const entries = pageValueEntries(task, 'list')
  const requiredMappings = requiredPageMappings(task, 'list')
  const matchCounts: Record<string, number[]> = Object.fromEntries(
    entries.map((entry) => [entry.matchKey, []])
  )

  const candidates = items.map((item, index): ListCandidate => {
    const values = initialValues(task)
    const resources: ResourcePlan[] = []
    for (const entry of entries) {
      matchCounts[entry.matchKey]?.push(
        selectNodes(item, entry.mapping.selectorType, entry.mapping.selector).length
      )
      const processed = extractMappingValue(item, entry.mapping, baseUrl, pageUrl, task)
      values[entry.valueKey] = processed.value
      resources.push(...processed.resources)
    }

    let detailRequestUrl = ''
    let detailUrl = ''
    let externalUrl = ''
    if (task.detail.enabled && task.detail.navigationMode === 'link') {
      const href = extractDetailHref(item, task)
      const resolved = resolveHttpUrl(href, baseUrl)
      if (resolved) {
        if (hasSameHostname(pageUrl, resolved)) {
          detailRequestUrl = resolved
          detailUrl = resolved
        } else {
          externalUrl = resolved
        }
      }
    }

    return {
      sequence: sequenceStart + index,
      collectedAt: new Date().toISOString(),
      page,
      itemIndex: index + 1,
      listUrl: pageUrl,
      detailRequestUrl,
      detailUrl,
      externalUrl,
      values,
      resources,
      missingListFields: missingRequiredFields(requiredMappings, values)
    }
  })

  return { candidates, itemCount: items.length, matchCounts }
}

export const extractDetailPage = (
  task: TaskConfig,
  candidate: ListCandidate,
  html: string,
  pageUrl: string
): { record: ExtractedRecord; missingFields: string[]; matchCounts: Record<string, number> } => {
  const dom = new JSDOM(html, { url: pageUrl })
  const { document } = dom.window
  const baseUrl = document.baseURI || pageUrl
  const entries = pageValueEntries(task, 'detail')
  const requiredMappings = requiredPageMappings(task, 'detail')
  const values = { ...candidate.values }
  const resources = [...candidate.resources]
  const matchCounts: Record<string, number> = {}
  for (const entry of entries) {
    matchCounts[entry.matchKey] = selectNodes(
      document,
      entry.mapping.selectorType,
      entry.mapping.selector
    ).length
    const processed = extractMappingValue(document, entry.mapping, baseUrl, pageUrl, task)
    values[entry.valueKey] = processed.value
    resources.push(...processed.resources)
  }
  return {
    record: {
      sequence: candidate.sequence,
      collectedAt: candidate.collectedAt,
      page: candidate.page,
      itemIndex: candidate.itemIndex,
      listUrl: candidate.listUrl,
      detailUrl: pageUrl,
      externalUrl: '',
      values,
      resources
    },
    missingFields: missingRequiredFields(requiredMappings, values),
    matchCounts
  }
}

export const candidateToRecord = (candidate: ListCandidate): ExtractedRecord => ({
  sequence: candidate.sequence,
  collectedAt: candidate.collectedAt,
  page: candidate.page,
  itemIndex: candidate.itemIndex,
  listUrl: candidate.listUrl,
  detailUrl: candidate.externalUrl ? '' : candidate.detailUrl,
  externalUrl: candidate.externalUrl,
  values: { ...candidate.values },
  resources: [...candidate.resources]
})

export const createRecordFailure = (
  candidate: Pick<ListCandidate, 'page' | 'itemIndex' | 'listUrl' | 'detailUrl'>,
  stage: string,
  reason: string,
  fieldPath = '',
  retries = 0
): RecordFailure => ({
  page: candidate.page,
  itemIndex: candidate.itemIndex,
  listUrl: candidate.listUrl,
  detailUrl: candidate.detailUrl,
  stage,
  fieldPath,
  reason,
  retries,
  time: new Date().toISOString()
})
