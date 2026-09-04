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
      startMarker: '',
      endMarker: '',
      includeMarkers: false,
      textPrefix: '',
      extraction: 'text',
      attribute: '',
      required: true,
      matchMode: 'first',
      separator: ',',
      trim: true,
      collapseWhitespace: true,
      contentFilterSelectors: [],
      replacements: [],
      convertToTimestamp: false,
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
      startMarker: '',
      endMarker: '',
      includeMarkers: false,
      textPrefix: '',
      extraction: 'html',
      attribute: '',
      required: true,
      matchMode: 'first',
      separator: ',',
      trim: true,
      collapseWhitespace: false,
      contentFilterSelectors: [],
      replacements: [],
      convertToTimestamp: false,
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
      startMarker: '',
      endMarker: '',
      includeMarkers: false,
      textPrefix: '',
      extraction: 'text',
      attribute: '',
      required: false,
      matchMode: 'first',
      separator: ',',
      trim: true,
      collapseWhitespace: false,
      contentFilterSelectors: [],
      replacements: [],
      convertToTimestamp: false,
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
      '<div id="content"><script>window.evil()</script><noscript>脚本后备内容</noscript>' +
        '<a href="files/a.pdf" onclick="evil()">附件</a>' +
        '<a href="javascript:window.print()">打印</a>' +
        '<iframe src="DocView.aspx?id=1"></iframe></div>',
      'https://www.example.com/detail/1'
    )
    expect(detail.missingFields).toEqual([])
    expect(detail.record.values.text).toContain('https://www.example.com/detail/files/a.pdf')
    expect(detail.record.values.text).not.toContain('DocView.aspx')
    expect(detail.record.values.text).not.toContain('window.evil')
    expect(detail.record.values.text).not.toContain('脚本后备内容')
    expect(detail.record.values.text).not.toContain('onclick')
    expect(detail.record.values.text).not.toContain('javascript:')
  })

  it('extracts detail content between literal multiline markers and optionally keeps them', () => {
    const task = createTask('detail-marker-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.title'
    task.xml = template()
    const mapping = task.xml.mappings.find((value) => value.fieldPath === 'text')!
    mapping.selectorType = 'markers'
    mapping.startMarker = '<div class="details">'
    mapping.endMarker = '</div>\n  <!--主体结束-->\n  <br />\n  <br />'

    const list = extractListPage(
      task,
      '<div class="item"><a class="title" href="/detail/1">标题</a></div>',
      task.listUrl,
      1,
      0
    )
    const html =
      '<header>页头</header><div class="details"><p>正文</p></div>\r\n' +
      '  <!--主体结束-->\r\n  <br />\r\n  <br /><footer>页尾</footer>'

    const contentOnly = extractDetailPage(
      task,
      list.candidates[0]!,
      html,
      'https://www.example.com/detail/1'
    )
    expect(contentOnly.record.values.text).toBe('<p>正文</p>')
    expect(contentOnly.matchCounts.text).toBe(1)

    mapping.includeMarkers = true
    const withMarkers = extractDetailPage(
      task,
      list.candidates[0]!,
      html,
      'https://www.example.com/detail/1'
    )
    expect(withMarkers.record.values.text).toBe(
      '<div class="details"><p>正文</p></div>\r\n  <!--主体结束-->\r\n  <br />\r\n  <br />'
    )

    mapping.includeMarkers = false
    mapping.endMarker = '<!--缺失的结束标记-->'
    const incomplete = extractDetailPage(
      task,
      list.candidates[0]!,
      html,
      'https://www.example.com/detail/1'
    )
    expect(incomplete.record.values.text).toBe('')
    expect(incomplete.matchCounts.text).toBe(0)
    expect(incomplete.missingFields).toEqual(['text'])
  })

  it('filters matched subtrees from marker HTML while retaining the configured boundaries', () => {
    const task = createTask('filtered-marker-html-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.title'
    task.xml = template()
    const mapping = task.xml.mappings.find((value) => value.fieldPath === 'text')!
    mapping.selectorType = 'markers'
    mapping.startMarker = '<div class="details">'
    mapping.endMarker = '</div><!--主体结束-->'
    mapping.includeMarkers = true
    mapping.contentFilterSelectors = ['h1', '.share']

    const list = extractListPage(
      task,
      '<div class="item"><a class="title" href="/detail/1">标题</a></div>',
      task.listUrl,
      1,
      0
    )
    const detail = extractDetailPage(
      task,
      list.candidates[0]!,
      '<div class="details"><h1>标题</h1><p>正文</p>' +
        '<div class="share">分享内容</div></div><!--主体结束-->',
      'https://www.example.com/detail/1'
    )

    expect(detail.record.values.text).toBe(
      '<div class="details"><p>正文</p></div><!--主体结束-->'
    )
    expect(detail.matchCounts.text).toBe(1)
  })

  it('extracts filtered marker ranges as text and reuses all-range cleanup', () => {
    const task = createTask('filtered-marker-text-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.title'
    task.xml = template()
    const mapping = task.xml.mappings.find((value) => value.fieldPath === 'text')!
    mapping.selectorType = 'markers'
    mapping.startMarker = '[正文开始]'
    mapping.endMarker = '[正文结束]'
    mapping.extraction = 'text'
    mapping.matchMode = 'all'
    mapping.separator = ' | '
    mapping.collapseWhitespace = true
    mapping.contentFilterSelectors = ['h1', '.share']

    const list = extractListPage(
      task,
      '<div class="item"><a class="title" href="/detail/1">标题</a></div>',
      task.listUrl,
      1,
      0
    )
    const detail = extractDetailPage(
      task,
      list.candidates[0]!,
      '[正文开始]<h1>标题一</h1>\n<p>第一段</p><script>泄漏</script>[正文结束]' +
        '[正文开始]<div class="share">分享</div>\n<p>第二段</p>[正文结束]',
      'https://www.example.com/detail/1'
    )

    expect(detail.record.values.text).toBe('第一段 | 第二段')
    expect(detail.matchCounts.text).toBe(2)
  })

  it('reports invalid content filters for marker fields with the field label', () => {
    const task = createTask('invalid-marker-filter-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.title'
    task.xml = template()
    const mapping = task.xml.mappings.find((value) => value.fieldPath === 'text')!
    mapping.selectorType = 'markers'
    mapping.startMarker = '[开始]'
    mapping.endMarker = '[结束]'
    mapping.contentFilterSelectors = ['div[']

    const list = extractListPage(
      task,
      '<div class="item"><a class="title" href="/detail/1">标题</a></div>',
      task.listUrl,
      1,
      0
    )

    expect(() =>
      extractDetailPage(
        task,
        list.candidates[0]!,
        '[开始]<p>正文</p>[结束]',
        'https://www.example.com/detail/1'
      )
    ).toThrow('字段“text”：内容过滤 CSS 选择器“div[”无效')
  })

  it('matches list-field markers against each item source before DOM serialization', () => {
    const task = createTask('list-marker-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.title'
    task.xml = template()
    const mapping = task.xml.mappings.find((value) => value.fieldPath === 'title')!
    mapping.selectorType = 'markers'
    mapping.startMarker = '<br />\n<!--标题开始-->'
    mapping.endMarker = '<!--标题结束-->'
    mapping.extraction = 'html'

    const result = extractListPage(
      task,
      '<article class="item"><a class="title" href="/detail/1">链接</a>' +
        '<br />\n<!--标题开始--><strong>源码标题</strong><!--标题结束--></article>',
      task.listUrl,
      1,
      0
    )

    expect(result.candidates[0]?.values.title).toBe('<strong>源码标题</strong>')
    expect(result.matchCounts.title).toEqual([1])
  })

  it('reads a detail link from the list item itself or its nearest wrapping ancestor', () => {
    const html = `
      <div id="project">
        <a href="/detail/1"><li><h1>标题一</h1></li></a>
        <a href="/detail/2"><li><h1>标题二</h1></li></a>
      </div>
    `

    const rootTask = createTask('root-link-task')
    rootTask.listUrl = 'https://www.example.com/list'
    rootTask.listItem.selector = '#project > a'
    rootTask.detail.link.selector = ':scope'
    rootTask.xml = template()
    rootTask.xml.mappings[0]!.selector = 'h1'

    const rootResult = extractListPage(rootTask, html, rootTask.listUrl, 1, 0)
    expect(rootResult.candidates.map((candidate) => candidate.detailUrl)).toEqual([
      'https://www.example.com/detail/1',
      'https://www.example.com/detail/2'
    ])

    const wrappedTask = createTask('wrapped-link-task')
    wrappedTask.listUrl = 'https://www.example.com/list'
    wrappedTask.listItem.selector = '#project > a > li'
    wrappedTask.detail.link.selector = 'a[href]'
    wrappedTask.xml = template()
    wrappedTask.xml.mappings[0]!.selector = 'a[href]'

    const wrappedResult = extractListPage(wrappedTask, html, wrappedTask.listUrl, 1, 0)
    expect(wrappedResult.candidates.map((candidate) => candidate.detailUrl)).toEqual([
      'https://www.example.com/detail/1',
      'https://www.example.com/detail/2'
    ])
    expect(wrappedResult.candidates.map((candidate) => candidate.values.title)).toEqual(['', ''])
  })

  it('removes script bodies before extracting plain text', () => {
    const task = createTask('text-cleaning-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.detail'
    task.xml = template()
    const textMapping = task.xml.mappings.find((mapping) => mapping.fieldPath === 'text')!
    textMapping.extraction = 'text'

    const list = extractListPage(
      task,
      '<div class="item"><a class="title detail" href="/detail/1">标题</a></div>',
      task.listUrl,
      1,
      0
    )
    const detail = extractDetailPage(
      task,
      list.candidates[0]!,
      '<div id="content">正文<script>window.leaked()</script><span>结束</span></div>',
      'https://www.example.com/detail/1'
    )

    expect(detail.record.values.text).toBe('正文结束')
    expect(detail.record.values.text).not.toContain('window.leaked')
  })

  it('extracts labelled metadata without depending on an optional sibling position', () => {
    const task = createTask('labelled-metadata-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.detail'
    task.xml = template()
    const published = task.xml.mappings.find((mapping) => mapping.fieldPath === 'text')!
    published.extraction = 'text'
    published.selector = 'h2 span'
    published.textPrefix = '发布时间：'

    const list = extractListPage(
      task,
      '<div class="item"><a class="title detail" href="/detail/1">标题</a></div>',
      task.listUrl,
      1,
      0
    )
    const withoutSource = extractDetailPage(
      task,
      list.candidates[0]!,
      '<h2><span>作者：省侨联</span><span>发布时间：2026-08-12</span></h2>',
      'https://www.example.com/detail/1'
    )
    const withSource = extractDetailPage(
      task,
      list.candidates[0]!,
      '<h2><span>作者：周锋生</span><span>来源：海外侨声</span>' +
        '<span>发布时间：2019-07-08</span></h2>',
      'https://www.example.com/detail/2'
    )

    expect(withoutSource.record.values.text).toBe('2026-08-12')
    expect(withoutSource.matchCounts.text).toBe(1)
    expect(withSource.record.values.text).toBe('2019-07-08')
    expect(withSource.matchCounts.text).toBe(1)

    published.selector = '.metadata'
    published.textPrefix = '作者'
    const combinedHtml = `
      <div class="metadata">
        作者：省侨联
        发布时间：2026-08-12
      </div>
    `
    const combinedAuthor = extractDetailPage(
      task,
      list.candidates[0]!,
      combinedHtml,
      'https://www.example.com/detail/3'
    )
    published.textPrefix = '发布时间'
    const combinedPublished = extractDetailPage(
      task,
      list.candidates[0]!,
      combinedHtml,
      'https://www.example.com/detail/3'
    )

    expect(combinedAuthor.record.values.text).toBe('省侨联')
    expect(combinedPublished.record.values.text).toBe('2026-08-12')
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

  it('keeps click-navigation candidates even when list items have no href', () => {
    const task = createTask('click-detail-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.content-item'
    task.detail.navigationMode = 'click'
    task.detail.link.selector = '.data-name'
    task.xml = template()

    const result = extractListPage(
      task,
      '<div class="content-list"><div class="content-item"><span class="data-name">目录一</span></div></div>',
      task.listUrl,
      1,
      0
    )

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      detailRequestUrl: '',
      detailUrl: '',
      externalUrl: ''
    })
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
    detailValue.selectorType = 'markers'
    detailValue.startMarker = '<!--正文开始-->'
    detailValue.endMarker = '<!--正文结束-->'
    detailValue.extraction = 'html'
    detailValue.contentFilterSelectors = ['.share']
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
      '<!--正文开始--><p>详情正文</p><div class="share">分享内容</div><!--正文结束-->',
      'https://www.example.com/detail/1'
    )

    expect(resolveFieldValue(mapping, field, detail.record)).toBe(
      '列表标题 / 固定内容 / <p>详情正文</p>'
    )
    expect(list.matchCounts['summary / 合并项 1']).toEqual([1])
    expect(detail.matchCounts['summary / 合并项 3']).toBe(1)
  })

  it('converts only explicitly enabled page fields and merge children', () => {
    const task = createTask('date-field-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.enabled = false
    task.xml = configureXmlRecord(
      '<book><article><published/><text/><summary/></article></book>',
      'date.xml',
      '/book/article'
    )

    const published = task.xml.mappings.find((mapping) => mapping.fieldPath === 'published')!
    published.mode = 'page'
    published.pageSource = 'list'
    published.selector = '.published'
    published.convertToTimestamp = true

    const text = task.xml.mappings.find((mapping) => mapping.fieldPath === 'text')!
    text.mode = 'page'
    text.pageSource = 'list'
    text.selector = '.text'

    const summary = task.xml.mappings.find((mapping) => mapping.fieldPath === 'summary')!
    const datePart = createMergeValue('date-part')
    datePart.selector = '.published'
    datePart.convertToTimestamp = true
    const suffix = createMergeValue('suffix')
    suffix.mode = 'fixed'
    suffix.fixedValue = '已发布'
    summary.mode = 'merge'
    summary.mergeSeparator = ' / '
    summary.mergeValues = [datePart, suffix]

    const result = extractListPage(
      task,
      '<div class="item"><span class="published">2026-08-12</span>' +
        '<div class="text">正文中的日期 2026-08-12 保持原样</div></div>',
      task.listUrl,
      1,
      0
    )
    const candidate = result.candidates[0]!
    const outputRecord = candidateToRecord(candidate)

    expect(candidate.values.published).toBe('1786464000000')
    expect(candidate.values.text).toBe('正文中的日期 2026-08-12 保持原样')
    expect(resolveFieldValue(summary, task.xml.fields.find((field) => field.path === 'summary')!, outputRecord)).toBe(
      '1786464000000 / 已发布'
    )
    expect(candidate.warnings).toEqual([])

    published.required = true
    const invalid = extractListPage(
      task,
      '<div class="item"><span class="published">2026-02-30</span>' +
        '<div class="text">正文日期仍不转换</div></div>',
      task.listUrl,
      1,
      0
    ).candidates[0]!
    expect(invalid.values.published).toBe('')
    expect(invalid.missingListFields).toEqual(['published'])
    expect(invalid.warnings).toEqual([
      expect.objectContaining({
        stage: 'date-conversion',
        fieldPath: 'published',
        reason: expect.stringContaining('2026-02-30')
      }),
      expect.objectContaining({
        stage: 'date-conversion',
        fieldPath: 'summary / 合并项 1',
        reason: expect.stringContaining('2026-02-30')
      })
    ])
  })

  it('keeps resource plans with the extracted record while rewriting the final HTML value', () => {
    const task = createTask('resource-extraction-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a.detail'
    task.xml = template()
    task.resources.download.enabled = true
    task.resources.download.rootDirectory = 'D:/resources'
    task.resources.download.urlPrefix = '/resources'
    const textMapping = task.xml.mappings.find((mapping) => mapping.fieldPath === 'text')!
    textMapping.contentFilterSelectors = ['.advertisement']

    const list = extractListPage(
      task,
      '<div class="item"><a class="title detail" href="/detail/1">标题</a></div>',
      task.listUrl,
      1,
      0
    )
    const detail = extractDetailPage(
      task,
      list.candidates[0]!,
      '<div id="content"><div class="advertisement"><img src="/images/ad.jpg">广告</div>' +
        '<img src="/images/a.jpg"><a href="/files/a.pdf">附件</a></div>',
      'https://www.example.com/detail/1'
    )

    expect(detail.record.values.text).toContain('/resources/images/a.jpg')
    expect(detail.record.values.text).toContain('/resources/files/a.pdf')
    expect(detail.record.values.text).not.toContain('advertisement')
    expect(detail.record.values.text).not.toContain('/images/ad.jpg')
    expect(detail.record.resources).toHaveLength(2)
  })

  it('identifies the field when a content filter selector is invalid', () => {
    const task = createTask('invalid-content-filter-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.enabled = false
    task.xml = configureXmlRecord(
      '<book><article><text/></article></book>',
      'invalid-filter.xml',
      '/book/article'
    )
    const mapping = task.xml.mappings[0]!
    mapping.mode = 'page'
    mapping.pageSource = 'list'
    mapping.selector = '.content'
    mapping.contentFilterSelectors = ['div[']

    expect(() =>
      extractListPage(
        task,
        '<div class="item"><div class="content">正文</div></div>',
        task.listUrl,
        1,
        0
      )
    ).toThrow('字段“text”：内容过滤 CSS 选择器“div[”无效')
  })

  it('plans a resource extracted directly from an attribute field', () => {
    const task = createTask('resource-attribute-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.enabled = false
    task.xml = configureXmlRecord(
      '<book><article><image/></article></book>',
      'image.xml',
      '/book/article'
    )
    const mapping = task.xml.mappings[0]!
    mapping.mode = 'page'
    mapping.pageSource = 'list'
    mapping.selector = 'img'
    mapping.extraction = 'attribute'
    mapping.attribute = 'src'
    task.resources.download.enabled = true
    task.resources.download.rootDirectory = 'D:/resources'
    task.resources.download.urlPrefix = '/resources'

    const list = extractListPage(
      task,
      '<div class="item"><img src="/images/a.jpg"></div>',
      task.listUrl,
      1,
      0
    )

    expect(list.candidates[0]?.values.image).toBe('/resources/images/a.jpg')
    expect(list.candidates[0]?.resources).toHaveLength(1)
  })

  it('preserves ordinary attribute values instead of resolving them as URLs', () => {
    const task = createTask('ordinary-attribute-task')
    task.listUrl = 'https://www.example.com/InfoPub/ArticleList.aspx?CategoryID=2'
    task.listItem.selector = '.item'
    task.detail.enabled = false
    task.xml = configureXmlRecord(
      '<book><article><title/><link/></article></book>',
      'title.xml',
      '/book/article'
    )
    const titleMapping = task.xml.mappings.find((mapping) => mapping.fieldPath === 'title')!
    const linkMapping = task.xml.mappings.find((mapping) => mapping.fieldPath === 'link')!
    for (const mapping of [titleMapping, linkMapping]) {
      mapping.mode = 'page'
      mapping.pageSource = 'list'
      mapping.selector = 'a'
      mapping.extraction = 'attribute'
    }
    titleMapping.attribute = 'title'
    linkMapping.attribute = 'href'

    const list = extractListPage(
      task,
      '<div class="item"><a href="/detail/1" title="普通中文标题">列表文字</a></div>',
      task.listUrl,
      1,
      0
    )

    expect(list.candidates[0]?.values.title).toBe('普通中文标题')
    expect(list.candidates[0]?.values.link).toBe('https://www.example.com/detail/1')
    expect(list.candidates[0]?.resources).toEqual([])
  })

  it('processes complete file paths in text fields without rewriting prose fragments', () => {
    const task = createTask('resource-text-value-task')
    task.listUrl = 'https://www.example.com/list'
    task.listItem.selector = '.item'
    task.detail.enabled = false
    task.xml = configureXmlRecord(
      '<book><article><file/><sentence/></article></book>',
      'text-resources.xml',
      '/book/article'
    )
    const fileMapping = task.xml.mappings.find((mapping) => mapping.fieldPath === 'file')!
    fileMapping.mode = 'page'
    fileMapping.pageSource = 'list'
    fileMapping.selector = '.file'
    fileMapping.extraction = 'text'
    const sentenceMapping = task.xml.mappings.find((mapping) => mapping.fieldPath === 'sentence')!
    sentenceMapping.mode = 'page'
    sentenceMapping.pageSource = 'list'
    sentenceMapping.selector = '.sentence'
    sentenceMapping.extraction = 'text'
    task.resources.download.enabled = true
    task.resources.download.rootDirectory = 'D:/resources'
    task.resources.download.urlPrefix = '/resources'

    const html =
      '<div class="item"><span class="file">/附件/会议材料.xls</span>' +
      '<span class="sentence">说明里出现 .jpg 但不是文件路径</span></div>'
    const readable = extractListPage(task, html, task.listUrl, 1, 0)

    expect(readable.candidates[0]?.values.file).toBe('/resources/附件/会议材料.xls')
    expect(readable.candidates[0]?.values.sentence).toBe('说明里出现 .jpg 但不是文件路径')
    expect(readable.candidates[0]?.resources).toHaveLength(1)

    task.resources.encodeUrls = true
    const encoded = extractListPage(task, html, task.listUrl, 1, 0)
    expect(encoded.candidates[0]?.values.file).toBe(
      '/resources/%E9%99%84%E4%BB%B6/%E4%BC%9A%E8%AE%AE%E6%9D%90%E6%96%99.xls'
    )
    expect(encoded.candidates[0]?.resources).toHaveLength(1)
  })
})
