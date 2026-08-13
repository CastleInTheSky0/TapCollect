import type { PaginationParameter, ReplacementRule } from '@shared/types'
export { buildPageUrl } from '@shared/list-page-rules'

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

export const resolveHttpUrl = (value: string, baseUrl: string): string => {
  const candidate = value.trim()
  if (!candidate || candidate === '#') return ''
  try {
    const resolved = new URL(candidate, baseUrl)
    return HTTP_PROTOCOLS.has(resolved.protocol) ? resolved.toString() : ''
  } catch {
    return ''
  }
}

export const normalizeUrl = (value: string, preserveHash = false): string => {
  const url = new URL(value)
  if (!preserveHash) url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = ''
  }
  return url.toString()
}

export const hasSameHostname = (left: string, right: string): boolean => {
  try {
    return new URL(left).hostname.toLowerCase() === new URL(right).hostname.toLowerCase()
  } catch {
    return false
  }
}

export const detectPaginationParameters = (value: string): PaginationParameter[] => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return []
  }

  const result: PaginationParameter[] = []
  for (const [name, parameterValue] of url.searchParams.entries()) {
    if (!/^-?\d+$/.test(parameterValue)) continue
    const candidate = new URL(url.toString())
    candidate.searchParams.set(name, '{page}')
    result.push({
      name,
      value: parameterValue,
      template: candidate.toString().replace('%7Bpage%7D', '{page}')
    })
  }
  return result
}

export const applyReplacementRules = (value: string, rules: ReplacementRule[]): string =>
  rules.reduce((current, rule) => {
    if (!rule.from) return current
    return current.split(rule.from).join(rule.to)
  }, value)

export const sanitizeFileName = (value: string): string => {
  const invalidCharacters = /[<>:"/\\|?*]/
  let sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || invalidCharacters.test(character) ? '_' : character
  })
    .join('')
    .trim()
    .replace(/[. ]+$/g, '_')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(sanitized)) {
    sanitized = `_${sanitized}`
  }
  return sanitized || '未命名任务'
}

export const formatRunStamp = (date = new Date()): string => {
  const pad = (part: number): string => String(part).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('')
}
