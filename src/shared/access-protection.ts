export interface AccessPolicySettings {
  globalConcurrency: number
  hostConcurrency: number
  resourceConcurrency: number
  minIntervalMs: number
  jitterPercent: number
  maxRetries: number
  retryBaseMs: number
  retryMaxMs: number
  failureThreshold: number
  cooldownSeconds: number
  detectChallenges: boolean
  automaticUserAgent: boolean
  language: string
}

export interface HostProtection {
  hostname: string
  kind: 'cooling' | 'action-required'
  reason: string
  until: number
}

export const DEFAULT_ACCESS_POLICY: AccessPolicySettings = {
  globalConcurrency: 8,
  hostConcurrency: 1,
  resourceConcurrency: 3,
  minIntervalMs: 1000,
  jitterPercent: 20,
  maxRetries: 3,
  retryBaseMs: 1000,
  retryMaxMs: 30000,
  failureThreshold: 3,
  cooldownSeconds: 60,
  detectChallenges: true,
  automaticUserAgent: true,
  language: 'zh-CN,zh;q=0.9,en;q=0.7'
}

const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value))) : fallback

export const normalizeAccessPolicy = (value: Partial<AccessPolicySettings> | null | undefined): AccessPolicySettings => {
  const defaults = DEFAULT_ACCESS_POLICY
  const globalConcurrency = bounded(value?.globalConcurrency, defaults.globalConcurrency, 1, 32)
  const retryBaseMs = bounded(value?.retryBaseMs, defaults.retryBaseMs, 100, 60000)
  return {
    globalConcurrency,
    hostConcurrency: bounded(value?.hostConcurrency, defaults.hostConcurrency, 1, Math.min(5, globalConcurrency)),
    resourceConcurrency: bounded(value?.resourceConcurrency, defaults.resourceConcurrency, 1, globalConcurrency),
    minIntervalMs: bounded(value?.minIntervalMs, defaults.minIntervalMs, 0, 60000),
    jitterPercent: bounded(value?.jitterPercent, defaults.jitterPercent, 0, 100),
    maxRetries: bounded(value?.maxRetries, defaults.maxRetries, 0, 10),
    retryBaseMs,
    retryMaxMs: bounded(value?.retryMaxMs, defaults.retryMaxMs, retryBaseMs, 300000),
    failureThreshold: bounded(value?.failureThreshold, defaults.failureThreshold, 1, 20),
    cooldownSeconds: bounded(value?.cooldownSeconds, defaults.cooldownSeconds, 5, 86400),
    detectChallenges: value?.detectChallenges !== false,
    automaticUserAgent: value?.automaticUserAgent !== false,
    language: typeof value?.language === 'string' && /^[a-zA-Z0-9,;=*.\s-]{1,200}$/.test(value.language)
      && !/[\r\n]/.test(value.language) ? value.language.trim() : defaults.language
  }
}

export const redactDiagnostic = (text: string): string => text
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
  .replace(/([?&](?:access_token|token|secret|password|passwd|api_key|key|auth|session|sid)=)[^&#\s]*/gi, '$1[已隐藏]')
  .replace(/\b(Cookie|Authorization|Proxy-Authorization)\s*[:=]\s*[^\r\n]*/gi, '$1: [已隐藏]')
