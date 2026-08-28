import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolvePreviewSelection, type PreviewSelection } from './preview-selector'

const createListDocument = (): Document => {
  const rows = [1, 2, 3]
    .map(
      (index) => `
        <tr>
          <td>
            <div class="ListItem">
              <div class="NoWrapHidden ListItemTitle">
                <img src="bullet.png" alt="">
                <a href="/detail/${index}">标题 ${index}</a>
              </div>
              <div class="ListItemDate">[2026-08-0${index}]</div>
            </div>
            <div class="DottedSep"></div>
          </td>
        </tr>`
    )
    .join('')
  return new JSDOM(`<table id="gvMain"><tbody>${rows}</tbody></table>`).window.document
}

describe('preview selector resolution', () => {
  it('selects the same repeated row when any list title is clicked', () => {
    const document = createListDocument()
    const titles = Array.from(document.querySelectorAll('.ListItemTitle a'))
    const results = titles.map((title) => resolvePreviewSelection(title, ''))

    expect(new Set(results.map((result) => result.selector))).toEqual(
      new Set(['#gvMain > tbody > tr'])
    )
    results.forEach((result) => expect(result.matches).toHaveLength(3))
  })

  it('creates reusable relative selectors for fields in different rows and columns', () => {
    const document = createListDocument()
    const base = resolvePreviewSelection(document.querySelectorAll('.ListItemTitle a')[1]!, '')
    const firstTitle = resolvePreviewSelection(
      document.querySelectorAll('.ListItemTitle a')[0]!,
      base.selector
    )
    const lastTitle = resolvePreviewSelection(
      document.querySelectorAll('.ListItemTitle a')[2]!,
      base.selector
    )
    const middleDate = resolvePreviewSelection(
      document.querySelectorAll('.ListItemDate')[1]!,
      base.selector
    )

    expect(firstTitle.selector).toBe(lastTitle.selector)
    expect(firstTitle.matches).toHaveLength(3)
    expect(middleDate.matches).toHaveLength(3)
    expect(firstTitle.selector).not.toContain('tr:nth-of-type')
    expect(middleDate.selector).not.toContain('tr:nth-of-type')
  })

  it('uses column positions relative to every repeated row', () => {
    const document = new JSDOM(`
      <table id="results"><tbody>
        <tr><td><a href="/1">甲</a></td><td><span>日期甲</span></td></tr>
        <tr><td><a href="/2">乙</a></td><td><span>日期乙</span></td></tr>
        <tr><td><a href="/3">丙</a></td><td><span>日期丙</span></td></tr>
      </tbody></table>
    `).window.document
    const base = resolvePreviewSelection(document.querySelectorAll('a')[1]!, '')
    const date = resolvePreviewSelection(document.querySelectorAll('td:nth-child(2) span')[1]!, base.selector)

    expect(base.selector).toBe('#results > tbody > tr')
    expect(date.selector).toBe('td:nth-of-type(2) > span')
    expect(date.matches.map((element) => element.textContent)).toEqual(['日期甲', '日期乙', '日期丙'])
  })

  it('selects repeated records when the list range itself is clicked', () => {
    const document = new JSDOM(`
      <div id="content-area">
        <span class="zi_left">
          <div class="nr"><dl><dt><a href="/1">公告一</a></dt><dt>日期一</dt></dl><div class="cl"></div></div>
          <div class="nr"><dl><dt><a href="/2">公告二</a></dt><dt>日期二</dt></dl><div class="cl"></div></div>
          <div class="nr"><dl><dt><a href="/3">公告三</a></dt><dt>日期三</dt></dl><div class="cl"></div></div>
          <div class="spacing"></div>
          <ul class="pages"><li><a href="/page/1">1</a></li><li><a href="/page/2">2</a></li></ul>
        </span>
      </div>
    `).window.document

    const range = resolvePreviewSelection(document.querySelector('.zi_left')!, '')
    const wrapper = resolvePreviewSelection(document.querySelector('#content-area')!, '')

    expect(range.selector).toBe('#content-area > .zi_left > .nr')
    expect(wrapper.selector).toBe(range.selector)
    expect(range.matches.map((element) => element.querySelector('a')?.textContent)).toEqual([
      '公告一',
      '公告二',
      '公告三'
    ])
    expect(wrapper.matches).toHaveLength(3)
  })

  it('selects direct list children when an ul or table body is clicked', () => {
    const document = new JSDOM(`
      <ul id="articles"><li><a href="/1">甲</a></li><li><a href="/2">乙</a></li></ul>
      <table id="records"><tbody><tr><td>一</td></tr><tr><td>二</td></tr></tbody></table>
    `).window.document

    const list = resolvePreviewSelection(document.querySelector('#articles')!, '')
    const tableBody = resolvePreviewSelection(document.querySelector('#records tbody')!, '')

    expect(list.selector).toBe('#articles > li')
    expect(list.matches).toHaveLength(2)
    expect(tableBody.selector).toBe('#records > tbody > tr')
    expect(tableBody.matches).toHaveLength(2)
  })

  it('selects a list-item root or nearest wrapping ancestor as the detail link', () => {
    const document = new JSDOM(`
      <div id="project">
        <a href="/detail/1"><li><h1>标题一</h1></li></a>
        <a href="/detail/2"><li><h1>标题二</h1></li></a>
        <a href="/detail/3"><li><h1>标题三</h1></li></a>
      </div>
      <div class="item"><a class="title" href="/detail/4"><span>标题四</span></a></div>
      <div class="item"><a class="title" href="/detail/5"><span>标题五</span></a></div>
    `).window.document
    const firstTitle = document.querySelector('#project h1')!

    const list = resolvePreviewSelection(firstTitle, '')
    const rootLink = resolvePreviewSelection(firstTitle, '#project > a', 'href')
    const wrappingLink = resolvePreviewSelection(firstTitle, '#project > a > li', 'href')
    const nestedLink = resolvePreviewSelection(
      document.querySelector('.item span')!,
      '.item',
      'href'
    )

    expect(list.selector).toBe('#project > a')
    expect(list.matches).toHaveLength(3)
    expect(rootLink.selector).toBe(':scope')
    expect(rootLink.matches).toHaveLength(3)
    expect(wrappingLink.selector).toBe('a[href]')
    expect(wrappingLink.matches).toHaveLength(3)
    expect(nestedLink.selector).toBe('.title[href]')
    expect(nestedLink.matches).toHaveLength(2)
  })

  it('keeps complete document paths and falls back to an exact selector without repetition', () => {
    const detailDocument = new JSDOM(
      '<main><div id="divContent"><p>详情正文</p></div></main>'
    ).window.document
    const detail = resolvePreviewSelection(detailDocument.querySelector('#divContent')!, ':root')
    expect(detail.selector).toBe('body > main > #divContent')
    expect(detail.matches).toHaveLength(1)

    const uniqueDocument = new JSDOM(
      '<section id="single"><span class="title">唯一内容</span></section>'
    ).window.document
    const unique = resolvePreviewSelection(uniqueDocument.querySelector('.title')!, '')
    expect(unique.selector).toBe('#single > .title')
    expect(unique.matches).toHaveLength(1)
  })

  it('writes every document layer from the nearest unique ID ancestor or body', () => {
    const document = new JSDOM(`
      <div class="details">直属正文</div>
      <section id="article-root">
        <div class="content-shell"><article><span class="details">嵌套正文</span></article></div>
      </section>
    `).window.document

    const direct = resolvePreviewSelection(document.querySelector('body > .details')!, ':root')
    const nested = resolvePreviewSelection(
      document.querySelector('#article-root .details')!,
      ':root'
    )

    expect(direct.selector).toBe('body > .details')
    expect(direct.matches).toEqual([document.querySelector('body > .details')])
    expect(nested.selector).toBe('#article-root > .content-shell > article > .details')
    expect(nested.matches).toEqual([document.querySelector('#article-root .details')])
  })

  it('uses a globally repeated target ID as a local segment under a unique ancestor', () => {
    const pager = (id: string): string => `
      <div id="${id}">
        <button>首页</button><button>上一页</button>
        <button>1</button><button>2</button><button>3</button>
        <button>4</button><button>5</button><button>尾页</button>
        <button>更多</button><button id="nextPage">下一页</button>
      </div>`
    const document = new JSDOM(
      `${pager('page_9')}${pager('page_10')}${pager('page_11')}`
    ).window.document

    const result = resolvePreviewSelection(
      document.querySelector('#page_11 > button#nextPage')!,
      ':root'
    )

    expect(document.querySelectorAll('#nextPage')).toHaveLength(3)
    expect(result.selector).toBe('#page_11 > button#nextPage')
    expect(result.matches).toEqual([
      document.querySelector('#page_11 > button#nextPage')
    ])
    expect(result.selector).not.toContain(':nth-of-type')
  })

  it('prefers reusable classes over per-record IDs for scoped list fields', () => {
    const document = new JSDOM(`
      <div class="item"><a id="title-1" class="title" href="/1">甲</a></div>
      <div class="item"><a id="title-2" class="title" href="/2">乙</a></div>
      <div class="item"><a id="title-3" class="title" href="/3">丙</a></div>
    `).window.document

    const result = resolvePreviewSelection(document.querySelector('#title-2')!, '.item')

    expect(result.selector).toBe('.title')
    expect(result.selector).not.toContain('#title-2')
    expect(result.matches).toHaveLength(3)
  })

  it('keeps every intermediate layer inside each list-item scope', () => {
    const document = new JSDOM(`
      <div class="item"><div class="meta"><span class="label"><a id="link-1" class="title">甲</a></span></div></div>
      <div class="item"><div class="meta"><span class="label"><a id="link-2" class="title">乙</a></span></div></div>
      <div class="item"><div class="meta"><span class="label"><a id="link-3" class="title">丙</a></span></div></div>
    `).window.document

    const result = resolvePreviewSelection(document.querySelector('#link-2')!, '.item')

    expect(result.selector).toBe('.meta > .label > .title')
    expect(result.selector).not.toContain('#link-2')
    expect(result.matches.map((element) => element.textContent)).toEqual(['甲', '乙', '丙'])
  })

  it('widens a labelled text field selector beyond its current sibling position', () => {
    const document = new JSDOM(`
      <h2 id="metadata">
        <span>作者：周锋生</span>
        <span>来源：海外侨声</span>
        <span>发布时间：2019-07-08</span>
      </h2>
    `).window.document
    const target = document.querySelectorAll('#metadata > span')[2]!

    const exact = resolvePreviewSelection(target, ':root')
    const generalized = resolvePreviewSelection(target, ':root', '', true)

    expect(exact.selector).toBe('#metadata > span:nth-of-type(3)')
    expect(generalized.selector).toBe('#metadata > span')
    expect(generalized.matches).toHaveLength(3)
  })

  it('rejects list-field picks outside the configured list-item scope', () => {
    const detailDocument = new JSDOM(
      '<main><h1 class="title">详情标题</h1><div id="content">详情正文</div></main>'
    ).window.document

    expect(() =>
      resolvePreviewSelection(detailDocument.querySelector('.title')!, '#results > li')
    ).toThrow('当前点击位置不在已配置的列表项范围内')
    expect(() =>
      resolvePreviewSelection(detailDocument.querySelector('.title')!, '[')
    ).toThrow('列表项范围选择器无效')
  })

  it('can run from the serialized function used by the isolated preview page', () => {
    const document = createListDocument()
    const runtime = new Function(
      'target',
      'scopeSelector',
      `return (${resolvePreviewSelection.toString()})(target, scopeSelector)`
    ) as (target: Element, scopeSelector: string) => PreviewSelection

    const result = runtime(document.querySelectorAll('.ListItemDate')[2]!, '')
    const rangeResult = runtime(document.querySelector('#gvMain tbody')!, '')
    expect(result.selector).toBe('#gvMain > tbody > tr')
    expect(result.matches).toHaveLength(3)
    expect(rangeResult.selector).toBe('#gvMain > tbody > tr')
    expect(rangeResult.matches).toHaveLength(3)
  })

  it('keeps text-position generalization self-contained after serialization', () => {
    const document = new JSDOM(
      '<h2 id="metadata"><span>作者：甲</span><span>发布时间：2026-08-12</span></h2>'
    ).window.document
    const runtime = new Function(
      'target',
      `return (${resolvePreviewSelection.toString()})(target, ':root', '', true)`
    ) as (target: Element) => PreviewSelection

    const result = runtime(document.querySelectorAll('#metadata > span')[1]!)
    expect(result.selector).toBe('#metadata > span')
    expect(result.matches).toHaveLength(2)
  })
})
