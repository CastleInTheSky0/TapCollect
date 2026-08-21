import type { PageExtractionConfig } from '@shared/types'

type MarkerRangeConfig = Pick<
  PageExtractionConfig,
  'startMarker' | 'endMarker' | 'includeMarkers' | 'matchMode' | 'separator'
>

export interface MarkerRangeResult {
  value: string
  matchCount: number
}

interface LiteralMarkerMatch {
  start: number
  end: number
}

const createLiteralMarkerPattern = (marker: string): RegExp => {
  const pattern = marker
    .replace(/\r\n?/g, '\n')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\n/g, '(?:\\r\\n|\\r|\\n)')
  return new RegExp(pattern, 'g')
}

const findLiteralMarker = (
  source: string,
  pattern: RegExp,
  cursor: number
): LiteralMarkerMatch | null => {
  pattern.lastIndex = cursor
  const match = pattern.exec(source)
  if (!match) return null
  return { start: match.index, end: match.index + match[0].length }
}

export const findMarkerRangeValues = (
  source: string,
  config: MarkerRangeConfig
): string[] => {
  const { startMarker, endMarker } = config
  if (!startMarker.length || !endMarker.length) return []

  const startPattern = createLiteralMarkerPattern(startMarker)
  const endPattern = createLiteralMarkerPattern(endMarker)
  const values: string[] = []
  let cursor = 0
  while (cursor <= source.length) {
    const start = findLiteralMarker(source, startPattern, cursor)
    if (!start) break
    const end = findLiteralMarker(source, endPattern, start.end)
    if (!end) break
    values.push(
      source.slice(
        config.includeMarkers ? start.start : start.end,
        config.includeMarkers ? end.end : end.start
      )
    )
    cursor = end.end
    if (config.matchMode === 'first') break
  }

  return values
}

export const extractMarkerRanges = (
  source: string,
  config: MarkerRangeConfig
): MarkerRangeResult => {
  const values = findMarkerRangeValues(source, config)

  return {
    value: values.join(config.separator),
    matchCount: values.length
  }
}
