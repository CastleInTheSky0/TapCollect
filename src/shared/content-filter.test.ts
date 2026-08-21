import { describe, expect, it } from 'vitest'
import {
  CONTENT_FILTER_SELECTOR_PRESETS,
  normalizeContentFilterSelectors,
  splitContentFilterInput
} from './content-filter'

describe('content filter configuration', () => {
  it('normalizes selectors without changing their order or case', () => {
    expect(normalizeContentFilterSelectors([' h1 ', '.Share', 'h1', '', 1])).toEqual([
      'h1',
      '.Share'
    ])
  })

  it('splits comma-completed selectors from the pending input', () => {
    expect(splitContentFilterInput('h1, .share, #ad')).toEqual({
      selectors: ['h1', '.share'],
      pending: '#ad'
    })
    expect(splitContentFilterInput('font,')).toEqual({ selectors: ['font'], pending: '' })
    expect(splitContentFilterInput('div.tools')).toEqual({
      selectors: [],
      pending: 'div.tools'
    })
  })

  it('contains the confirmed common tag presets', () => {
    expect(CONTENT_FILTER_SELECTOR_PRESETS).toEqual(
      expect.arrayContaining(['h1', 'h2', 'h3', 'font', 'img', 'video', 'footer'])
    )
  })
})
