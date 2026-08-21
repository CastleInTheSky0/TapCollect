import type {
  FieldMapping,
  MergeValueConfig,
  MergeValueMode,
  PageExtractionConfig,
  PageLocatorType
} from './types'
import { normalizeContentFilterSelectors } from './content-filter'
import { normalizeTextPrefix } from './text-prefix'

const MERGE_VALUE_MODES = new Set<MergeValueMode>([
  'page',
  'fixed',
  'system',
  'external-url'
])

const PAGE_LOCATOR_TYPES = new Set<PageLocatorType>(['css', 'xpath', 'markers'])

const normalizePageLocatorType = (value: unknown): PageLocatorType =>
  PAGE_LOCATOR_TYPES.has(value as PageLocatorType) ? (value as PageLocatorType) : 'css'

const normalizeMarkerExtraction = (
  selectorType: PageLocatorType,
  extraction: PageExtractionConfig['extraction']
): PageExtractionConfig['extraction'] =>
  selectorType === 'markers' && extraction === 'attribute' ? 'html' : extraction

export const createPageExtractionConfig = (): PageExtractionConfig => ({
  pageSource: 'list',
  selectorType: 'css',
  selector: '',
  startMarker: '',
  endMarker: '',
  includeMarkers: false,
  textPrefix: '',
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
  const selectorType = normalizePageLocatorType(value.selectorType)
  return {
    ...defaults,
    ...value,
    id: value.id?.trim() || fallbackId,
    mode,
    selectorType,
    extraction: normalizeMarkerExtraction(selectorType, value.extraction ?? defaults.extraction),
    startMarker: typeof value.startMarker === 'string' ? value.startMarker : '',
    endMarker: typeof value.endMarker === 'string' ? value.endMarker : '',
    includeMarkers: Boolean(value.includeMarkers),
    textPrefix: normalizeTextPrefix(value.textPrefix),
    contentFilterSelectors: normalizeContentFilterSelectors(value.contentFilterSelectors),
    replacements: Array.isArray(value.replacements) ? value.replacements : [],
    convertToTimestamp: Boolean(value.convertToTimestamp)
  }
}

export const normalizeFieldMappingConfig = (mapping: FieldMapping): FieldMapping => {
  const defaults = createPageExtractionConfig()
  const selectorType = normalizePageLocatorType(mapping.selectorType)
  return {
    ...defaults,
    ...mapping,
    required: mapping.required ?? false,
    selectorType,
    extraction: normalizeMarkerExtraction(selectorType, mapping.extraction ?? defaults.extraction),
    startMarker: typeof mapping.startMarker === 'string' ? mapping.startMarker : '',
    endMarker: typeof mapping.endMarker === 'string' ? mapping.endMarker : '',
    includeMarkers: Boolean(mapping.includeMarkers),
    textPrefix: normalizeTextPrefix(mapping.textPrefix),
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
  }
}

export const mergePageValueKey = (fieldPath: string, valueId: string): string =>
  `__merge_value__:${fieldPath}:${valueId}`

export const isPageExtractionConfigured = (config: PageExtractionConfig): boolean =>
  config.selectorType === 'markers'
    ? Boolean(config.startMarker.length && config.endMarker.length)
    : Boolean(config.selector.trim())

export const isFieldMappingConfigured = (mapping: FieldMapping): boolean => {
  if (mapping.mode === 'unconfigured') return false
  if (mapping.mode === 'page') return isPageExtractionConfigured(mapping)
  if (mapping.mode !== 'merge') return true
  return (
    mapping.mergeValues.length > 0 &&
    mapping.mergeValues.every(
      (value) => value.mode !== 'page' || isPageExtractionConfigured(value)
    )
  )
}
