import { JSDOM } from 'jsdom'
import type { RequestConfig } from '@shared/types'
import { decodeHtml } from './http-client'

export const resourceResponseHtml = (
  buffer: Buffer,
  contentType: string | null,
  encoding: RequestConfig['manualEncoding']
): string | null => {
  const prefix = buffer.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart()
  const htmlType = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType ?? '')
  // 老下载地址可能把错误网页标为二进制；只嗅探正文开头，避免扫描文件内的 HTML 示例。
  if (!htmlType && !/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<title\b)/i.test(prefix)) return null
  return decodeHtml(buffer, contentType, encoding).html
}

export const resourceErrorPageReason = (html: string): string | null => {
  const dom = new JSDOM(html)
  try {
    const document = dom.window.document
    document.querySelectorAll('script, style, noscript').forEach(node => node.remove())
    const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
    const title = normalize(document.title || document.querySelector('h1, h2')?.textContent || '')
    const body = normalize(document.body?.textContent ?? '')
    const statusTitle = /^(?:(?:http(?:\s+error)?|error)\s*)?(?:400|404|410|500|502|503|504)\s*(?:(?:[-:：|]\s*)?(?:error|not found|bad request|gone|internal server error|bad gateway|service unavailable|gateway timeout|错误|页面不存在|页面未找到).*)?$/i
    const missingPage = /^(?:(?:您|你)(?:访问|请求|下载)的)?(?:网页|页面|文件|资源)(?:不存在|未找到|已删除|已移除|无法找到|找不到)|^(?:(?:the|requested)\s+)?(?:page|file|resource)\s+(?:was\s+)?not\s+found\b/i
    if (statusTitle.test(title) || missingPage.test(title) || (body.length < 1000 && missingPage.test(body))) {
      return `资源返回错误提示页面：${(title || body).slice(0, 120)}`
    }
    return null
  } finally { dom.window.close() }
}
