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
import {
  cleanTextValue,
  ContentFilterSelectorError,
  extractRawValue,
  selectMappingNodes,
  selectNodes
} from './selector-engine'
import { hasSameHostname, resolveHttpUrl } from './url-utils'
import { pageValueEntries } from './field-values'
import { taskOutputFields, taskOutputMappings } from '@shared/output-template'
import {
  convertDateToTimestamp,
  timestampConversionFailureReason
} from '@shared/date-to-timestamp'

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
  warnings: RecordFailure[]
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

interface ExtractedMappingValue extends ProcessedResourceValue {
  conversionError: string
}

const applyTimestampConversion = (
  processed: ProcessedResourceValue,
  mapping: PageExtractionConfig
): ExtractedMappingValue => {
  if (!mapping.convertToTimestamp) return { ...processed, conversionError: '' }
  const converted = convertDateToTimestamp(processed.value)
  if (converted.ok) return { ...processed, value: converted.value, conversionError: '' }
  return {
    value: '',
    resources: [],
    conversionError: timestampConversionFailureReason(processed.value, converted.reason)
  }
}

const extractMappingValue = (
  root: Document | Element,
  mapping: PageExtractionConfig,
  baseUrl: string,
  pageUrl: string,
  task: TaskConfig,
  fieldLabel: string
): ExtractedMappingValue => {
  let raw = ''
  try {
    raw = extractRawValue(root, mapping, task.html.cleanHtml)
  } catch (error) {
    if (error instanceof ContentFilterSelectorError) {
      throw new Error(`字段“${fieldLabel}”：${error.message}`)
    }
    throw error
  }
  if (mapping.extraction === 'html') {
    const processed = processHtmlWithResources(raw, baseUrl, pageUrl, task)
    const value = applyFieldCleanup(processed.value, mapping)
    return applyTimestampConversion(
      {
        value,
        resources: processed.resources.filter((plan) => value.includes(plan.xmlUrl))
      },
      mapping
    )
  }
  if (mapping.extraction === 'attribute') {
    if (!task.resources.download.enabled && task.resources.addressMode === 'absolute-replace') {
      return applyTimestampConversion(
        {
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
        },
        mapping
      )
    }
    const matches = selectMappingNodes(root, mapping)
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
    return applyTimestampConversion(
      {
        value,
        resources: processedValues
          .flatMap((processed) => processed.resources)
          .filter((plan) => value.includes(plan.xmlUrl))
      },
      mapping
    )
  }
  return applyTimestampConversion(
    { value: applyFieldCleanup(raw, mapping), resources: [] },
    mapping
  )
}

const extractDetailHref = (item: Element, task: TaskConfig): string => {
  const matches = selectNodes(item, task.detail.link.selectorType, task.detail.link.selector)
  let first = matches[0]
  if (!first && task.detail.link.selectorType === 'css') {
    const expression = task.detail.link.selector.trim()
    if (expression) {
      const closest = item.closest(expression)
      if (closest?.hasAttribute(task.detail.linkAttribute)) first = closest
    }
  }
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
    const conversionWarnings: Array<{ fieldPath: string; reason: string }> = []
    for (const entry of entries) {
      matchCounts[entry.matchKey]?.push(selectMappingNodes(item, entry.mapping).length)
      const processed = extractMappingValue(
        item,
        entry.mapping,
        baseUrl,
        pageUrl,
        task,
        entry.matchKey
      )
      values[entry.valueKey] = processed.value
      resources.push(...processed.resources)
      if (processed.conversionError) {
        conversionWarnings.push({ fieldPath: entry.matchKey, reason: processed.conversionError })
      }
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

    const candidate = {
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
      missingListFields: missingRequiredFields(requiredMappings, values),
      warnings: [] as RecordFailure[]
    }
    candidate.warnings = conversionWarnings.map((warning) =>
      createRecordFailure(candidate, 'date-conversion', warning.reason, warning.fieldPath)
    )
    return candidate
  })

  return { candidates, itemCount: items.length, matchCounts }
}

export const extractDetailPage = (
  task: TaskConfig,
  candidate: ListCandidate,
  html: string,
  pageUrl: string
): {
  record: ExtractedRecord
  missingFields: string[]
  matchCounts: Record<string, number>
  warnings: RecordFailure[]
} => {
  const dom = new JSDOM(html, { url: pageUrl })
  const { document } = dom.window
  const baseUrl = document.baseURI || pageUrl
  const entries = pageValueEntries(task, 'detail')
  const requiredMappings = requiredPageMappings(task, 'detail')
  const values = { ...candidate.values }
  const resources = [...candidate.resources]
  const matchCounts: Record<string, number> = {}
  const conversionWarnings: Array<{ fieldPath: string; reason: string }> = []
  for (const entry of entries) {
    matchCounts[entry.matchKey] = selectMappingNodes(document, entry.mapping).length
    const processed = extractMappingValue(
      document,
      entry.mapping,
      baseUrl,
      pageUrl,
      task,
      entry.matchKey
    )
    values[entry.valueKey] = processed.value
    resources.push(...processed.resources)
    if (processed.conversionError) {
      conversionWarnings.push({ fieldPath: entry.matchKey, reason: processed.conversionError })
    }
  }
  const warningContext = { ...candidate, detailUrl: pageUrl }
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
    matchCounts,
    warnings: conversionWarnings.map((warning) =>
      createRecordFailure(warningContext, 'date-conversion', warning.reason, warning.fieldPath)
    )
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
