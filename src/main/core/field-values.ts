import { mergePageValueKey } from '@shared/field-mapping'
import { taskOutputMappings, taskOutputTemplate } from '@shared/output-template'
import {
  convertDateToTimestamp,
  timestampConversionFailureReason
} from '@shared/date-to-timestamp'
import type {
  ExtractedRecord,
  FieldMapping,
  MergeValueConfig,
  PageExtractionConfig,
  PageSource,
  TaskConfig,
  OutputFieldDefinition
} from '@shared/types'

export interface PageValueEntry {
  fieldPath: string
  valueKey: string
  matchKey: string
  mapping: PageExtractionConfig
}

export interface FieldValueWarning {
  fieldPath: string
  reason: string
}

export interface ResolvedFieldValue {
  value: string
  warnings: FieldValueWarning[]
}

export const pageValueEntries = (task: TaskConfig, source: PageSource): PageValueEntry[] => {
  const entries: PageValueEntry[] = []
  for (const mapping of taskOutputMappings(task)) {
    if (mapping.mode === 'page' && mapping.pageSource === source) {
      entries.push({
        fieldPath: mapping.fieldPath,
        valueKey: mapping.fieldPath,
        matchKey: mapping.fieldPath,
        mapping
      })
      continue
    }
    if (mapping.mode !== 'merge') continue
    mapping.mergeValues.forEach((value, index) => {
      if (value.mode !== 'page' || value.pageSource !== source) return
      entries.push({
        fieldPath: mapping.fieldPath,
        valueKey: mergePageValueKey(mapping.fieldPath, value.id),
        matchKey: `${mapping.fieldPath} / 合并项 ${index + 1}`,
        mapping: value
      })
    })
  }
  return entries
}

const systemValue = (value: FieldMapping['systemValue'], record: ExtractedRecord): string => {
  if (value === 'list-url') return record.listUrl
  if (value === 'detail-url') return record.detailUrl
  return record.collectedAt
}

const resolveSystemValue = (
  config: PageExtractionConfig,
  value: FieldMapping['systemValue'],
  record: ExtractedRecord,
  fieldPath: string
): ResolvedFieldValue => {
  const raw = systemValue(value, record)
  if (!config.convertToTimestamp || value !== 'collected-at') {
    return { value: raw, warnings: [] }
  }
  const converted = convertDateToTimestamp(raw)
  if (converted.ok) return { value: converted.value, warnings: [] }
  return {
    value: '',
    warnings: [
      {
        fieldPath,
        reason: timestampConversionFailureReason(raw, converted.reason)
      }
    ]
  }
}

const mergeValue = (
  mapping: FieldMapping,
  value: MergeValueConfig,
  record: ExtractedRecord,
  index: number
): ResolvedFieldValue => {
  if (value.mode === 'page') {
    return {
      value: record.values[mergePageValueKey(mapping.fieldPath, value.id)] ?? '',
      warnings: []
    }
  }
  if (value.mode === 'fixed') return { value: value.fixedValue, warnings: [] }
  if (value.mode === 'system') {
    return resolveSystemValue(
      value,
      value.systemValue,
      record,
      `${mapping.fieldPath} / 合并项 ${index + 1}`
    )
  }
  return { value: record.externalUrl, warnings: [] }
}

export const resolveFieldValueResult = (
  mapping: FieldMapping,
  definition: OutputFieldDefinition,
  record: ExtractedRecord
): ResolvedFieldValue => {
  if (mapping.mode === 'unconfigured') throw new Error(`字段 ${definition.path} 尚未配置`)
  if (mapping.mode === 'preserve') return { value: definition.sampleValue, warnings: [] }
  if (mapping.mode === 'empty') return { value: '', warnings: [] }
  if (mapping.mode === 'fixed') return { value: mapping.fixedValue, warnings: [] }
  if (mapping.mode === 'external-url') return { value: record.externalUrl, warnings: [] }
  if (mapping.mode === 'system') {
    return resolveSystemValue(mapping, mapping.systemValue, record, mapping.fieldPath)
  }
  if (mapping.mode === 'page') {
    return { value: record.values[definition.path] ?? '', warnings: [] }
  }
  const resolved = mapping.mergeValues.map((value, index) =>
    mergeValue(mapping, value, record, index)
  )
  return {
    value: resolved
      .map((item) => item.value)
      .filter((value) => value.length > 0)
      .join(mapping.mergeSeparator),
    warnings: resolved.flatMap((item) => item.warnings)
  }
}

export const resolveFieldValue = (
  mapping: FieldMapping,
  definition: OutputFieldDefinition,
  record: ExtractedRecord
): string => resolveFieldValueResult(mapping, definition, record).value

const ignoresExternalDetailRequirement = (
  mapping: FieldMapping,
  record: ExtractedRecord
): boolean =>
  Boolean(record.externalUrl) &&
  mapping.mergeValues.length > 0 &&
  mapping.mergeValues.every((value) => value.mode === 'page' && value.pageSource === 'detail')

export const missingRequiredMergeFields = (
  task: TaskConfig,
  record: ExtractedRecord
): string[] => {
  const template = taskOutputTemplate(task)
  if (!template) return []
  return template.mappings
    .filter((mapping) => mapping.mode === 'merge' && mapping.required)
    .filter((mapping) => !ignoresExternalDetailRequirement(mapping, record))
    .filter((mapping) => {
      const definition = template.fields.find((field) => field.path === mapping.fieldPath)
      return !definition || !resolveFieldValue(mapping, definition, record).trim()
    })
    .map((mapping) => mapping.fieldPath)
}
