import chardet from 'chardet'
import iconv from 'iconv-lite'
import type { RequestConfig } from '@shared/types'

const MAX_RETRIES = 3
const MAX_REDIRECTS = 10
const RETRYABLE_STATUS = new Set([408, 425, 429])
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'cookie',
  'authorization',
  'proxy-authorization'
])

export const allowedCustomRequestHeaders = (
  config: RequestConfig
): Array<{ key: string; value: string }> =>
  config.headers
    .map((entry) => ({ key: entry.key.trim(), value: entry.value }))
    .filter((entry) => entry.key && !FORBIDDEN_CUSTOM_HEADERS.has(entry.key.toLowerCase()))

export interface FetchHtmlSuccess {
  kind: 'success'
  requestedUrl: string
  finalUrl: string
  status: number
  html: string
  encoding: string
  retries: number
}

export interface FetchHtmlNotFound {
  kind: 'not-found'
  requestedUrl: string
  finalUrl: string
  status: 404 | 410
  retries: number
}

export interface FetchHtmlExternalRedirect {
  kind: 'external-redirect'
  requestedUrl: string
  finalUrl: string
  status: number
  retries: number
}

export type FetchHtmlResult =
  | FetchHtmlSuccess
  | FetchHtmlNotFound
  | FetchHtmlExternalRedirect

export interface FetchResourceSuccess {
  kind: 'success'
  requestedUrl: string
  finalUrl: string
  status: number
  response: Response
  retries: number
}

export type FetchResourceResult =
  | FetchResourceSuccess
  | FetchHtmlNotFound
  | FetchHtmlExternalRedirect

interface RawFetchSuccess {
  kind: 'success'
  requestedUrl: string
  finalUrl: string
  status: number
  response: Response
  retries: number
}

type RawFetchResult = RawFetchSuccess | FetchHtmlNotFound | FetchHtmlExternalRedirect

export class HttpRequestError extends Error {
  readonly url: string
  readonly status: number
  readonly retries: number

  constructor(message: string, url: string, status = 0, retries = 0) {
    super(message)
    this.name = 'HttpRequestError'
    this.url = url
    this.status = status
    this.retries = retries
  }
}

class RetryableRequestError extends Error {
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.status = status
  }
}

const normalizeEncoding = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/["']/g, '')
  if (normalized === 'utf8') return 'utf-8'
  if (['gb2312', 'x-gbk', 'cp936', 'windows-936'].includes(normalized)) return 'gbk'
  if (normalized === 'ascii') return 'utf-8'
  return normalized
}

