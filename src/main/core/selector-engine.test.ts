import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { createPageExtractionConfig } from '@shared/field-mapping'
import { extractRawValue } from './selector-engine'

const documentFor = (html: string): Document => new JSDOM(html).window.document

describe('field content filtering', () => {
  it('removes matched subtrees before extracting text', () => {
    const mapping = createPageExtractionConfig()
    mapping.selector = '#content'
    mapping.contentFilterSelectors = ['h1', '.share']
    const document = documentFor(
      '<div id="content"><h1>标题<span>子标题</span></h1><p>正文</p>' +
        '<div class="share">分享<b>按钮</b></div><p>结尾</p></div>'
    )

    expect(extractRawValue(document, mapping)).toBe('正文结尾')
  })

  it('removes matched tags and descendants before extracting HTML', () => {
    const mapping = createPageExtractionConfig()
    mapping.selector = '#content'
    mapping.extraction = 'html'
    mapping.contentFilterSelectors = ['h1', '.share']
    const document = documentFor(
      '<div id="content"><h1>标题<span>子标题</span></h1><p>正文</p>' +
        '<div class="share">分享<b>按钮</b></div><p>结尾</p></div>'
    )

    expect(extractRawValue(document, mapping)).toBe('<p>正文</p><p>结尾</p>')
  })

  it('returns empty when the selected node is inside a filtered subtree', () => {
    const mapping = createPageExtractionConfig()
    mapping.selector = '.share b'
    mapping.contentFilterSelectors = ['.share']
    const document = documentFor('<div class="share">分享<b>按钮</b></div>')

    expect(extractRawValue(document, mapping)).toBe('')
  })

  it('does not apply or validate content filters for attribute extraction', () => {
    const mapping = createPageExtractionConfig()
    mapping.selector = 'a'
    mapping.extraction = 'attribute'
    mapping.attribute = 'href'
    mapping.contentFilterSelectors = ['div[']
    const document = documentFor('<a href="/detail">详情</a>')

    expect(extractRawValue(document, mapping)).toBe('/detail')
  })

  it('reports the invalid CSS filter selector', () => {
    const mapping = createPageExtractionConfig()
    mapping.selector = '#content'
    mapping.contentFilterSelectors = ['div[']
    const document = documentFor('<div id="content">正文</div>')

    expect(() => extractRawValue(document, mapping)).toThrow(
      '内容过滤 CSS 选择器“div[”无效'
    )
  })

  it('keeps the existing script-content cleanup alongside custom filters', () => {
    const mapping = createPageExtractionConfig()
    mapping.selector = '#content'
    mapping.contentFilterSelectors = ['h1']
    const document = documentFor(
      '<div id="content"><h1>标题</h1>正文<script>window.leaked()</script>结尾</div>'
    )

    expect(extractRawValue(document, mapping, true)).toBe('正文结尾')
  })
})
