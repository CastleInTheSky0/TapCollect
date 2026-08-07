import type {
  AppSettings,
  FieldMapping,
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
    urlTemplate: '',
    startPage: 1,
    step: 1,
    maxPages: 100
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
    urlTemplate: task.pagination?.urlTemplate ?? '',
    startPage: task.pagination?.startPage ?? 1,
    step: task.pagination?.step ?? 1,
    maxPages: task.pagination?.maxPages ?? 100
  }
  const lines = taskListPageRuleLines({ ...task, pagination })
  const analysis = analyzeTaskListPageRules({ ...task, pagination, listPageRules: lines })
  const xml = task.xml
    ? {
        ...task.xml,
        mappings: task.xml.mappings.map(normalizeFieldMappingConfig)
      }
    : null
  return {
    ...task,
    listUrl: analysis.firstUrl || task.listUrl.trim(),
    listPageRules: lines,
    pagination: {
      ...pagination,
      urlTemplate: analysis.templateRule?.template ?? ''
    },
    xml
  }
}

export const isTaskRunnable = (task: TaskConfig): boolean => {
  const listPages = analyzeTaskListPageRules(task)
  if (!task.name.trim() || !task.listItem.selector.trim()) return false
  if (listPages.errors.length > 0 || listPages.rules.length === 0) return false
  if (!task.output.rootDirectory.trim() || !task.xml?.recordPath) return false
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
