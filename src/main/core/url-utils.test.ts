import { describe, expect, it } from 'vitest'
import {
  buildPageUrl,
  detectPaginationParameters,
  hasSameHostname,
  normalizeUrl,
  resolveHttpUrl,
  sanitizeFileName
} from './url-utils'

describe('url utilities', () => {
  it('detects an integer pagination parameter', () => {
    const result = detectPaginationParameters(
      'https://www.example.com/articles?category=2&pageNumber=1'
    )
    expect(result).toContainEqual({
      name: 'pageNumber',
      value: '1',
      template: 'https://www.example.com/articles?category=2&pageNumber={page}'
    })
  })

  it('builds a page URL', () => {
    expect(buildPageUrl('https://example.com/list?page={page}', 8)).toBe(
      'https://example.com/list?page=8'
    )
  })

  it('normalizes fragments and default ports', () => {
    expect(normalizeUrl('https://EXAMPLE.com:443/a?q=1#part')).toBe(
      'https://example.com/a?q=1'
    )
  })

  it('compares the full hostname only', () => {
    expect(hasSameHostname('https://www.example.com/a', 'http://www.example.com:8080/b')).toBe(true)
    expect(hasSameHostname('https://www.example.com', 'https://news.example.com')).toBe(false)
  })

  it('resolves only HTTP links', () => {
    expect(resolveHttpUrl('../a.html', 'https://example.com/news/list.html')).toBe(
      'https://example.com/a.html'
    )
    expect(resolveHttpUrl('mailto:test@example.com', 'https://example.com')).toBe('')
  })

  it('creates file names that are valid on Windows', () => {
    expect(sanitizeFileName('新闻:列表. ')).toBe('新闻_列表_')
    expect(sanitizeFileName('CON')).toBe('_CON')
  })
})