const contentTypeEncoding = (contentType: string | null): string => {
  const match = contentType?.match(/charset\s*=\s*["']?([^;\s"']+)/i)
  return match?.[1] ? normalizeEncoding(match[1]) : ''
}

const metaEncoding = (buffer: Buffer): string => {
  const prefix = buffer.subarray(0, Math.min(buffer.length, 16_384)).toString('latin1')
  const direct = prefix.match(/<meta\b[^>]*charset\s*=\s*["']?([^\s"'/>]+)/i)
  if (direct?.[1]) return normalizeEncoding(direct[1])
  const content = prefix.match(
    /<meta\b[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^\s;"']+)/i
  )
  return content?.[1] ? normalizeEncoding(content[1]) : ''
}

export const detectHtmlEncoding = (
  buffer: Buffer,
  contentType: string | null,
  manualEncoding: RequestConfig['manualEncoding']
): string => {
  const candidates = [manualEncoding, contentTypeEncoding(contentType), metaEncoding(buffer)]
  const detected = chardet.detect(buffer)
  if (detected) candidates.push(normalizeEncoding(detected))
  candidates.push('utf-8')
  return candidates.find((candidate) => candidate && iconv.encodingExists(candidate)) ?? 'utf-8'
}

export const decodeHtml = (
  buffer: Buffer,
  contentType: string | null,
  manualEncoding: RequestConfig['manualEncoding']
): { html: string; encoding: string } => {
  const encoding = detectHtmlEncoding(buffer, contentType, manualEncoding)
  return { html: iconv.decode(buffer, encoding), encoding }
}

const buildHeaders = (config: RequestConfig, accept: string): Headers => {
  const headers = new Headers({
    'user-agent': config.userAgent,
    accept,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7'
  })
  for (const entry of allowedCustomRequestHeaders(config)) {
    headers.set(entry.key, entry.value)
  }
  return headers
}

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

const discardResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel()
  } catch {
    // A failed discard must not replace the authoritative HTTP result.
  }
}

export class HttpClient {
  private readonly fetchImplementation: typeof fetch

  constructor(fetchImplementation: typeof fetch = fetch) {
    this.fetchImplementation = fetchImplementation
  }

  async fetchHtml(
    requestedUrl: string,
    config: RequestConfig,
    allowedHostname = new URL(requestedUrl).hostname
  ): Promise<FetchHtmlResult> {
    const result = await this.fetchResponse(
      requestedUrl,
      config,
      allowedHostname,
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    )
    if (result.kind !== 'success') return result
    try {
      const buffer = Buffer.from(await result.response.arrayBuffer())
      const decoded = decodeHtml(
        buffer,
        result.response.headers.get('content-type'),
        config.manualEncoding
      )
      return {
        kind: 'success',
        requestedUrl,
        finalUrl: result.finalUrl,
        status: result.status,
        html: decoded.html,
        encoding: decoded.encoding,
        retries: result.retries
      }
    } catch (error) {
      throw new HttpRequestError(
        error instanceof Error ? error.message : String(error),
        result.finalUrl,
        result.status,
        result.retries
      )
    }
  }

  async fetchResource(
    requestedUrl: string,
    config: RequestConfig,
    allowedHostname = new URL(requestedUrl).hostname
  ): Promise<FetchResourceResult> {
    return this.fetchResponse(requestedUrl, config, allowedHostname, '*/*')
  }

  private async fetchResponse(
    requestedUrl: string,
    config: RequestConfig,
    allowedHostname: string,
    accept: string
  ): Promise<RawFetchResult> {
    let lastError: unknown
    for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
      try {
        return await this.fetchAttempt(requestedUrl, config, allowedHostname, retry, accept)
      } catch (error) {
        lastError = error
        const retryable = error instanceof RetryableRequestError
        if (!retryable || retry === MAX_RETRIES) {
          if (error instanceof HttpRequestError) throw error
          const status = error instanceof RetryableRequestError ? error.status : 0
          const message = error instanceof Error ? error.message : String(error)
          throw new HttpRequestError(message, requestedUrl, status, retry)
        }
        await wait(Math.min(2_000, 250 * 2 ** retry))
      }
    }
    throw new HttpRequestError(String(lastError), requestedUrl, 0, MAX_RETRIES)
  }

  private async fetchAttempt(
    requestedUrl: string,
    config: RequestConfig,
    allowedHostname: string,
    retries: number,
    accept: string
  ): Promise<RawFetchResult> {
    let currentUrl = requestedUrl
    const visited = new Set<string>()

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      if (visited.has(currentUrl)) {
        throw new HttpRequestError('请求发生重复重定向', currentUrl, 0, retries)
      }
      visited.add(currentUrl)

      let response: Response
      try {
        response = await this.fetchImplementation(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: buildHeaders(config, accept),
          signal: AbortSignal.timeout(config.timeoutSeconds * 1_000)
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new RetryableRequestError(`网络请求失败：${message}`)
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) {
          await discardResponseBody(response)
          throw new HttpRequestError('重定向响应缺少 Location', currentUrl, response.status, retries)
        }
        const target = new URL(location, currentUrl).toString()
        if (new URL(target).hostname.toLowerCase() !== allowedHostname.toLowerCase()) {
          await discardResponseBody(response)
          return {
            kind: 'external-redirect',
            requestedUrl,
            finalUrl: target,
            status: response.status,
            retries
          }
        }
        await discardResponseBody(response)
        currentUrl = target
        continue
      }

      if (response.status === 404 || response.status === 410) {
        await discardResponseBody(response)
        return {
          kind: 'not-found',
          requestedUrl,
          finalUrl: currentUrl,
          status: response.status,
          retries
        }
      }

      if (response.status >= 500 || RETRYABLE_STATUS.has(response.status)) {
        await discardResponseBody(response)
        throw new RetryableRequestError(`服务器返回 ${response.status}`, response.status)
      }
      if (!response.ok) {
        await discardResponseBody(response)
        throw new HttpRequestError(
          `请求返回不可处理的状态码 ${response.status}`,
          currentUrl,
          response.status,
          retries
        )
      }

      return {
        kind: 'success',
        requestedUrl,
        finalUrl: currentUrl,
        status: response.status,
        response,
        retries
      }
    }

    throw new HttpRequestError('重定向次数超过限制', currentUrl, 0, retries)
  }
}
