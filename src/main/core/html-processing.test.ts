import { describe, expect, it } from 'vitest'
import { processHtml } from './html-processing'

describe('processHtml', () => {
  it('cleans unsafe markup, removes attachment previews and rewrites resources', () => {
    const output = processHtml(
      '<!--x--><script>alert(1)</script><a onclick="x()" href="/a.docx">附件</a>' +
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
    expect(output).not.toContain('onclick')
    expect(output).not.toContain('iframe')
    expect(output).toContain('href="/target/a.docx"')
    expect(output).toContain('data-src="/target/image.jpg"')
  })
})
