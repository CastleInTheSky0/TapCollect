import { describe, expect, it } from 'vitest'
import type { Element } from '@xmldom/xmldom'
import { createMergeValue, mergePageValueKey } from '@shared/field-mapping'
import { configureXmlRecord, inspectXmlTree, parseXml, renderXmlBatch } from './xml-template'

const template = `<?xml version="1.0" encoding="UTF-8"?>
<book>
  <edition>1.0</edition>
  <article>
    <title><![CDATA[示例]]></title>
    <text><![CDATA[<p>正文</p>]]></text>
    <href><![CDATA[]]></href>
  </article>
</book>`

const idFieldTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <InfoEntities>
    <InfoEntity>
      <field name="信息标题" id="title">示例标题</field>
      <field name="信息副标题" id="sectitle"></field>
      <field name="附件" id="vc_attach"><![CDATA[]]></field>
      <field name="文章正文" id="vc_content"><![CDATA[<p>示例正文</p>]]></field>
    </InfoEntity>
  </InfoEntities>
</config>`

const xmlElements = (parent: Element, nodeName: string): Element[] =>
  Array.from({ length: parent.childNodes.length }, (_, index) => parent.childNodes.item(index)).filter(
    (node): node is Element => node !== null && node.nodeType === 1 && node.nodeName === nodeName
  )

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

  it('replaces XML 1.0 illegal characters without changing HTML markup', () => {
    const sanitizationTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <item source="">
    <html><![CDATA[]]></html>
    <plain></plain>
  </item>
</root>`
    const configured = configureXmlRecord(sanitizationTemplate, 'template.xml', '/root/item')
    configured.mappings.forEach((mapping) => {
      mapping.mode = 'page'
    })

    const output = renderXmlBatch(configured, [
      {
        sequence: 1,
        collectedAt: '2026-09-02T00:00:00.000Z',
        page: 1,
        itemIndex: 1,
        listUrl: 'https://example.com/list',
        detailUrl: 'https://example.com/detail',
        externalUrl: '',
        values: {
          '@source': '网页\u0000采集',
          html:
            '<p class="notice" style="color: red">9:00\u001e17:00\t中文 😀\n换行\r回车 ]]> 尾部</p>',
          plain: '正文\u000b分隔\ud800结束'
        }
      }
    ])

    expect(() => parseXml(output)).not.toThrow()
    for (const illegalCharacter of ['\u0000', '\u000b', '\u001e', '\ud800']) {
      expect(output).not.toContain(illegalCharacter)
    }
    expect(output).toContain('source="网页 采集"')
    expect(output).toContain(
      '<![CDATA[<p class="notice" style="color: red">9:00 17:00\t中文 😀\r\n换行\r回车 ]]'
    )
    expect(output).toContain(']]]]><![CDATA[>')

    const document = parseXml(output)
    const item = document.getElementsByTagName('item').item(0)!
    expect(item.getAttribute('source')).toBe('网页 采集')
    expect(document.getElementsByTagName('html').item(0)?.textContent).toBe(
      '<p class="notice" style="color: red">9:00 17:00\t中文 😀\n换行\n回车 ]]> 尾部</p>'
    )
    expect(document.getElementsByTagName('plain').item(0)?.textContent).toBe('正文 分隔 结束')
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

  it('uses field id values to identify repeated field elements', () => {
    const tree = inspectXmlTree(idFieldTemplate)
    const entityNode = tree[0]?.children
      .find((node) => node.name === 'InfoEntities')
      ?.children.find((node) => node.name === 'InfoEntity')
    expect(entityNode?.children.map((node) => [node.name, node.path])).toEqual([
      ['title', '/config/InfoEntities/InfoEntity/field[@id="title"]'],
      ['sectitle', '/config/InfoEntities/InfoEntity/field[@id="sectitle"]'],
      ['vc_attach', '/config/InfoEntities/InfoEntity/field[@id="vc_attach"]'],
      ['vc_content', '/config/InfoEntities/InfoEntity/field[@id="vc_content"]']
    ])

    const configured = configureXmlRecord(
      idFieldTemplate,
      '中央动态.xml',
      '/config/InfoEntities/InfoEntity'
    )
    expect(
      configured.fields.map((field) => [field.name, field.label, field.path, field.cdata])
    ).toEqual([
      ['title', '信息标题', 'field[@id="title"]', false],
      ['sectitle', '信息副标题', 'field[@id="sectitle"]', false],
      ['vc_attach', '附件', 'field[@id="vc_attach"]', true],
      ['vc_content', '文章正文', 'field[@id="vc_content"]', true]
    ])
    expect(new Set(configured.mappings.map((mapping) => mapping.fieldPath)).size).toBe(4)

    configured.mappings.forEach((mapping) => {
      mapping.mode = ['field[@id="title"]', 'field[@id="vc_content"]'].includes(
        mapping.fieldPath
      )
        ? 'page'
        : 'preserve'
    })
    configured.fields.find((field) => field.name === 'title')!.cdata = true
    configured.fields.find((field) => field.name === 'vc_content')!.cdata = false
    const output = renderXmlBatch(configured, [
      {
        sequence: 1,
        collectedAt: '2026-08-18T00:00:00.000Z',
        page: 1,
        itemIndex: 1,
        listUrl: 'https://example.com/list',
        detailUrl: 'https://example.com/detail/1',
        externalUrl: '',
        values: {
          'field[@id="title"]': '第一条标题',
          'field[@id="vc_content"]': '<p>第一条正文</p>'
        }
      },
      {
        sequence: 2,
        collectedAt: '2026-08-18T00:00:01.000Z',
        page: 1,
        itemIndex: 2,
        listUrl: 'https://example.com/list',
        detailUrl: 'https://example.com/detail/2',
        externalUrl: '',
        values: {
          'field[@id="title"]': '第二条标题',
          'field[@id="vc_content"]': '<p>第二条正文</p>'
        }
      }
    ])

    const document = parseXml(output)
    const entities = Array.from(
      { length: document.getElementsByTagName('InfoEntity').length },
      (_, index) => document.getElementsByTagName('InfoEntity').item(index)
    ).filter((node): node is Element => node !== null)
    expect(entities).toHaveLength(2)
    expect(
      entities.map((entity) => {
        const fields = xmlElements(entity, 'field')
        const title = fields.find((field) => field.getAttribute('id') === 'title')!
        const content = fields.find((field) => field.getAttribute('id') === 'vc_content')!
        return {
          title: title.textContent,
          titleName: title.getAttribute('name'),
          titleNodeType: title.firstChild?.nodeType,
          content: content.textContent,
          contentName: content.getAttribute('name'),
          contentNodeType: content.firstChild?.nodeType
        }
      })
    ).toEqual([
      {
        title: '第一条标题',
        titleName: '信息标题',
        titleNodeType: 4,
        content: '<p>第一条正文</p>',
        contentName: '文章正文',
        contentNodeType: 3
      },
      {
        title: '第二条标题',
        titleName: '信息标题',
        titleNodeType: 4,
        content: '<p>第二条正文</p>',
        contentName: '文章正文',
        contentNodeType: 3
      }
    ])
  })

  it('rejects repeated field elements without unique id values', () => {
    expect(() =>
      configureXmlRecord(
        '<root><item><field id="same">一</field><field id="same">二</field></item></root>',
        'duplicate.xml',
        '/root/item'
      )
    ).toThrow('同名 field 节点必须具有非空且唯一的 id')
    expect(() =>
      configureXmlRecord(
        '<root><item><field id="first">一</field><field>二</field></item></root>',
        'missing.xml',
        '/root/item'
      )
    ).toThrow('同名 field 节点必须具有非空且唯一的 id')
  })
})
