import type { HostProtection } from '@shared/access-protection'

export class AccessProtectionError extends Error {
  constructor(readonly protection: HostProtection) {
    super(`${protection.hostname}：${protection.reason}`)
    this.name = 'AccessProtectionError'
  }
}

export class RequestInterruptedError extends Error {
  constructor() {
    super('访问已中止，保留安全进度')
    this.name = 'RequestInterruptedError'
  }
}

export class RetryableRequestError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message)
    this.name = 'RetryableRequestError'
  }
}

export const isAccessInterruption = (error: unknown): boolean =>
  error instanceof AccessProtectionError || error instanceof RequestInterruptedError

export const parseRetryAfter = (value: string | null, now = Date.now()): number => {
  if (!value?.trim()) return 0
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isSafeInteger(seconds) ? Math.min(Number.MAX_SAFE_INTEGER - now, seconds * 1000) : 0
  }
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}
