import chardet from 'chardet'
import iconv from 'iconv-lite'
import type { RequestConfig, ResourceKind } from '@shared/types'
import { allowedDetailHostname, type DetailHostScope } from '@shared/detail-hosts'
import { detailResponseAttachmentKind } from './detail-attachment'
import { CREDENTIAL_REQUEST_HEADERS } from '@shared/access-profile'
import { DEFAULT_ACCESS_POLICY } from '@shared/access-protection'
import { retry, handleWhen, ExponentialBackoff, noJitterGenerator } from 'cockatiel'
import type { AccessCoordinator } from '@main/services/access-coordinator'
import { RetryableRequestError, RequestInterruptedError, isAccessInterruption } from './access-errors'

const MAX_RETRIES = 3
const MAX_REDIRECTS = 10
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
const RETRYABLE_STATUS = new Set([408, 425, 429])
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  ...CREDENTIAL_REQUEST_HEADERS
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

export interface FetchDetailAttachment {
  kind: 'attachment'
  requestedUrl: string
  finalUrl: string
  status: number
  retries: number
  resourceKind: ResourceKind
}

export type FetchDetailResult = FetchHtmlResult | FetchDetailAttachment

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

const discardResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel()
  } catch {
    // A failed discard must not replace the authoritative HTTP result.
  }
}

export class HttpClient {
  get usesAccessPolicy(): boolean { return Boolean(this.access) }
  inspectHtml(html: string, url: string): void { this.access?.inspectHtml(html, url, true) }
  acknowledgeSuccess(url: string): void { this.access?.acknowledgeSuccess(url) }
  private readonly fetchImplementation: typeof fetch

  constructor(
    fetchImplementation: typeof fetch = fetch,
    private readonly access?: AccessCoordinator,
    private readonly detailFetch: typeof fetch = fetchImplementation
  ) {
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
      HTML_ACCEPT
    )
    if (result.kind !== 'success') return result
    return this.readHtml(result, config)
  }

  async fetchDetail(
    requestedUrl: string,
    config: RequestConfig,
    scope: string | DetailHostScope = new URL(requestedUrl).hostname,
    detectAttachments = true
  ): Promise<FetchDetailResult> {
    const result = await this.fetchResponse(requestedUrl, config, scope, HTML_ACCEPT)
    if (result.kind !== 'success') return result
    if (!detectAttachments && !this.isForeignDetail(scope, result.finalUrl)) return this.readHtml(result, config)
    const resourceKind = detailResponseAttachmentKind(result.finalUrl, result.response.headers)
    if (!resourceKind) return this.readHtml(result, config)
    // 只识别响应头，取消正文以释放网络名额；正式资源阶段统一流式下载。
    await discardResponseBody(result.response)
    if (this.access?.signal?.aborted) throw new RequestInterruptedError()
    this.access?.acknowledgeSuccess(result.finalUrl)
    return {
      kind: 'attachment', requestedUrl, finalUrl: result.finalUrl,
      status: result.status, retries: result.retries, resourceKind
    }
  }

  private async readHtml(result: RawFetchSuccess, config: RequestConfig): Promise<FetchHtmlSuccess> {
    try {
      const buffer = Buffer.from(await result.response.arrayBuffer())
      if (this.access?.signal?.aborted) throw new RequestInterruptedError()
      const decoded = decodeHtml(
        buffer,
        result.response.headers.get('content-type'),
        config.manualEncoding
      )
      this.access?.inspectHtml(decoded.html, result.finalUrl)
      this.access?.acknowledgeSuccess(result.finalUrl)
      return {
        kind: 'success',
        requestedUrl: result.requestedUrl,
        finalUrl: result.finalUrl,
        status: result.status,
        html: decoded.html,
        encoding: decoded.encoding,
        retries: result.retries
      }
    } catch (error) {
      if (isAccessInterruption(error)) throw error
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
    scope: string | DetailHostScope,
    accept: string
  ): Promise<RawFetchResult> {
    if (typeof scope !== 'string' && !allowedDetailHostname(scope, requestedUrl)) {
      throw new HttpRequestError('详情地址不在允许的站点内', requestedUrl)
    }
    const settings = this.access?.settings
    const maxRetries = accept === '*/*'
      ? settings?.resourceMaxRetries ?? DEFAULT_ACCESS_POLICY.resourceMaxRetries
      : settings?.maxRetries ?? MAX_RETRIES
    let attempts = 0
    const policy = retry(handleWhen(error => error instanceof RetryableRequestError), {
      maxAttempts: maxRetries,
      backoff: new ExponentialBackoff({
        initialDelay: settings?.retryBaseMs ?? 250,
        maxDelay: settings?.retryMaxMs ?? 2000,
        ...(settings ? {} : { generator: noJitterGenerator })
      })
    })
    try {
      return await policy.execute(({ attempt }) => {
        attempts = attempt
        return this.fetchAttempt(requestedUrl, config, scope, attempt, accept)
      }, this.access?.signal)
    } catch (error) {
      if (isAccessInterruption(error) || error instanceof HttpRequestError) throw error
      if (this.access?.signal?.aborted) throw new RequestInterruptedError()
      throw new HttpRequestError(error instanceof Error ? error.message : String(error), requestedUrl,
        error instanceof RetryableRequestError ? error.status : 0, attempts)
    }
  }

  private isForeignDetail(scope: string | DetailHostScope, url: string): boolean {
    return typeof scope !== 'string' && new URL(url).hostname !== scope.listHostname
  }

  private async fetchAttempt(
    requestedUrl: string,
    config: RequestConfig,
    scope: string | DetailHostScope,
    retries: number,
    accept: string
  ): Promise<RawFetchResult> {
    let currentUrl = requestedUrl
    const visited = new Set<string>()
    const fallback = typeof scope !== 'string' && scope.externalHostnames.size
      ? this.detailFetch
      : this.fetchImplementation

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      if (visited.has(currentUrl)) {
        throw new HttpRequestError('请求发生重复重定向', currentUrl, 0, retries)
      }
      visited.add(currentUrl)

      let response: Response
      try {
        const anonymous = this.isForeignDetail(scope, currentUrl)
        const effective = anonymous
          ? { ...config, headers: [], userAgent: this.access?.userAgent ?? config.userAgent }
          : this.access?.requestConfig(config) ?? config
        const headers = buildHeaders(effective, accept)
        if (this.access) headers.set('accept-language', anonymous ? this.access.settings.language : this.access.language)
        const signal = this.access?.signal
        const init: RequestInit = {
          method: 'GET',
          redirect: 'manual',
          ...(anonymous ? { credentials: 'omit' } : {}),
          headers,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)])
            : AbortSignal.timeout(config.timeoutSeconds * 1000)
        }
        const fetchResponse = (): Promise<Response> => this.access && !anonymous
          ? this.access.transport(currentUrl, init, fallback)
          : fallback(currentUrl, init)
        response = this.access
          ? await this.access.fetch(currentUrl, config, fetchResponse, accept === '*/*')
          : await fetchResponse()
      } catch (error) {
        if (isAccessInterruption(error) || error instanceof RetryableRequestError) throw error
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
        const permitted = typeof scope === 'string'
          ? new URL(target).hostname.toLowerCase() === scope.toLowerCase()
          : Boolean(allowedDetailHostname(scope, target))
        if (!permitted) {
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
        this.access?.acknowledgeSuccess(currentUrl)
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
