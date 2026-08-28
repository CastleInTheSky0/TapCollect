import { describe, expect, it } from 'vitest'
import { createTask } from '@shared/defaults'
import {
  processAttributeValue,
  processHtml,
  processHtmlWithResources
} from './html-processing'

describe('processHtml', () => {
  it('cleans unsafe markup, removes attachment previews and rewrites resources', () => {
    const output = processHtml(
      '<!--x--><script>alert(1)</script><noscript>请启用脚本</noscript>' +
        '<a onclick="x()" href="/a.docx">附件</a>' +
        '<a href="java\nscript:window.print()">打印</a>' +
        '<img data-src="/image.jpg"><iframe src="DocView.aspx?x=1"></iframe>',
      'https://example.com/news/1.html',
      {
        cleanHtml: true,
        absolutizeResources: true,
        customResourceAttributes: []
      },
      [{ id: '1', from: 'https://example.com/', to: '/target/' }]
    )

    expect(output).not.toContain('script')
    expect(output).not.toContain('alert(1)')
    expect(output).not.toContain('请启用脚本')
    expect(output).not.toContain('onclick')
    expect(output).not.toContain('window.print')
    expect(output).not.toContain('iframe')
    expect(output).toContain('href="/target/a.docx"')
    expect(output).toContain('data-src="/target/image.jpg"')
  })

  it('drops executable attribute values but preserves normal resource values', () => {
    expect(
      processAttributeValue(
        'javascript:window.close()',
        'https://example.com/news/1.html',
        true,
        []
      )
    ).toBe('')
    expect(
      processAttributeValue('/files/a.pdf', 'https://example.com/news/1.html', true, [])
    ).toBe('https://example.com/files/a.pdf')
  })

  it('plans same-host resources, rewrites them to the download prefix and preserves external URLs', () => {
    const task = createTask('resource-task')
    task.resources.download.enabled = true
    task.resources.download.rootDirectory = 'D:/resource-root'
    task.resources.download.urlPrefix = '/resources'
    const result = processHtmlWithResources(
      '<img src="/images/a.jpg?size=small">' +
        '<a href="/files/a.pdf">附件</a>' +
        '<a href="/news/2.html">普通链接</a>' +
        '<img src="https://cdn.example.com/a.jpg">' +
        '<video><source src="/media/a.mp4"></video>',
      'https://www.example.com/news/1.html',
      'https://www.example.com/news/1.html',
      task
    )

    expect(result.value).toMatch(/src="\/resources\/images\/a__[a-f0-9]{8}\.jpg"/)
    expect(result.value).toContain('href="/resources/files/a.pdf"')
    expect(result.value).toContain('href="https://www.example.com/news/2.html"')
    expect(result.value).toContain('src="https://cdn.example.com/a.jpg"')
    expect(result.value).toContain('src="/resources/media/a.mp4"')
    expect(result.resources).toHaveLength(3)
  })

  it('preserves mixed-case extensions across downloaded paths and rewritten URLs', () => {
    const task = createTask('resource-extension-case-task')
    task.resources.download.enabled = true
    task.resources.download.rootDirectory = 'D:/resource-root'
    task.resources.download.urlPrefix = '/resources'

    const result = processHtmlWithResources(
      '<a href="/files/Report.PDF">附件</a>',
      'https://www.example.com/news/1.html',
      'https://www.example.com/news/1.html',
      task
    )

    expect(result.value).toContain('href="/resources/files/Report.PDF"')
    expect(result.resources[0]).toMatchObject({
      sourceUrl: 'https://www.example.com/files/Report.PDF',
      relativePath: 'files/Report.PDF',
      xmlUrl: '/resources/files/Report.PDF'
    })
    expect(result.resources[0]?.localPath.replaceAll('\\', '/')).toMatch(
      /\/files\/Report\.PDF$/
    )
  })

  it('applies URL encoding only to recognized file-resource paths', () => {
    const task = createTask('resource-url-encoding-task')
    task.resources.download.enabled = true
    task.resources.download.rootDirectory = 'D:/resource-root'
    task.resources.download.urlPrefix = '/resources'
    const html =
      '<img src="/图片/封面.JPG">' +
      '<a href="/附件/会议材料.DOC">附件</a>' +
      '<a href="/新闻/中文页面.html">普通链接</a>'

    const readable = processHtmlWithResources(
      html,
      'https://www.example.com/news/1.html',
      'https://www.example.com/news/1.html',
      task
    )

    expect(readable.value).toContain('src="/resources/图片/封面.JPG"')
    expect(readable.value).toContain('href="/resources/附件/会议材料.DOC"')
    expect(readable.value).toContain(
      'href="https://www.example.com/%E6%96%B0%E9%97%BB/%E4%B8%AD%E6%96%87%E9%A1%B5%E9%9D%A2.html"'
    )

    task.resources.encodeUrls = true
    const encoded = processHtmlWithResources(
      html,
      'https://www.example.com/news/1.html',
      'https://www.example.com/news/1.html',
      task
    )
    expect(encoded.value).toContain(
      'src="/resources/%E5%9B%BE%E7%89%87/%E5%B0%81%E9%9D%A2.JPG"'
    )
    expect(encoded.value).toContain(
      'href="/resources/%E9%99%84%E4%BB%B6/%E4%BC%9A%E8%AE%AE%E6%9D%90%E6%96%99.DOC"'
    )
    expect(encoded.value).toContain(
      'href="https://www.example.com/%E6%96%B0%E9%97%BB/%E4%B8%AD%E6%96%87%E9%A1%B5%E9%9D%A2.html"'
    )
  })

  it('uses the same encoding switch in absolute-replace mode', () => {
    const task = createTask('absolute-resource-url-encoding-task')
    const html = '<img src="/图片/封面.jpg"><a href="/新闻/中文页面.html">普通链接</a>'

    const readable = processHtmlWithResources(
      html,
      'https://www.example.com/news/1.html',
      'https://www.example.com/news/1.html',
      task
    )
    expect(readable.value).toContain('src="https://www.example.com/图片/封面.jpg"')
    expect(readable.value).toContain(
      'href="https://www.example.com/%E6%96%B0%E9%97%BB/%E4%B8%AD%E6%96%87%E9%A1%B5%E9%9D%A2.html"'
    )

    task.resources.encodeUrls = true
    const encoded = processHtmlWithResources(
      html,
      'https://www.example.com/news/1.html',
      'https://www.example.com/news/1.html',
      task
    )
    expect(encoded.value).toContain(
      'src="https://www.example.com/%E5%9B%BE%E7%89%87/%E5%B0%81%E9%9D%A2.jpg"'
    )
  })

  it('supports prefix rewriting without downloading or applying legacy replacements', () => {
    const task = createTask('prefix-task')
    task.resources.addressMode = 'prefix'
    task.resources.urlPrefix = 'https://static.example.com/resources/'
    task.resourceReplacements = [
      { id: 'legacy', from: 'https://www.example.com/', to: '/legacy/' }
    ]
    const result = processHtmlWithResources(
      '<img src="/images/a.jpg?size=small"><a href="/news/2.html">下一条</a>',
      'https://www.example.com/news/1.html',
      'https://www.example.com/news/1.html',
      task
    )

    expect(result.value).toContain('src="https://static.example.com/resources/images/a.jpg"')
    expect(result.value).toContain('href="https://www.example.com/news/2.html"')
    expect(result.value).not.toContain('/legacy/')
    expect(result.resources).toEqual([])
  })

  it('keeps fragment-only style references without planning the current page as a resource', () => {
    const task = createTask('style-fragment-task')
    task.resources.download.enabled = true
    task.resources.download.rootDirectory = 'D:/resource-root'
    task.resources.download.urlPrefix = '/resources'

    const result = processHtmlWithResources(
      '<svg><rect style="fill:url(#gradient)"></rect></svg>',
      'https://www.example.com/news/1.html',
      'https://www.example.com/news/1.html',
      task
    )

    expect(result.value).toContain('fill:url(#gradient)')
    expect(result.resources).toEqual([])
  })
})
