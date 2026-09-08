/** Public metadata only. Cookie values never belong in tasks or profile summaries. */
export const CREDENTIAL_REQUEST_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization'])

export interface AccessProfileInput {
  id: string
  name: string
  origin: string
  userAgent: string
  language: string
}

export interface AccessProfile extends AccessProfileInput {
  cookieCount: number
  storageStatus: 'encrypted' | 'memory-only' | 'unreadable'
}

export interface ProfileCookie {
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expirationDate?: number
}

export const isAccessProfileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

export const profileMatchesUrl = (profile: Pick<AccessProfileInput, 'origin'>, value: string): boolean => {
  try {
    const url = new URL(value)
    return url.origin === profile.origin && !url.username && !url.password
  } catch { return false }
}

export const validateAccessProfile = (input: AccessProfileInput): AccessProfileInput => {
  if (!input || typeof input !== 'object') throw new Error('访问配置格式无效')
  if (input.id && !isAccessProfileId(input.id)) throw new Error('访问配置 ID 无效')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) {
    throw new Error('访问配置名称须为 1–80 个字符')
  }
  let url: URL
  try { url = new URL(input.origin) } catch { throw new Error('请填写完整的 HTTP/HTTPS 来源，如 https://example.com') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('来源只能包含协议、主机和可选端口，不能包含路径或认证信息')
  }
  for (const value of [input.userAgent, input.language]) {
    if (typeof value !== 'string' || value.length > 512 || /[^\x20-\x7e]/.test(value)) throw new Error('UA 和请求语言须为不超过 512 个字符的单行 ASCII 文本')
  }
  return { id: input.id || '', name: input.name.trim(), origin: url.origin, userAgent: input.userAgent.trim(), language: input.language.trim() }
}

/** JSON array import only; never echo malformed values in errors. */
export const parseProfileCookies = (json: string, origin: string, now = Date.now() / 1000): ProfileCookie[] => {
  if (typeof json !== 'string' || json.length > 256_000 || new TextEncoder().encode(json).byteLength > 256_000) throw new Error('Cookie JSON 不能超过 256 KB')
  let input: unknown
  try { input = JSON.parse(json) } catch { throw new Error('Cookie JSON 格式无效，请使用对象数组') }
  if (!Array.isArray(input) || input.length > 200) throw new Error('Cookie JSON 须为最多 200 项的数组')
  const url = new URL(origin)
  const keys = new Set<string>()
  const hasWhitespaceOrControl = (value: string): boolean => [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  return input.map((entry: unknown, index) => {
    const fail = (): never => { throw new Error(`第 ${index + 1} 项 Cookie 属性无效或超出配置来源范围`) }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail()
    const row = entry as Record<string, unknown>
    if (typeof row.name !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(row.name) || typeof row.value !== 'string' || hasWhitespaceOrControl(row.value) || /[;,]/.test(row.value) || row.name.length + row.value.length > 4096) return fail()
    if (row.domain !== undefined && (typeof row.domain !== 'string' || row.domain.replace(/^\./, '').toLowerCase() !== url.hostname)) return fail()
    const path = row.path ?? '/'
    if (typeof path !== 'string' || !path.startsWith('/') || hasWhitespaceOrControl(path) || /[;?#]/.test(path)) return fail()
    for (const key of ['secure', 'httpOnly']) if (row[key] !== undefined && typeof row[key] !== 'boolean') return fail()
    const sameSite = row.sameSite ?? 'unspecified'
    if (!['unspecified', 'no_restriction', 'lax', 'strict'].includes(String(sameSite))) return fail()
    const secure = row.secure === undefined ? url.protocol === 'https:' : row.secure === true
    if ((secure && url.protocol !== 'https:') || (sameSite === 'no_restriction' && !secure)) return fail()
    if (row.expirationDate !== undefined && (typeof row.expirationDate !== 'number' || !Number.isFinite(row.expirationDate) || row.expirationDate <= now)) return fail()
    if ((row.name.startsWith('__Secure-') && !secure) || (row.name.startsWith('__Host-') && (!secure || path !== '/' || row.domain !== undefined))) return fail()
    const key = `${row.name}\n${path}`
    if (keys.has(key)) return fail()
    keys.add(key)
    return { name: row.name, value: row.value, path, secure, httpOnly: row.httpOnly === true, sameSite: sameSite as ProfileCookie['sameSite'],
      ...(row.expirationDate !== undefined ? { expirationDate: row.expirationDate as number } : {}) }
  })
}
