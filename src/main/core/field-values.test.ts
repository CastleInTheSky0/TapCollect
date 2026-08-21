import { describe, expect, it } from 'vitest'
import { createFieldMapping, createTask } from '@shared/defaults'
import { createMergeValue, mergePageValueKey } from '@shared/field-mapping'
import type { ExtractedRecord, XmlFieldDefinition, XmlTemplateConfig } from '@shared/types'
import {
  missingRequiredMergeFields,
  resolveFieldValue,
  resolveFieldValueResult
} from './field-values'

const field: XmlFieldDefinition = {
  path: 'text',
  name: 'text',
  kind: 'element',
  cdata: true,
  sampleValue: ''
}

const record = (values: Record<string, string> = {}): ExtractedRecord => ({
  sequence: 0,
  collectedAt: '2026-08-07T00:00:00.000Z',
  page: 1,
  itemIndex: 1,
  listUrl: 'https://example.com/list',
  detailUrl: 'https://example.com/detail/1',
  externalUrl: '',
  values
})

const templateWithMapping = (): XmlTemplateConfig => {
  const mapping = createFieldMapping(field)
  mapping.mode = 'merge'
  mapping.required = true
  return {
    fileName: 'sample.xml',
    content: '<book><article><text/></article></book>',
    encoding: 'UTF-8',
    recordPath: '/book/article',
    fields: [field],
    mappings: [mapping],
    importedAt: '2026-08-07T00:00:00.000Z'
  }
}

describe('merged field values', () => {
  it('joins non-empty child values in configured order without extra separators', () => {
    const mapping = createFieldMapping(field)
    const first = { ...createMergeValue('first'), mode: 'page' as const }
    const empty = { ...createMergeValue('empty'), mode: 'fixed' as const, fixedValue: '' }
    const third = { ...createMergeValue('third'), mode: 'fixed' as const, fixedValue: '固定内容' }
    const fourth = { ...createMergeValue('fourth'), mode: 'page' as const }
    mapping.mode = 'merge'
    mapping.mergeSeparator = ' | '
    mapping.mergeValues = [first, empty, third, fourth]

    const value = resolveFieldValue(
      mapping,
      field,
      record({
        [mergePageValueKey(field.path, first.id)]: '列表值',
        [mergePageValueKey(field.path, fourth.id)]: '详情值'
      })
    )

    expect(value).toBe('列表值 | 固定内容 | 详情值')
  })

  it('checks required state only after the final merged result is resolved', () => {
    const task = createTask('required-merge')
    task.xml = templateWithMapping()
    const mapping = task.xml.mappings[0]!
    const pageValue = createMergeValue('page-value')
    pageValue.pageSource = 'list'
    const fixedValue = { ...createMergeValue('fixed-value'), mode: 'fixed' as const, fixedValue: '' }
    mapping.mergeValues = [pageValue, fixedValue]

    expect(missingRequiredMergeFields(task, record())).toEqual(['text'])

    fixedValue.fixedValue = '兜底常量'
    expect(missingRequiredMergeFields(task, record())).toEqual([])
  })

  it('does not reject an external record when a required merge contains only detail values', () => {
    const task = createTask('external-merge')
    task.xml = templateWithMapping()
    const detailValue = createMergeValue('detail-value')
    detailValue.pageSource = 'detail'
    task.xml.mappings[0]!.mergeValues = [detailValue]

    expect(
      missingRequiredMergeFields(task, {
        ...record(),
        detailUrl: '',
        externalUrl: 'https://outside.example/article'
      })
    ).toEqual([])
  })

  it('converts system collection time only when its field switch is enabled', () => {
    const mapping = createFieldMapping(field)
    mapping.mode = 'system'
    mapping.systemValue = 'collected-at'
    const collectedRecord = {
      ...record(),
      collectedAt: '2026-08-12T00:00:00+08:00'
    }

    expect(resolveFieldValue(mapping, field, collectedRecord)).toBe(
      '2026-08-12T00:00:00+08:00'
    )

    mapping.convertToTimestamp = true
    expect(resolveFieldValue(mapping, field, collectedRecord)).toBe('1786464000000')
  })

  it('converts a system collection-time merge child independently', () => {
    const mapping = createFieldMapping(field)
    const collectedAt = createMergeValue('collected-at')
    collectedAt.mode = 'system'
    collectedAt.systemValue = 'collected-at'
    collectedAt.convertToTimestamp = true
    const suffix = createMergeValue('suffix')
    suffix.mode = 'fixed'
    suffix.fixedValue = '采集'
    mapping.mode = 'merge'
    mapping.mergeSeparator = '-'
    mapping.mergeValues = [collectedAt, suffix]

    expect(
      resolveFieldValue(mapping, field, {
        ...record(),
        collectedAt: '2026-08-12T00:00:00+08:00'
      })
    ).toBe('1786464000000-采集')
  })

  it('returns an empty system value and a warning when conversion fails', () => {
    const mapping = createFieldMapping(field)
    mapping.mode = 'system'
    mapping.convertToTimestamp = true

    const result = resolveFieldValueResult(mapping, field, {
      ...record(),
      collectedAt: 'invalid-date'
    })

    expect(result.value).toBe('')
    expect(result.warnings).toEqual([
      {
        fieldPath: 'text',
        reason: expect.stringContaining('invalid-date')
      }
    ])
  })
})
