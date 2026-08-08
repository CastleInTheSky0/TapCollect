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

export const taskConfigurationIssues = (task: TaskConfig): string[] => {
  const issues: string[] = []
  const listPages = analyzeTaskListPageRules(task)

  if (!task.name.trim()) issues.push('请填写任务名称')
  if (listPages.errors.length > 0) {
    issues.push(...listPages.errors.map((error) => `列表页面 URL/分页：${error}`))
  } else if (listPages.rules.length === 0) {
    issues.push('请至少填写一个列表页面 URL')
  }
  if (!task.listItem.selector.trim()) issues.push('请配置列表项范围选择器')
  if (task.pagination.mode === 'click' && !task.pagination.nextButton.selector.trim()) {
    issues.push('请配置动态分页的“下一页按钮”选择器')
  }
  if (task.detail.enabled && !task.detail.link.selector.trim()) {
    issues.push('请配置详情链接选择器')
  }
  if (!task.detail.enabled) {
    if (!task.dedupeFieldPath.trim()) {
      issues.push('关闭详情采集后，请选择去重字段')
    } else if (
      task.xml &&
      !task.xml.fields.some((field) => field.path === task.dedupeFieldPath)
    ) {
      issues.push(`去重字段“${task.dedupeFieldPath}”不在当前 XML 模板中，请重新选择`)
    }
  }

  if (!task.xml) {
    issues.push('请导入 XML 模板')
  } else {
    if (!task.xml.recordPath.trim()) issues.push('请在 XML 模板中选择记录节点')
    const unresolvedFieldPaths = task.xml.fields
      .filter((field) => {
        const mapping = task.xml?.mappings.find(
          (candidate) => candidate.fieldPath === field.path
        )
        return !mapping || !isFieldMappingConfigured(mapping)
      })
      .map((field) => field.path)
    if (unresolvedFieldPaths.length > 0) {
      issues.push(`请完成 XML 字段映射：${unresolvedFieldPaths.join('、')}`)
    }
  }

  if (!task.output.rootDirectory.trim()) issues.push('请选择采集输出目录')
  if (
    !Number.isInteger(task.output.recordsPerFile) ||
    task.output.recordsPerFile < 1 ||
    task.output.recordsPerFile > 200
  ) {
    issues.push('每个 XML 文件的记录数必须是 1–200 的整数')
  }

  if (task.resources.download.enabled) {
    if (!task.resources.download.rootDirectory.trim()) issues.push('请选择资源下载目录')
    if (!isValidResourceUrlPrefix(task.resources.download.urlPrefix)) {
      issues.push('请填写有效的资源下载替换前缀（/路径或 HTTP/HTTPS 地址）')
    }
  } else if (
    task.resources.addressMode === 'prefix' &&
    !isValidResourceUrlPrefix(task.resources.urlPrefix)
  ) {
    issues.push('请填写有效的自定义资源路径前缀（/路径或 HTTP/HTTPS 地址）')
  }

  if (
    !Number.isFinite(task.request.timeoutSeconds) ||
    task.request.timeoutSeconds < 5 ||
    task.request.timeoutSeconds > 120
  ) {
    issues.push('请求超时时间必须在 5–120 秒之间')
  }
  if (
    !Number.isInteger(task.request.detailConcurrency) ||
    task.request.detailConcurrency < 1 ||
    task.request.detailConcurrency > 5
  ) {
    issues.push('详情并发数必须是 1–5 的整数')
  }
  if (!Number.isFinite(task.request.delayMs) || task.request.delayMs < 0) {
    issues.push('请求间隔必须是大于或等于 0 的数值')
  }

  return issues
}

export const isTaskRunnable = (task: TaskConfig): boolean =>
  taskConfigurationIssues(task).length === 0
