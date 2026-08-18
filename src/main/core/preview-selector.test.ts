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

    expect(range.selector).toBe('#content-area > span.zi_left > div.nr')
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
    expect(nestedLink.selector).toBe('a.title[href]')
    expect(nestedLink.matches).toHaveLength(2)
  })

  it('keeps document fields concise and falls back to an exact selector without repetition', () => {
    const detailDocument = new JSDOM(
      '<main><div id="divContent"><p>详情正文</p></div></main>'
    ).window.document
    const detail = resolvePreviewSelection(detailDocument.querySelector('#divContent')!, ':root')
    expect(detail.selector).toBe('#divContent')
    expect(detail.matches).toHaveLength(1)

    const uniqueDocument = new JSDOM(
      '<section id="single"><span class="title">唯一内容</span></section>'
    ).window.document
    const unique = resolvePreviewSelection(uniqueDocument.querySelector('.title')!, '')
    expect(unique.selector).toBe('#single > span.title')
    expect(unique.matches).toHaveLength(1)
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
})
