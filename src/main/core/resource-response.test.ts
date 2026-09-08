import { describe, expect, it } from 'vitest'
import { resourceErrorPageReason, resourceResponseHtml } from './resource-response'

describe('resource response inspection', () => {
  it.each(['404错误提示', '404 Not Found', 'HTTP Error 400', '500 Internal Server Error', '页面不存在'])('recognizes the error page title %s', (title) => {
    expect(resourceErrorPageReason(`<html><title>${title}</title><body>文件无法下载</body></html>`)).toContain('资源返回错误提示页面')
  })

  it('recognizes a short missing-page message without a title and ignores scripts', () => {
    expect(resourceErrorPageReason('<html><body><script>analytics()</script>您访问的页面未找到，5秒后自动跳转到首页</body></html>')).toContain('页面未找到')
  })

  it('allows ordinary HTML documents that discuss errors or retain valid Word content', () => {
    expect(resourceErrorPageReason('<html><title>网络状态码说明</title><body><p>404 Not Found 表示页面不存在。</p></body></html>')).toBeNull()
    expect(resourceErrorPageReason('<html><head><meta name="ProgId" content="Word.Document"><title>申请表</title></head><body>姓名：____</body></html>')).toBeNull()
    expect(resourceResponseHtml(Buffer.from('%PDF-1.7\n<html><title>404错误提示</title>'), 'application/pdf', '')).toBeNull()
  })

  it('sniffs HTML returned with a binary or missing content type', () => {
    const html = '<html><title>404 Not Found</title></html>'
    expect(resourceResponseHtml(Buffer.from(`\uFEFF \n${html}`), 'application/msword', '')).toContain(html)
    expect(resourceResponseHtml(Buffer.from(html), null, '')).toBe(html)
    expect(resourceResponseHtml(Buffer.from('<h1>404 Not Found</h1>'), 'application/xhtml+xml', '')).toContain('404 Not Found')
  })
})
