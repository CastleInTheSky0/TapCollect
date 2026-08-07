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

  it('can run from the serialized function used by the isolated preview page', () => {
    const document = createListDocument()
    const runtime = new Function(
      'target',
      'scopeSelector',
      `return (${resolvePreviewSelection.toString()})(target, scopeSelector)`
    ) as (target: Element, scopeSelector: string) => PreviewSelection

    const result = runtime(document.querySelectorAll('.ListItemDate')[2]!, '')
    expect(result.selector).toBe('#gvMain > tbody > tr')
    expect(result.matches).toHaveLength(3)
  })
})
