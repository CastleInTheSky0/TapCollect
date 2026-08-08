import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { isReadyDynamicPageChange, resolveDynamicDomAction } from './dynamic-page'

const css = (selector: string) => ({ selectorType: 'css' as const, selector })

describe('dynamic page DOM actions', () => {
  it('waits through a transient empty list before accepting a rendered page change', () => {
    const previous = {
      html: '<main><div class="item">第一页</div></main>',
      url: 'https://example.com/list',
      itemCount: 1,
      signature: '1:first'
    }

    expect(
      isReadyDynamicPageChange(previous, {
        html: '<main></main>',
        url: previous.url,
        itemCount: 0,
        signature: '0:empty'
      })
    ).toBe(false)
    expect(isReadyDynamicPageChange(previous, previous)).toBe(false)
    expect(
      isReadyDynamicPageChange(previous, {
        html: '<main><div class="item">第二页</div></main>',
        url: previous.url,
        itemCount: 1,
        signature: '1:second'
      })
    ).toBe(true)
  })

  it('creates a stable list signature and detects rendered list changes', () => {
    const dom = new JSDOM(
      '<main><div class="item">第一页</div><a class="next">下一页</a></main>',
      { url: 'https://example.com/list' }
    )

    const first = resolveDynamicDomAction(
      dom.window.document,
      'snapshot',
      css('.item'),
      css('.next'),
      dom.window.location.href
    )
    dom.window.document.querySelector('.item')!.textContent = '第二页'
    const second = resolveDynamicDomAction(
      dom.window.document,
      'snapshot',
      css('.item'),
      css('.next'),
      dom.window.location.href
    )

    expect(first.kind).toBe('snapshot')
    expect(second.kind).toBe('snapshot')
    if (first.kind !== 'snapshot' || second.kind !== 'snapshot') return
    expect(first.itemCount).toBe(1)
    expect(first.signature).not.toBe(second.signature)
    expect(second.html).toContain('第二页')
  })

  it('supports XPath list selectors and clicks an enabled next button', () => {
    const dom = new JSDOM(
      '<main><div class="item">记录</div><button class="next">下一页</button></main>',
      { url: 'https://example.com/list' }
    )
    const listener = vi.fn()
    dom.window.document.querySelector('.next')!.addEventListener('click', listener)

    const snapshot = resolveDynamicDomAction(
      dom.window.document,
      'snapshot',
      { selectorType: 'xpath', selector: '//div[@class="item"]' },
      css('.next'),
      dom.window.location.href
    )
    const clicked = resolveDynamicDomAction(
      dom.window.document,
      'click',
      css('.item'),
      css('.next'),
      dom.window.location.href
    )

    expect(snapshot).toMatchObject({ kind: 'snapshot', itemCount: 1 })
    expect(clicked).toEqual({ kind: 'clicked' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('ends when the next button is missing or has a disabled class', () => {
    const missing = new JSDOM('<main><div class="item">记录</div></main>')
    expect(
      resolveDynamicDomAction(
        missing.window.document,
        'click',
        css('.item'),
        css('.next'),
        missing.window.location.href
      )
    ).toEqual({ kind: 'end', reason: '页面中找不到下一页按钮' })

    const disabled = new JSDOM(
      '<main><div class="item">记录</div><a class="default_pgNextDisabled">下一页</a></main>'
    )
    expect(
      resolveDynamicDomAction(
        disabled.window.document,
        'click',
        css('.item'),
        css('.default_pgNextDisabled'),
        disabled.window.location.href
      )
    ).toEqual({ kind: 'end', reason: '下一页按钮已禁用' })
  })

  it('keeps the DOM action self-contained when serialized into an isolated page', () => {
    const dom = new JSDOM('<main><div class="item">记录</div></main>', {
      url: 'https://example.com/list',
      runScripts: 'outside-only'
    })
    const serialized = dom.window.eval(`(${resolveDynamicDomAction.toString()})`) as typeof resolveDynamicDomAction

    expect(
      serialized(
        dom.window.document,
        'snapshot',
        css('.item'),
        css('.next'),
        dom.window.location.href
      )
    ).toMatchObject({ kind: 'snapshot', itemCount: 1 })
  })
})
