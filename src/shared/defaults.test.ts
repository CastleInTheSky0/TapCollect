import { describe, expect, it } from 'vitest'
import {
  createFieldMapping,
  createTask,
  isTaskRunnable,
  normalizeTaskConfig,
  taskConfigurationIssues
} from './defaults'
import type { SpreadsheetFieldDefinition, TaskConfig, XmlFieldDefinition } from './types'

const fields: XmlFieldDefinition[] = [
  {
    path: 'title',
    name: 'title',
    kind: 'element',
    cdata: false,
    sampleValue: ''
  },
  {
    path: 'text',
    name: 'text',
    kind: 'element',
    cdata: true,
    sampleValue: ''
  }
]

const createRunnableTask = (): TaskConfig => {
  const task = createTask('runnable-task')
  task.name = '完整任务'
  task.listPageRules = ['https://www.example.com/list.html']
  task.listItem.selector = '.list-item'
  task.detail.link.selector = 'a[href]'
  task.output.rootDirectory = 'D:/output'
  task.xml = {
    fileName: 'sample.xml',
    content: '<root><item><title/><text/></item></root>',
    encoding: 'UTF-8',
    recordPath: '/root/item',
    fields,
    mappings: fields.map((field) => {
      const mapping = createFieldMapping(field)
      mapping.mode = 'page'
      mapping.selector = field.path === 'title' ? '.title' : '#content'
      mapping.pageSource = field.path === 'title' ? 'list' : 'detail'
      return mapping
    }),
    importedAt: '2026-08-08T00:00:00.000Z'
  }
  return task
}

const createRunnableSpreadsheetTask = (): TaskConfig => {
  const task = createRunnableTask()
  const spreadsheetFields: SpreadsheetFieldDefinition[] = [
    { path: 'A', name: '标题', column: 'A', columnIndex: 0, sampleValue: '' },
    { path: 'B', name: '正文', column: 'B', columnIndex: 1, sampleValue: '' }
  ]
  task.output.format = 'spreadsheet'
  task.spreadsheet = {
    fileName: 'sample.xlsx',
    contentBase64: 'AA==',
    format: 'xlsx',
    sheetName: '数据',
    fields: spreadsheetFields,
    mappings: spreadsheetFields.map((field) => {
      const mapping = createFieldMapping(field)
      mapping.mode = 'page'
      mapping.selector = field.path === 'A' ? '.title' : '#content'
      mapping.pageSource = field.path === 'A' ? 'list' : 'detail'
      return mapping
    }),
    importedAt: '2026-08-09T00:00:00.000Z'
  }
  return task
}

describe('taskConfigurationIssues', () => {
  it('returns no issues for a runnable task and remains the source of runnable truth', () => {
    const task = createRunnableTask()

    expect(taskConfigurationIssues(task)).toEqual([])
    expect(isTaskRunnable(task)).toBe(true)
  })

  it('reports all applicable missing setup instead of stopping at the first item', () => {
    const task = createTask('incomplete-task')
    task.name = '   '
    task.pagination.mode = 'click'

    expect(taskConfigurationIssues(task)).toEqual([
      '请填写任务名称',
      '列表页面 URL/分页：请至少填写一个列表页面 URL',
      '请配置列表项范围选择器',
      '请配置动态分页的“下一页按钮”选择器',
      '请配置详情链接选择器',
      '请导入 XML 模板',
      '请选择采集输出目录'
    ])
    expect(isTaskRunnable(task)).toBe(false)
  })

  it('groups every unresolved XML mapping by field path', () => {
    const task = createRunnableTask()
    task.xml!.mappings.forEach((mapping) => {
      mapping.mode = 'unconfigured'
      mapping.selector = ''
    })

    expect(taskConfigurationIssues(task)).toEqual([
      '请完成 XML 字段映射：title、text'
    ])
  })

  it('validates only the selected spreadsheet template and its column mappings', () => {
    const task = createRunnableSpreadsheetTask()
    task.xml!.mappings[0]!.mode = 'unconfigured'

    expect(taskConfigurationIssues(task)).toEqual([])
    task.spreadsheet!.mappings[1]!.mode = 'unconfigured'
    task.spreadsheet!.mappings[1]!.selector = ''

    expect(taskConfigurationIssues(task)).toEqual(['请完成表格字段映射：B'])
    task.spreadsheet!.fields = []
    task.spreadsheet!.mappings = []
    expect(taskConfigurationIssues(task)).toEqual(['表格模板第一行没有可映射列，请重新导入'])
    task.spreadsheet = null
    expect(taskConfigurationIssues(task)).toEqual(['请导入 XLSX 或 XLS 表格模板'])
  })

  it('migrates legacy tasks to XML output without requiring spreadsheet configuration', () => {
    const legacy = JSON.parse(JSON.stringify(createRunnableTask())) as Record<string, unknown>
    delete (legacy.output as Record<string, unknown>).format
    delete (legacy.detail as Record<string, unknown>).navigationMode
    delete legacy.spreadsheet

    const normalized = normalizeTaskConfig(legacy as unknown as TaskConfig)

    expect(normalized.output.format).toBe('xml')
    expect(normalized.detail.navigationMode).toBe('link')
    expect(normalized.spreadsheet).toBeNull()
    expect(taskConfigurationIssues(normalized)).toEqual([])
  })

  it.each([
    ['list page rules', (task: TaskConfig) => task.listPageRules.push('https://other.test/list')],
    ['list selector', (task: TaskConfig) => (task.listItem.selector = '')],
    [
      'dynamic next button',
      (task: TaskConfig) => {
        task.pagination.mode = 'click'
        task.pagination.nextButton.selector = ''
      }
    ],
    ['detail selector', (task: TaskConfig) => (task.detail.link.selector = '')],
    [
      'dedupe field',
      (task: TaskConfig) => {
        task.detail.enabled = false
        task.dedupeFieldPath = ''
      }
    ],
    ['XML template', (task: TaskConfig) => (task.xml = null)],
    ['XML record path', (task: TaskConfig) => (task.xml!.recordPath = '')],
    ['output directory', (task: TaskConfig) => (task.output.rootDirectory = '')],
    ['records per file', (task: TaskConfig) => (task.output.recordsPerFile = 201)],
    [
      'resource download settings',
      (task: TaskConfig) => {
        task.resources.download.enabled = true
        task.resources.download.rootDirectory = ''
        task.resources.download.urlPrefix = ''
      }
    ],
    [
      'resource prefix',
      (task: TaskConfig) => {
        task.resources.addressMode = 'prefix'
        task.resources.urlPrefix = ''
      }
    ],
    ['request timeout', (task: TaskConfig) => (task.request.timeoutSeconds = Number.NaN)],
    ['request concurrency', (task: TaskConfig) => (task.request.detailConcurrency = 0)],
    ['request delay', (task: TaskConfig) => (task.request.delayMs = -1)],
    ['field mapping', (task: TaskConfig) => (task.xml!.mappings[0]!.mode = 'unconfigured')]
  ])('keeps isTaskRunnable consistent when %s is invalid', (_, mutate) => {
    const task = createRunnableTask()
    mutate(task)

    expect(taskConfigurationIssues(task).length).toBeGreaterThan(0)
    expect(isTaskRunnable(task)).toBe(false)
  })
})
