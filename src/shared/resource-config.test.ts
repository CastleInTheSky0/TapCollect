import { describe, expect, it } from 'vitest'
import {
  isValidResourceUrlPrefix,
  normalizeResourceAddressMode,
  normalizeResourceUrlPrefix
} from './resource-config'

describe('resource configuration', () => {
  it('normalizes path and HTTP prefixes without a trailing slash', () => {
    expect(normalizeResourceUrlPrefix('/resources///')).toBe('/resources')
    expect(normalizeResourceUrlPrefix('https://static.example.com/resources/')).toBe(
      'https://static.example.com/resources'
    )
  })

  it('accepts only root paths or HTTP/HTTPS prefixes without query data', () => {
    expect(isValidResourceUrlPrefix('/resources')).toBe(true)
    expect(isValidResourceUrlPrefix('https://static.example.com/resources')).toBe(true)
    expect(isValidResourceUrlPrefix('//static.example.com/resources')).toBe(false)
    expect(isValidResourceUrlPrefix('file:///resources')).toBe(false)
    expect(isValidResourceUrlPrefix('/resources?version=1')).toBe(false)
    expect(isValidResourceUrlPrefix('https://static.example.com/resources?version=1')).toBe(false)
  })

  it('falls back to the legacy address mode for unknown stored values', () => {
    expect(normalizeResourceAddressMode('prefix')).toBe('prefix')
    expect(normalizeResourceAddressMode('unknown')).toBe('absolute-replace')
  })
})
