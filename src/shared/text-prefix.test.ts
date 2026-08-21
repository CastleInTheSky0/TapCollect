import { describe, expect, it } from 'vitest'
import {
  detectTextPrefix,
  normalizeTextPrefix,
  stripTextPrefix,
  textMatchesPrefix
} from './text-prefix'

describe('text prefix helpers', () => {
  it('normalizes a manually entered Chinese or English colon suffix', () => {
    expect(normalizeTextPrefix(' 发布时间： ')).toBe('发布时间')
    expect(normalizeTextPrefix('来源:')).toBe('来源')
    expect(normalizeTextPrefix(undefined)).toBe('')
  })

  it('detects short label-value text without guessing URLs or empty values', () => {
    expect(detectTextPrefix('发布时间：2026-08-12')).toBe('发布时间')
    expect(detectTextPrefix(' 来源: 海外侨声 ')).toBe('来源')
    expect(detectTextPrefix('https://example.com')).toBe('')
    expect(detectTextPrefix('来源：')).toBe('')
  })

  it('matches both colon styles and strips only the configured label', () => {
    expect(textMatchesPrefix(' 发布时间：2026-08-12 ', '发布时间：')).toBe(true)
    expect(textMatchesPrefix('发布时间: 2019-07-08', '发布时间')).toBe(true)
    expect(textMatchesPrefix('来源：海外侨声', '发布时间')).toBe(false)
    expect(stripTextPrefix(' 发布时间： 2026-08-12 ', '发布时间')).toBe('2026-08-12')
    expect(stripTextPrefix('来源：海外侨声', '发布时间')).toBe('来源：海外侨声')
  })

  it('does not treat unsupported connectors as labelled-field separators', () => {
    expect(detectTextPrefix('作者-省侨联')).toBe('')
    expect(textMatchesPrefix('作者-省侨联', '作者-')).toBe(false)
    expect(textMatchesPrefix('来源=海外侨声', '来源')).toBe(false)
    expect(stripTextPrefix('作者-省侨联', '作者-')).toBe('作者-省侨联')
  })

  it('separates arbitrary labelled fields stored inside one element', () => {
    const combined = `
      作者：省侨联
      发布时间：2026-08-12
    `

    expect(textMatchesPrefix(combined, '作者')).toBe(true)
    expect(textMatchesPrefix(combined, '发布时间')).toBe(true)
    expect(stripTextPrefix(combined, '作者')).toBe('省侨联')
    expect(stripTextPrefix(combined, '发布时间')).toBe('2026-08-12')
  })

  it('keeps colons inside values and stops at the next whitespace-delimited label', () => {
    const combined = '自定义来源：https://example.com/path 发布时间：2026-08-12 12:30'

    expect(stripTextPrefix(combined, '自定义来源')).toBe('https://example.com/path')
    expect(stripTextPrefix(combined, '发布时间')).toBe('2026-08-12 12:30')
  })
})
