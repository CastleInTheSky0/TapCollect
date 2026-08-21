import type {
  FieldMapping,
  MergeValueConfig,
  MergeValueMode,
  PageExtractionConfig
} from './types'
import { normalizeContentFilterSelectors } from './content-filter'

const MERGE_VALUE_MODES = new Set<MergeValueMode>([
  'page',
  'fixed',
  'system',
  'external-url'
])

export const createPageExtractionConfig = (): PageExtractionConfig => ({
  pageSource: 'list',
  selectorType: 'css',
  selector: '',
  extraction: 'text',
  attribute: '',
  matchMode: 'first',
  separator: ',',
  trim: true,
  collapseWhitespace: false,
  contentFilterSelectors: [],
  replacements: [],
  convertToTimestamp: false
})

export const createMergeValue = (id: string): MergeValueConfig => ({
  id,
  mode: 'page',
  ...createPageExtractionConfig(),
  fixedValue: '',
  systemValue: 'collected-at'
})

export const normalizeMergeValueConfig = (
  value: Partial<MergeValueConfig>,
  fallbackId: string
): MergeValueConfig => {
  const defaults = createMergeValue(fallbackId)
  const mode = MERGE_VALUE_MODES.has(value.mode as MergeValueMode)
    ? (value.mode as MergeValueMode)
    : defaults.mode
  return {
    ...defaults,
    ...value,
    id: value.id?.trim() || fallbackId,
    mode,
    contentFilterSelectors: normalizeContentFilterSelectors(value.contentFilterSelectors),
    replacements: Array.isArray(value.replacements) ? value.replacements : [],
    convertToTimestamp: Boolean(value.convertToTimestamp)
  }
}

export const normalizeFieldMappingConfig = (mapping: FieldMapping): FieldMapping => ({
  ...createPageExtractionConfig(),
  ...mapping,
  required: mapping.required ?? false,
  contentFilterSelectors: normalizeContentFilterSelectors(mapping.contentFilterSelectors),
  replacements: Array.isArray(mapping.replacements) ? mapping.replacements : [],
  convertToTimestamp: Boolean(mapping.convertToTimestamp),
  fixedValue: mapping.fixedValue ?? '',
  systemValue: mapping.systemValue ?? 'collected-at',
  mergeSeparator: mapping.mergeSeparator ?? '',
  mergeValues: Array.isArray(mapping.mergeValues)
    ? mapping.mergeValues.map((value, index) =>
        normalizeMergeValueConfig(value, `${mapping.fieldPath}-merge-${index + 1}`)
      )
    : []
})

export const mergePageValueKey = (fieldPath: string, valueId: string): string =>
  `__merge_value__:${fieldPath}:${valueId}`

export const isFieldMappingConfigured = (mapping: FieldMapping): boolean => {
  if (mapping.mode === 'unconfigured') return false
  if (mapping.mode === 'page') return Boolean(mapping.selector.trim())
  if (mapping.mode !== 'merge') return true
  return (
    mapping.mergeValues.length > 0 &&
    mapping.mergeValues.every(
      (value) => value.mode !== 'page' || Boolean(value.selector.trim())
    )
  )
}
