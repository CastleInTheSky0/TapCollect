import { normalizeTaskConfig } from './defaults'
import type { TaskConfig, TaskConfigBundle } from './types'

export const TASK_CONFIG_BUNDLE_FORMAT = 'tapcollect-task-bundle' as const
export const TASK_CONFIG_BUNDLE_VERSION = 1 as const

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown, label: string): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象`)
  }
  return value as JsonRecord
}

const requireRecord = (record: JsonRecord, key: string, label: string): JsonRecord =>
  asRecord(record[key], `${label}.${key}`)

const requireString = (record: JsonRecord, key: string, label: string): void => {
  if (typeof record[key] !== 'string') throw new Error(`${label}.${key} 必须是字符串`)
}

const requireNumber = (record: JsonRecord, key: string, label: string): void => {
  if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    throw new Error(`${label}.${key} 必须是有效数字`)
  }
}

const requireBoolean = (record: JsonRecord, key: string, label: string): void => {
  if (typeof record[key] !== 'boolean') throw new Error(`${label}.${key} 必须是布尔值`)
}

const requireArray = (record: JsonRecord, key: string, label: string): unknown[] => {
  if (!Array.isArray(record[key])) throw new Error(`${label}.${key} 必须是数组`)
  return record[key]
}

const requireStringArray = (record: JsonRecord, key: string, label: string): void => {
  const values = requireArray(record, key, label)
  if (values.some((value) => typeof value !== 'string')) {
    throw new Error(`${label}.${key} 只能包含字符串`)
  }
}

const validateSelector = (value: unknown, label: string): void => {
  const selector = asRecord(value, label)
  requireString(selector, 'selectorType', label)
  requireString(selector, 'selector', label)
}

const validateObjectArray = (values: unknown[], label: string): void => {
  values.forEach((value, index) => asRecord(value, `${label}[${index}]`))
}

const validateTemplate = (value: unknown, label: string, spreadsheet: boolean): void => {
  if (value === null || value === undefined) return
  const template = asRecord(value, label)
  requireString(template, 'fileName', label)
  requireString(template, spreadsheet ? 'contentBase64' : 'content', label)
  requireString(template, 'importedAt', label)
  validateObjectArray(requireArray(template, 'fields', label), `${label}.fields`)
  validateObjectArray(requireArray(template, 'mappings', label), `${label}.mappings`)
}

const validateTaskConfigShape = (value: unknown): JsonRecord => {
  const task = asRecord(value, '任务配置')
  if (task.version !== TASK_CONFIG_BUNDLE_VERSION) {
    throw new Error('任务配置 version 必须为 1')
  }
  requireString(task, 'name', '任务配置')
  requireString(task, 'listUrl', '任务配置')
  if (task.listPageRules !== undefined) {
    requireStringArray(task, 'listPageRules', '任务配置')
  }

  validateSelector(requireRecord(task, 'listItem', '任务配置'), '任务配置.listItem')

  const detail = requireRecord(task, 'detail', '任务配置')
  requireBoolean(detail, 'enabled', '任务配置.detail')
  if (detail.navigationMode !== undefined) {
    requireString(detail, 'navigationMode', '任务配置.detail')
    if (!['link', 'click'].includes(detail.navigationMode as string)) {
      throw new Error('任务配置.detail.navigationMode 只能是 link 或 click')
    }
  }
  validateSelector(detail.link, '任务配置.detail.link')
  requireString(detail, 'linkAttribute', '任务配置.detail')

  const pagination = requireRecord(task, 'pagination', '任务配置')
  requireNumber(pagination, 'startPage', '任务配置.pagination')
  if (pagination.step !== undefined) requireNumber(pagination, 'step', '任务配置.pagination')
  requireNumber(pagination, 'maxPages', '任务配置.pagination')
  if (pagination.nextButton !== undefined) {
    validateSelector(pagination.nextButton, '任务配置.pagination.nextButton')
  }

  const request = requireRecord(task, 'request', '任务配置')
  requireString(request, 'userAgent', '任务配置.request')
  requireNumber(request, 'timeoutSeconds', '任务配置.request')
  requireNumber(request, 'delayMs', '任务配置.request')
  requireNumber(request, 'detailConcurrency', '任务配置.request')
  const headers = requireArray(request, 'headers', '任务配置.request')
  headers.forEach((value, index) => {
    const header = asRecord(value, `任务配置.request.headers[${index}]`)
    requireString(header, 'id', `任务配置.request.headers[${index}]`)
    requireString(header, 'key', `任务配置.request.headers[${index}]`)
    requireString(header, 'value', `任务配置.request.headers[${index}]`)
  })

  const html = requireRecord(task, 'html', '任务配置')
  requireBoolean(html, 'cleanHtml', '任务配置.html')
  requireBoolean(html, 'absolutizeResources', '任务配置.html')
  if (html.customResourceAttributes !== undefined) {
    requireStringArray(html, 'customResourceAttributes', '任务配置.html')
  }

  if (task.resources !== undefined) {
    const resources = requireRecord(task, 'resources', '任务配置')
    requireString(resources, 'addressMode', '任务配置.resources')
    requireString(resources, 'urlPrefix', '任务配置.resources')
    if (resources.encodeUrls !== undefined) {
      requireBoolean(resources, 'encodeUrls', '任务配置.resources')
    }
    const download = requireRecord(resources, 'download', '任务配置.resources')
    requireBoolean(download, 'enabled', '任务配置.resources.download')
    requireString(download, 'rootDirectory', '任务配置.resources.download')
    requireString(download, 'urlPrefix', '任务配置.resources.download')
  }

  if (task.resourceReplacements !== undefined) {
    validateObjectArray(
      requireArray(task, 'resourceReplacements', '任务配置'),
      '任务配置.resourceReplacements'
    )
  }

  const output = requireRecord(task, 'output', '任务配置')
  requireString(output, 'rootDirectory', '任务配置.output')
  requireNumber(output, 'recordsPerFile', '任务配置.output')
  requireBoolean(output, 'overwrite', '任务配置.output')

  validateTemplate(task.xml, '任务配置.xml', false)
  validateTemplate(task.spreadsheet, '任务配置.spreadsheet', true)
  if (task.dedupeFieldPath !== undefined) requireString(task, 'dedupeFieldPath', '任务配置')
  return task
}

export const createTaskConfigBundle = (
  tasks: TaskConfig[],
  exportedAt = new Date().toISOString()
): TaskConfigBundle => ({
  format: TASK_CONFIG_BUNDLE_FORMAT,
  version: TASK_CONFIG_BUNDLE_VERSION,
  exportedAt,
  tasks: JSON.parse(JSON.stringify(tasks)) as TaskConfig[]
})

export const parseTaskConfigBundle = (value: unknown): unknown[] => {
  const bundle = asRecord(value, '任务配置文件')
  if (bundle.format !== TASK_CONFIG_BUNDLE_FORMAT) {
    throw new Error(`不是 TapCollect 任务配置文件（format 应为 ${TASK_CONFIG_BUNDLE_FORMAT}）`)
  }
  if (bundle.version !== TASK_CONFIG_BUNDLE_VERSION) {
    throw new Error(`不支持任务配置文件版本：${String(bundle.version ?? '')}`)
  }
  const tasks = requireArray(bundle, 'tasks', '任务配置文件')
  if (tasks.length === 0) throw new Error('任务配置文件中没有可导入的任务')
  return tasks
}

export const importedTaskCandidateName = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '无法识别的任务'
  const name = (value as JsonRecord).name
  return typeof name === 'string' && name.trim() ? name.trim() : '未命名任务'
}

export const prepareImportedTaskConfig = (
  value: unknown,
  id: string,
  now = new Date().toISOString()
): TaskConfig => {
  const source = validateTaskConfigShape(value)
  const task = normalizeTaskConfig(
    JSON.parse(
      JSON.stringify({
        ...source,
        version: 1,
        id,
        createdAt: now,
        updatedAt: now
      })
    ) as TaskConfig
  )
  return { ...task, id, createdAt: now, updatedAt: now }
}
