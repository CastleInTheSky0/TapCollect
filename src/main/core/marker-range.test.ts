import { describe, expect, it } from 'vitest'
import { extractMarkerRanges } from './marker-range'

const config = (
  overrides: Partial<Parameters<typeof extractMarkerRanges>[1]> = {}
): Parameters<typeof extractMarkerRanges>[1] => ({
  startMarker: '<div class="details">',
  endMarker: '</div>\n<!--主体结束-->\n<br />\n<br />',
  includeMarkers: false,
  matchMode: 'first',
  separator: '|',
  ...overrides
})

describe('marker range extraction', () => {
  it('extracts the literal content between multiline markers', () => {
    const source =
      '<header>页头</header><div class="details"><p>正文</p></div>\n' +
      '<!--主体结束-->\n<br />\n<br /><footer>页尾</footer>'

    expect(extractMarkerRanges(source, config())).toEqual({
      value: '<p>正文</p>',
      matchCount: 1
    })
  })

  it('treats CRLF and LF line endings as the same while preserving source text', () => {
    const source =
      '<div class="details"><p>正文</p></div>\r\n' +
      '<!--主体结束-->\r\n<br />\r\n<br /><footer>页尾</footer>'

    expect(extractMarkerRanges(source, config())).toEqual({
      value: '<p>正文</p>',
      matchCount: 1
    })
    expect(extractMarkerRanges(source, config({ includeMarkers: true }))).toEqual({
      value:
        '<div class="details"><p>正文</p></div>\r\n' +
        '<!--主体结束-->\r\n<br />\r\n<br />',
      matchCount: 1
    })
    expect(
      extractMarkerRanges(
        source.replaceAll('\r\n', '\n'),
        config({ endMarker: '</div>\r\n<!--主体结束-->\r\n<br />\r\n<br />' })
      )
    ).toEqual({ value: '<p>正文</p>', matchCount: 1 })
    expect(
      extractMarkerRanges(
        source.replaceAll('\r\n', '\r'),
        config({ endMarker: '</div>\n<!--主体结束-->\n<br />\n<br />' })
      )
    ).toEqual({ value: '<p>正文</p>', matchCount: 1 })
  })

  it('keeps ordinary spaces, tabs, and indentation literal', () => {
    const source = '[start]\n  <!--注释-->\n\t正文[end]'
    expect(
      extractMarkerRanges(
        source,
        config({ startMarker: '[start]\n <!--注释-->', endMarker: '[end]' })
      )
    ).toEqual({ value: '', matchCount: 0 })
  })

  it('keeps both boundary markers when configured', () => {
    const source = 'before[start]value[end]after'
    expect(
      extractMarkerRanges(
        source,
        config({ startMarker: '[start]', endMarker: '[end]', includeMarkers: true })
      )
    ).toEqual({ value: '[start]value[end]', matchCount: 1 })
  })

  it('reuses first/all matching and separator semantics', () => {
    const source = '<b>一</e>ignored<b>二</e><b>三</e>'
    expect(
      extractMarkerRanges(
        source,
        config({ startMarker: '<b>', endMarker: '</e>', matchMode: 'all', separator: '、' })
      )
    ).toEqual({ value: '一、二、三', matchCount: 3 })
    expect(
      extractMarkerRanges(
        source,
        config({ startMarker: '<b>', endMarker: '</e>', matchMode: 'first' })
      )
    ).toEqual({ value: '一', matchCount: 1 })
  })

  it('uses the nearest following end marker and returns only complete ranges', () => {
    expect(
      extractMarkerRanges(
        '[start]first[end]gap[end][start]unfinished',
        config({ startMarker: '[start]', endMarker: '[end]', matchMode: 'all' })
      )
    ).toEqual({ value: 'first', matchCount: 1 })
  })

  it('returns no match for empty, missing, or reversed markers', () => {
    expect(extractMarkerRanges('abc', config({ startMarker: '' }))).toEqual({
      value: '',
      matchCount: 0
    })
    expect(extractMarkerRanges('[start]abc', config())).toEqual({ value: '', matchCount: 0 })
    expect(
      extractMarkerRanges('[end]abc[start]', config({ startMarker: '[start]', endMarker: '[end]' }))
    ).toEqual({ value: '', matchCount: 0 })
  })

  it('matches marker text case-sensitively', () => {
    expect(
      extractMarkerRanges(
        '[START]正文[END]',
        config({ startMarker: '[start]', endMarker: '[end]' })
      )
    ).toEqual({ value: '', matchCount: 0 })
  })
})
