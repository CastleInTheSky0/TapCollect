import { describe, expect, it } from 'vitest'
import { DEFAULT_ACCESS_POLICY, normalizeAccessPolicy, redactDiagnostic } from './access-protection'
import { normalizeAppSettings } from './defaults'

describe('access policy settings', () => {
  it('migrates legacy settings and bounds related limits', () => {
    expect(normalizeAppSettings(null).access).toEqual(DEFAULT_ACCESS_POLICY)
    const settings = normalizeAccessPolicy({ globalConcurrency: 2, hostConcurrency: 5, resourceConcurrency: 20,
      minIntervalMs: NaN, retryBaseMs: 5000, retryMaxMs: 100, language: 'en\r\nx-secret: bad' })
    expect(settings).toMatchObject({ globalConcurrency: 2, hostConcurrency: 2, resourceConcurrency: 2,
      minIntervalMs: 1000, retryBaseMs: 5000, retryMaxMs: 5000, language: DEFAULT_ACCESS_POLICY.language })
  })
  it('redacts credentials without changing ordinary URLs', () => {
    expect(redactDiagnostic('https://user:pass@example.com/a?token=secret&page=2')).toBe('https://[已隐藏]@example.com/a?token=[已隐藏]&page=2')
    expect(redactDiagnostic('https://example.com/a?id=42')).toBe('https://example.com/a?id=42')
    expect(redactDiagnostic('Authorization: Bearer secret')).not.toContain('secret')
  })
  it('defaults resource retries to three and caps them at five extra attempts', () => {
    expect(normalizeAccessPolicy({ maxRetries: 9 }).resourceMaxRetries).toBe(3)
    expect(normalizeAccessPolicy({ resourceMaxRetries: 0 }).resourceMaxRetries).toBe(0)
    expect(normalizeAccessPolicy({ resourceMaxRetries: 20 }).resourceMaxRetries).toBe(5)
    expect(normalizeAccessPolicy({ resourceMaxRetries: -1 }).resourceMaxRetries).toBe(0)
    expect(normalizeAccessPolicy({ resourceMaxRetries: NaN }).resourceMaxRetries).toBe(3)
  })
})
