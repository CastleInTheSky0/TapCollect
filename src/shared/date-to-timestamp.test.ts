import { describe, expect, it } from 'vitest'
import { convertDateToTimestamp } from './date-to-timestamp'

describe('convertDateToTimestamp', () => {
  it.each([
    ['2026-08-12', '1786464000000'],
    ['2026/08/12', '1786464000000'],
    ['2026.08.12', '1786464000000'],
    ['2026年8月12日', '1786464000000'],
    ['2026-08-12 09:30', '1786498200000'],
    ['2026年8月12日 09:30:45', '1786498245000']
  ])('parses %s as a timezone-less Shanghai date', (input, expected) => {
    expect(convertDateToTimestamp(input)).toEqual({ ok: true, value: expected })
  })

  it.each([
    ['2026-08-12T00:00:00+08:00', '1786464000000'],
    ['2026-08-11T16:00:00Z', '1786464000000'],
    ['2026-08-12T00:00:00.125+08:00', '1786464000125']
  ])('respects the explicit timezone in %s', (input, expected) => {
    expect(convertDateToTimestamp(input)).toEqual({ ok: true, value: expected })
  })

  it('preserves milliseconds and expands seconds', () => {
    expect(convertDateToTimestamp('1786464000000')).toEqual({
      ok: true,
      value: '1786464000000'
    })
    expect(convertDateToTimestamp('1786464000')).toEqual({
      ok: true,
      value: '1786464000000'
    })
  })

  it.each(['', '2026-02-30', '2026-13-01', '2026-08-12 24:00', '08/12/2026'])(
    'rejects empty, invalid, or unsupported input: %s',
    (input) => {
      expect(convertDateToTimestamp(input)).toMatchObject({ ok: false })
    }
  )
})
