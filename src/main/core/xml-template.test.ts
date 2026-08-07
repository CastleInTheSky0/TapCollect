import { describe, expect, it } from 'vitest'
import { createMergeValue, mergePageValueKey } from '@shared/field-mapping'
import { configureXmlRecord, inspectXmlTree, renderXmlBatch } from './xml-template'

const template = `<?xml version="1.0" encoding="UTF-8"?>
<book>
  <edition>1.0</edition>
  <article>
    <title><![CDATA[示例]]></title>
    <text><![CDATA[<p>正文</p>]]></text>
    <href><![CDATA[]]></href>
  </article>
</book>`

describe('XML template', () => {
  it('inspects the XML tree and fields', () => {
    const tree = inspectXmlTree(template)
    expect(tree[0]?.path).toBe('/book')
    const configured = configureXmlRecord(template, 'template.xml', '/book/article')
    expect(configured.fields.map((field) => field.path)).toEqual(['title', 'text', 'href'])
    expect(configured.fields.every((field) => field.cdata)).toBe(true)
  })

  it('clones the record and preserves CDATA semantics', () => {
    const configured = configureXmlRecord(template, 'template.xml', '/book/article')
    configured.mappings = configured.mappings.map((mapping) => ({
      ...mapping,
      mode: mapping.fieldPath === 'href' ? 'external-url' : 'page'
    }))
    const output = renderXmlBatch(configured, [
      {
        sequence: 1,
        collectedAt: '2026-08-06T00:00:00.000Z',
        page: 1,
        itemIndex: 1,
        listUrl: 'https://example.com/list',
        detailUrl: 'https://example.com/detail',
        externalUrl: '',
        values: {
          title: '标题',
          text: '<p>内容 ]]> 仍合法</p>'
        }
      },
      {
        sequence: 2,
        collectedAt: '2026-08-06T00:00:01.000Z',
        page: 1,
        itemIndex: 2,
        listUrl: 'https://example.com/list',
        detailUrl: '',
        externalUrl: 'https://other.example.com/a',
        values: {
          title: '外链',
          text: ''
        }
      }
    ])

    expect(output.match(/<article>/g)).toHaveLength(2)
    expect(output).toContain('标题')
    expect(output).toContain('https://other.example.com/a')
    expect(output).toContain(']]]]><![CDATA[>')
  })

  it('writes a resolved merged value into the configured XML field', () => {
    const configured = configureXmlRecord(template, 'template.xml', '/book/article')
    configured.mappings.forEach((mapping) => {
      mapping.mode = 'empty'
    })
    const title = configured.mappings.find((mapping) => mapping.fieldPath === 'title')!
    const pageValue = createMergeValue('page-title')
    pageValue.selector = '.title'
    const fixedValue = createMergeValue('suffix')
    fixedValue.mode = 'fixed'
    fixedValue.fixedValue = '固定后缀'
    title.mode = 'merge'
    title.mergeSeparator = ' - '
    title.mergeValues = [pageValue, fixedValue]

    const output = renderXmlBatch(configured, [
      {
        sequence: 1,
        collectedAt: '2026-08-07T00:00:00.000Z',
        page: 1,
        itemIndex: 1,
        listUrl: 'https://example.com/list',
        detailUrl: '',
        externalUrl: '',
        values: {
          [mergePageValueKey('title', pageValue.id)]: '页面标题'
        }
      }
    ])

    expect(output).toContain('<![CDATA[页面标题 - 固定后缀]]>')
  })
})
