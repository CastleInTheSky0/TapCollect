import { describe, expect, it } from 'vitest'
import { createFieldMapping, createTask } from './defaults'
import {
  createTaskConfigBundle,
  parseTaskConfigBundle,
  prepareImportedTaskConfig,
  TASK_CONFIG_BUNDLE_FORMAT
} from './task-config-bundle'

describe('task config bundle', () => {
  it('creates a versioned JSON bundle without sharing task references', () => {
    const task = createTask('task-1', '2026-08-09T00:00:00.000Z')
    task.name = '示例任务'
    task.request.headers.push({ id: 'cookie', key: 'Cookie', value: 'session=secret' })
    task.spreadsheet = {
      fileName: 'template.xlsx',
      contentBase64: 'UEsDBAoAAAAA',
      format: 'xlsx',
      sheetName: '数据',
      fields: [],
      mappings: [],
      importedAt: '2026-08-09T00:00:00.000Z'
    }

    const bundle = createTaskConfigBundle([task], '2026-08-09T01:00:00.000Z')

    expect(bundle).toMatchObject({
      format: TASK_CONFIG_BUNDLE_FORMAT,
      version: 1,
      exportedAt: '2026-08-09T01:00:00.000Z'
    })
    expect(bundle.tasks[0]).toEqual(task)
    expect(bundle.tasks[0]).not.toBe(task)
    expect(bundle.tasks[0]?.spreadsheet?.contentBase64).toBe('UEsDBAoAAAAA')
  })

  it('parses only the supported non-empty bundle envelope', () => {
    const task = createTask('task-1')

    expect(parseTaskConfigBundle(createTaskConfigBundle([task]))).toHaveLength(1)
    expect(() => parseTaskConfigBundle({ format: 'other', version: 1, tasks: [task] }))
      .toThrow('不是 TapCollect 任务配置文件')
    expect(() => parseTaskConfigBundle({
      format: TASK_CONFIG_BUNDLE_FORMAT,
      version: 2,
      tasks: [task]
    })).toThrow('不支持任务配置文件版本')
    expect(() => parseTaskConfigBundle({
      format: TASK_CONFIG_BUNDLE_FORMAT,
      version: 1,
      tasks: []
    })).toThrow('没有可导入的任务')
  })

  it('replaces identity fields while preserving complete task configuration', () => {
    const source = createTask('source-id', '2025-01-01T00:00:00.000Z')
    source.name = '导入任务'
    source.listPageRules = ['https://example.com/list.html']
    const field = {
      path: 'published',
      name: '发布时间',
      kind: 'element' as const,
      cdata: false,
      sampleValue: ''
    }
    const mapping = createFieldMapping(field)
    mapping.mode = 'page'
    mapping.selectorType = 'markers'
    mapping.startMarker = '<time>'
    mapping.endMarker = '</time>'
    mapping.includeMarkers = true
    mapping.textPrefix = '自定义发布日期'
    mapping.contentFilterSelectors = ['h1', '.share']
    mapping.convertToTimestamp = true
    source.xml = {
      fileName: 'template.xml',
      content: '<root><item><published/></item></root>',
      encoding: 'UTF-8',
      recordPath: '/root/item',
      fields: [field],
      mappings: [mapping],
      importedAt: '2026-08-09T00:00:00.000Z'
    }

    const imported = prepareImportedTaskConfig(
      source,
      'new-id',
      '2026-08-09T02:00:00.000Z'
    )

    expect(imported).toMatchObject({
      id: 'new-id',
      name: '导入任务',
      listUrl: 'https://example.com/list.html',
      createdAt: '2026-08-09T02:00:00.000Z',
      updatedAt: '2026-08-09T02:00:00.000Z'
    })
    expect(imported.xml?.content).toBe(source.xml.content)
    expect(imported.xml?.mappings[0]?.convertToTimestamp).toBe(true)
    expect(imported.xml?.mappings[0]?.textPrefix).toBe('自定义发布日期')
    expect(imported.xml?.mappings[0]?.contentFilterSelectors).toEqual(['h1', '.share'])
    expect(imported.xml?.mappings[0]).toMatchObject({
      selectorType: 'markers',
      startMarker: '<time>',
      endMarker: '</time>',
      includeMarkers: true
    })
  })

  it('rejects malformed task entries with a field-specific reason', () => {
    const malformed = createTask('broken') as unknown as Record<string, unknown>
    malformed.request = { headers: [] }

    expect(() => prepareImportedTaskConfig(malformed, 'new-id')).toThrow(
      '任务配置.request.userAgent 必须是字符串'
    )
    expect(() => prepareImportedTaskConfig('not-an-object', 'new-id')).toThrow(
      '任务配置必须是 JSON 对象'
    )

    const invalidNavigation = createTask('invalid-navigation') as unknown as Record<string, unknown>
    ;(invalidNavigation.detail as Record<string, unknown>).navigationMode = 'script'
    expect(() => prepareImportedTaskConfig(invalidNavigation, 'new-id')).toThrow(
      '任务配置.detail.navigationMode 只能是 link 或 click'
    )
  })
})
