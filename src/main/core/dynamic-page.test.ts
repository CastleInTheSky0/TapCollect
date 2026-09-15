import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  readDynamicDetailRenderState,
  isReadyDynamicPageChange,
  resolveDynamicDetailClick,
  resolveDynamicDomAction
} from './dynamic-page'

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

  it('clicks a configured target relative to the requested repeated list item', () => {
    const dom = new JSDOM(
      '<main><div class="item"><span class="name">甲</span></div>' +
        '<div class="item"><span class="name">乙</span></div></main>'
    )
    const listener = vi.fn()
    dom.window.document.querySelectorAll('.name')[1]!.addEventListener('click', listener)

    expect(resolveDynamicDetailClick(dom.window.document, css('.item'), css('.name'), 1))
      .toEqual({ kind: 'clicked' })
    expect(listener).toHaveBeenCalledOnce()
    expect(resolveDynamicDetailClick(dom.window.document, css('.item'), css('.missing'), 0))
      .toEqual({ kind: 'error', reason: '当前列表项中找不到详情点击元素' })

    const itemListener = vi.fn()
    dom.window.document.querySelector('.item')!.addEventListener('click', itemListener)
    expect(resolveDynamicDetailClick(dom.window.document, css('.item'), css(':scope'), 0))
      .toEqual({ kind: 'clicked' })
    expect(itemListener).toHaveBeenCalledOnce()
  })

  it('counts CSS, XPath, and marker locators used to detect a same-page detail render', () => {
    const dom = new JSDOM(
      '<main><div id="detail"><p>正文</p></div><!--开始-->\n<section>内容</section>\n<!--结束--></main>',
      { runScripts: 'outside-only' }
    )

    expect(
      readDynamicDetailRenderState(dom.window.document, [
        css('#detail'),
        { selectorType: 'xpath', selector: '//div[@id="detail"]/p' },
        {
          selectorType: 'markers',
          selector: '',
          startMarker: '<!--开始-->\r\n',
          endMarker: '\r\n<!--结束-->'
        }
      ])
    ).toMatchObject({ matchCount: 3, populatedCount: 3 })

    const serialized = dom.window.eval(
      `(${readDynamicDetailRenderState.toString()})`
    ) as typeof readDynamicDetailRenderState
    expect(
      serialized(dom.window.document, [
        {
          selectorType: 'markers',
          selector: '',
          startMarker: '<!--开始-->\r\n',
          endMarker: '\r\n<!--结束-->'
        }
      ])
    ).toMatchObject({ matchCount: 1, populatedCount: 1 })
  })

  it('waits for populated values rather than empty skeleton elements', () => {
    const dom = new JSDOM('<h1></h1><main><script>placeholder()</script></main><img>')
    const selectors = [css('h1'), css('main'), { ...css('img'), extraction: 'attribute' as const, attribute: 'src' }]
    const skeleton = readDynamicDetailRenderState(dom.window.document, selectors)
    expect(skeleton).toMatchObject({ matchCount: 3, populatedCount: 0 })
    dom.window.document.querySelector('h1')!.textContent = '标题'
    const partial = readDynamicDetailRenderState(dom.window.document, selectors)
    expect(partial.populatedCount).toBe(1)
    dom.window.document.querySelector('main')!.textContent = '延迟正文'
    dom.window.document.querySelector('img')!.setAttribute('src', '/photo.png')
    const ready = readDynamicDetailRenderState(dom.window.document, selectors)
    expect(ready.populatedCount).toBe(3)
    expect(ready.signature).not.toBe(partial.signature)
  })

  it('supports attribute XPath values and HTML-only content without confusing first/all matches', () => {
    const dom = new JSDOM('<div><img src="/photo.png"></div><p></p><p>第二个</p>')
    expect(readDynamicDetailRenderState(dom.window.document, [
      { selectorType: 'xpath', selector: '//img/@src' },
      { ...css('div'), extraction: 'html' },
      css('p'),
      { ...css('p'), matchMode: 'all' },
      css('.missing')
    ])).toMatchObject({ matchCount: 6, populatedCount: 3 })
  })

  it('does not treat marker text skeletons or script bodies as rendered values', () => {
    const dom = new JSDOM('<body><!--begin--><p></p><script>loading()</script><!--end--></body>', { runScripts: 'outside-only' })
    const selectors = [{
      selectorType: 'markers' as const,
      selector: '',
      startMarker: '<!--begin-->',
      endMarker: '<!--end-->',
      extraction: 'text' as const
    }]
    const serialized = dom.window.eval(`(${readDynamicDetailRenderState.toString()})`) as typeof readDynamicDetailRenderState
    expect(serialized(dom.window.document, selectors)).toMatchObject({ matchCount: 1, populatedCount: 0 })
    dom.window.document.querySelector('p')!.textContent = '延迟正文'
    expect(serialized(dom.window.document, selectors)).toMatchObject({ matchCount: 1, populatedCount: 1 })
  })
})
