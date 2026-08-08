import type {
  AppSettings,
  FieldMapping,
  ResourceCounters,
  RunCounters,
  TaskConfig,
  XmlFieldDefinition
} from './types'
import {
  createPageExtractionConfig,
  isFieldMappingConfigured,
  normalizeFieldMappingConfig
} from './field-mapping'
import { analyzeTaskListPageRules, taskListPageRuleLines } from './list-page-rules'
import {
  isValidResourceUrlPrefix,
  normalizeResourceAddressMode,
  normalizeResourceUrlPrefix
} from './resource-config'

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const createEmptyCounters = (): RunCounters => ({
  discovered: 0,
  succeeded: 0,
  duplicated: 0,
  skipped: 0,
  failed: 0
})

export const createEmptyResourceCounters = (): ResourceCounters => ({
  downloaded: 0,
  skipped: 0,
  failed: 0
})

export const createFieldMapping = (field: XmlFieldDefinition): FieldMapping => ({
  fieldPath: field.path,
  mode: 'unconfigured',
  ...createPageExtractionConfig(),
  required: false,
  fixedValue: '',
  systemValue: 'collected-at',
  mergeSeparator: '',
  mergeValues: []
})

export const createTask = (id: string, now = new Date().toISOString()): TaskConfig => ({
  version: 1,
  id,
  name: '未命名任务',
  listUrl: '',
  listPageRules: [],
  listItem: {
    selectorType: 'css',
    selector: ''
  },
  detail: {
    enabled: true,
    link: {
      selectorType: 'css',
      selector: ''
    },
    linkAttribute: 'href'
  },
  pagination: {
    mode: 'url',
    urlTemplate: '',
    startPage: 1,
    step: 1,
    maxPages: 100,
    nextButton: {
      selectorType: 'css',
      selector: ''
    }
  },
  request: {
    userAgent: DEFAULT_USER_AGENT,
    headers: [],
    timeoutSeconds: 30,
    delayMs: 300,
    detailConcurrency: 3,
    manualEncoding: ''
  },
  html: {
    cleanHtml: true,
    absolutizeResources: true,
    customResourceAttributes: []
  },
  resources: {
    addressMode: 'absolute-replace',
    urlPrefix: '',
    download: {
      enabled: false,
      rootDirectory: '',
      urlPrefix: ''
    }
  },
  resourceReplacements: [],
  output: {
    rootDirectory: '',
    recordsPerFile: 200,
    overwrite: true
  },
  xml: null,
  dedupeFieldPath: '',
  createdAt: now,
  updatedAt: now
})

export const DEFAULT_SETTINGS: AppSettings = {
  defaultOutputDirectory: ''
}

export const normalizeTaskConfig = (task: TaskConfig): TaskConfig => {
  const pagination = {
    ...task.pagination,
    mode: task.pagination?.mode ?? 'url',
    urlTemplate: task.pagination?.urlTemplate ?? '',
    startPage: task.pagination?.startPage ?? 1,
    step: task.pagination?.step ?? 1,
    maxPages: task.pagination?.maxPages ?? 100,
    nextButton: {
      selectorType: task.pagination?.nextButton?.selectorType ?? 'css',
      selector: task.pagination?.nextButton?.selector ?? ''
    }
  }
  const lines = taskListPageRuleLines({ ...task, pagination })
  const analysis = analyzeTaskListPageRules({ ...task, pagination, listPageRules: lines })
  const xml = task.xml
    ? {
        ...task.xml,
        mappings: task.xml.mappings.map(normalizeFieldMappingConfig)
      }
    : null
  const resources = {
    addressMode: normalizeResourceAddressMode(task.resources?.addressMode),
    urlPrefix: normalizeResourceUrlPrefix(task.resources?.urlPrefix ?? ''),
    download: {
      enabled: Boolean(task.resources?.download?.enabled),
      rootDirectory: task.resources?.download?.rootDirectory?.trim() ?? '',
      urlPrefix: normalizeResourceUrlPrefix(task.resources?.download?.urlPrefix ?? '')
    }
  }
  return {
    ...task,
    listUrl: analysis.firstUrl || task.listUrl.trim(),
    listPageRules: lines,
    pagination: {
      ...pagination,
      urlTemplate: analysis.templateRule?.template ?? ''
    },
    html: {
      cleanHtml: task.html?.cleanHtml ?? true,
      absolutizeResources: task.html?.absolutizeResources ?? true,
      customResourceAttributes: task.html?.customResourceAttributes ?? []
    },
    resources,
    resourceReplacements: task.resourceReplacements ?? [],
    xml
  }
}

export const isTaskRunnable = (task: TaskConfig): boolean => {
  const listPages = analyzeTaskListPageRules(task)
  if (!task.name.trim() || !task.listItem.selector.trim()) return false
  if (listPages.errors.length > 0 || listPages.rules.length === 0) return false
  if (task.pagination.mode === 'click' && !task.pagination.nextButton.selector.trim()) return false
  if (!task.output.rootDirectory.trim() || !task.xml?.recordPath) return false
  if (task.resources.download.enabled) {
    if (!task.resources.download.rootDirectory.trim()) return false
    if (!isValidResourceUrlPrefix(task.resources.download.urlPrefix)) return false
  } else if (
    task.resources.addressMode === 'prefix' &&
    !isValidResourceUrlPrefix(task.resources.urlPrefix)
  ) {
    return false
  }
  if (task.detail.enabled && !task.detail.link.selector.trim()) return false
  if (
    !task.detail.enabled &&
    (!task.dedupeFieldPath.trim() ||
      !task.xml.fields.some((field) => field.path === task.dedupeFieldPath))
  ) {
    return false
  }
  if (
    !Number.isInteger(task.output.recordsPerFile) ||
    task.output.recordsPerFile < 1 ||
    task.output.recordsPerFile > 200
  ) {
    return false
  }
  if (task.request.timeoutSeconds < 5 || task.request.timeoutSeconds > 120) return false
  if (
    !Number.isInteger(task.request.detailConcurrency) ||
    task.request.detailConcurrency < 1 ||
    task.request.detailConcurrency > 5
  ) {
    return false
  }
  if (!Number.isFinite(task.request.delayMs) || task.request.delayMs < 0) return false
  return task.xml.fields.every((field) => {
    const mapping = task.xml?.mappings.find((candidate) => candidate.fieldPath === field.path)
    return Boolean(mapping && isFieldMappingConfigured(mapping))
  })
}
