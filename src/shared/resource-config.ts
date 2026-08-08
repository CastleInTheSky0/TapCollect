import type { ResourceAddressMode } from './types'

export const normalizeResourceUrlPrefix = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    const normalized = trimmed.replace(/\/+$/g, '')
    return normalized || '/'
  }
  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:'].includes(url.protocol)) return trimmed
    if (url.username || url.password || url.search || url.hash) return trimmed
    const pathname = url.pathname.replace(/\/+$/g, '')
    return `${url.origin}${pathname}`
  } catch {
    return trimmed
  }
}

export const isValidResourceUrlPrefix = (value: string): boolean => {
  const normalized = normalizeResourceUrlPrefix(value)
  if (!normalized || normalized.includes('\\')) return false
  if (normalized.startsWith('/') && !normalized.startsWith('//')) {
    return !/[?#]/.test(normalized)
  }
  try {
    const url = new URL(normalized)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

export const normalizeResourceAddressMode = (value: unknown): ResourceAddressMode =>
  value === 'prefix' ? 'prefix' : 'absolute-replace'
