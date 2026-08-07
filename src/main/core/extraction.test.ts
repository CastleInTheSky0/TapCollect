import { describe, expect, it } from 'vitest'
import { createTask } from '@shared/defaults'
import { createMergeValue } from '@shared/field-mapping'
import type { XmlTemplateConfig } from '@shared/types'
import { candidateToRecord, extractDetailPage, extractListPage } from './extraction'
import { resolveFieldValue } from './field-values'
import { configureXmlRecord } from './xml-template'

const template = (): XmlTemplateConfig => ({
  fileName: 'sample.xml',
  content: '<book><article><title/><text/><outside/></article></book>',
  encoding: 'UTF-8',
  recordPath: '/book/article',
  fields: [
    { path: 'title', name: 'title', kind: 'element', cdata: false, sampleValue: '' },
    { path: 'text', name: 'text', kind: 'element', cdata: false, sampleValue: '' },
    { path: 'outside', name: 'outside', kind: 'element', cdata: false, sampleValue: '' }
  ],
  mappings: [
    {
      fieldPath: 'title',
      mode: 'page',
      pageSource: 'list',
      selectorType: 'css',
      selector: 'a.title',
      extraction: 'text',
      attribute: '',
      required: true,
      matchMode: 'first',
      separator: ',',
      trim: true,
      collapseWhitespace: true,
      replacements: [],
      fixedValue: '',
      systemValue: 'collected-at',
      mergeSeparator: '',
      mergeValues: []
    },
    {
      fieldPath: 'text',
      mode: 'page',
      pageSource: 'detail',
      selectorType: 'css',
      selector: '#content',
      extraction: 'html',
      attribute: '',
      required: true,
      matchMode: 'first',
      separator: ',',
      trim: true,
      collapseWhitespace: false,
      replacements: [],
      fixedValue: '',
      systemValue: 'collected-at',
      mergeSeparator: '',
      mergeValues: []
    },
    {
      fieldPath: 'outside',
      mode: 'external-url',
      pageSource: 'list',
      selectorType: 'css',
      selector: '',
      extraction: 'text',
      attribute: '',
      required: false,
      matchMode: 'first',
      separator: ',',
      trim: true,
      collapseWhitespace: false,
      replacements: [],
      fixedValue: '',
      systemValue: 'collected-at',
      mergeSeparator: '',
      mergeValues: []
    }
  ],
  importedAt: '2026-08-06T00:00:00.000Z'
})

describe('page extraction', () => {
  it('extracts relative list fields and a cleaned detail body', () => {
    const task = createTask('task')
    task.listUrl = 'https://www.example.com/list?page=1'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.title'
    task.xml = template()
    const list = extractListPage(
      task,
      '<div class="item"><a class="title" href="/detail/1">  标题\n一  </a></div>',
      task.listUrl,
      1,
      0
    )
    expect(list.itemCount).toBe(1)
    expect(list.candidates[0]?.values.title).toBe('标题 一')
    expect(list.candidates[0]?.detailUrl).toBe('https://www.example.com/detail/1')

    const detail = extractDetailPage(
      task,
      list.candidates[0]!,
      '<div id="content"><a href="files/a.pdf">附件</a><iframe src="DocView.aspx?id=1"></iframe></div>',
      'https://www.example.com/detail/1'
    )
    expect(detail.missingFields).toEqual([])
    expect(detail.record.values.text).toContain('https://www.example.com/detail/files/a.pdf')
    expect(detail.record.values.text).not.toContain('DocView.aspx')
  })

  it('does not request a different hostname and preserves it as the external URL', () => {
    const task = createTask('task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a'
    task.xml = template()
    const result = extractListPage(
      task,
      '<div class="item"><a class="title" href="https://sub.example.com/a">外链</a></div>',
      task.listUrl,
      1,
      0
    )
    const candidate = result.candidates[0]!
    expect(candidate.detailRequestUrl).toBe('')
    expect(candidate.externalUrl).toBe('https://sub.example.com/a')
    expect(candidateToRecord(candidate).detailUrl).toBe('')
  })

  it('extracts list and detail child values before merging them with a fixed value', () => {
    const task = createTask('merge-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.detail'
    task.xml = configureXmlRecord(
      '<book><article><summary/></article></book>',
      'merge.xml',
      '/book/article'
    )
    const field = task.xml.fields[0]!
    const mapping = task.xml.mappings[0]!
    const listValue = createMergeValue('list-title')
    listValue.pageSource = 'list'
    listValue.selector = '.title'
    const fixedValue = createMergeValue('fixed-label')
    fixedValue.mode = 'fixed'
    fixedValue.fixedValue = '固定内容'
    const detailValue = createMergeValue('detail-body')
    detailValue.pageSource = 'detail'
    detailValue.selector = '#content'
    mapping.mode = 'merge'
    mapping.mergeSeparator = ' / '
    mapping.mergeValues = [listValue, fixedValue, detailValue]

    const list = extractListPage(
      task,
      '<div class="item"><span class="title">列表标题</span><a class="detail" href="/detail/1">详情</a></div>',
      task.listUrl,
      1,
      0
    )
    const detail = extractDetailPage(
      task,
      list.candidates[0]!,
      '<div id="content">详情正文</div>',
      'https://www.example.com/detail/1'
    )

    expect(resolveFieldValue(mapping, field, detail.record)).toBe(
      '列表标题 / 固定内容 / 详情正文'
    )
    expect(list.matchCounts['summary / 合并项 1']).toEqual([1])
    expect(detail.matchCounts['summary / 合并项 3']).toBe(1)
  })
})
