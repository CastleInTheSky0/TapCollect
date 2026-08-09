import { mergePageValueKey } from '@shared/field-mapping'
import { taskOutputMappings, taskOutputTemplate } from '@shared/output-template'
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

const mergeValue = (
  mapping: FieldMapping,
  value: MergeValueConfig,
  record: ExtractedRecord
): string => {
  if (value.mode === 'page') {
    return record.values[mergePageValueKey(mapping.fieldPath, value.id)] ?? ''
  }
  if (value.mode === 'fixed') return value.fixedValue
  if (value.mode === 'system') return systemValue(value.systemValue, record)
  return record.externalUrl
}

export const resolveFieldValue = (
  mapping: FieldMapping,
  definition: OutputFieldDefinition,
  record: ExtractedRecord
): string => {
  if (mapping.mode === 'unconfigured') throw new Error(`字段 ${definition.path} 尚未配置`)
  if (mapping.mode === 'preserve') return definition.sampleValue
  if (mapping.mode === 'empty') return ''
  if (mapping.mode === 'fixed') return mapping.fixedValue
  if (mapping.mode === 'external-url') return record.externalUrl
  if (mapping.mode === 'system') return systemValue(mapping.systemValue, record)
  if (mapping.mode === 'page') return record.values[definition.path] ?? ''
  return mapping.mergeValues
    .map((value) => mergeValue(mapping, value, record))
    .filter((value) => value.length > 0)
    .join(mapping.mergeSeparator)
}

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
