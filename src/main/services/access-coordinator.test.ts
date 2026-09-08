import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask } from '@shared/defaults'
import { DEFAULT_ACCESS_POLICY } from '@shared/access-protection'
import { AccessProtectionError, RequestInterruptedError } from '@main/core/access-errors'
import { HttpClient, HttpRequestError } from '@main/core/http-client'
import { AccessCoordinator } from './access-coordinator'

const setup = () => {
  const access = new AccessCoordinator('runtime-chromium')
  access.configure({ ...DEFAULT_ACCESS_POLICY, minIntervalMs: 0, jitterPercent: 0 })
  const config = createTask('sample').request
  config.delayMs = 0
  return { access, config }
}
afterEach(() => vi.useRealTimers())

describe('shared access coordinator', () => {
  it.each([400, 404, 405, 410, 422])('does not retry a resource HTTP %i or cool down the host', async (status) => {
    const { access, config } = setup()
    access.configure({ ...access.settings, failureThreshold: 1 })
    const cancel = vi.fn()
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status }))
    const result = await new HttpClient(fetcher, access).fetchResource('https://example.com/file.doc', config).catch(error => error)
    expect(result).toMatchObject({ status, retries: 0 })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(access.getProtection('example.com')).toBeUndefined()
  })

  it.each([0, 1, 3, 5])('bounds resource failures to %i extra retries independently of page cooldowns', async (resourceMaxRetries) => {
    vi.useFakeTimers()
    for (const status of [0, 408, 425, 503]) {
      const { access, config } = setup()
      access.configure({ ...access.settings, resourceMaxRetries, maxRetries: 8, failureThreshold: 1 })
      const fetcher = vi.fn(async () => {
        if (!status) throw new Error('net::ERR_EMPTY_RESPONSE')
        return new Response(null, { status })
      })
      const pending = new HttpClient(fetcher, access).fetchResource('http://example.com/legacy.doc', config).catch(error => error)
      await vi.runAllTimersAsync()
      const error = await pending
      expect(error).toBeInstanceOf(HttpRequestError)
      expect(error).toMatchObject({ status, retries: resourceMaxRetries })
      expect(fetcher).toHaveBeenCalledTimes(resourceMaxRetries + 1)
      expect(access.getProtection('example.com')).toBeUndefined()
    }
  })

  it('keeps one resource retry budget through same-host redirects and continues page requests after exhaustion', async () => {
    vi.useFakeTimers()
    const { access, config } = setup()
    access.configure({ ...access.settings, resourceMaxRetries: 1, failureThreshold: 1 })
    const calls: string[] = []
    const client = new HttpClient(async (url) => {
      calls.push(String(url))
      if (String(url).endsWith('/redirect')) return new Response(null, { status: 302, headers: { location: '/file.doc' } })
      return String(url).endsWith('/file.doc') ? new Response(null, { status: 500 }) : new Response('<p>下一篇正文</p>')
    }, access)
    const pending = client.fetchResource('https://example.com/redirect', config).catch(error => error)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ retries: 1 })
    expect(calls).toEqual(['https://example.com/redirect', 'https://example.com/file.doc', 'https://example.com/redirect', 'https://example.com/file.doc'])
    await expect(client.fetchHtml('https://example.com/article', config)).resolves.toMatchObject({ kind: 'success' })
  })

  it.each([
    { status: 401, headers: {}, kind: 'action-required' },
    { status: 403, headers: {}, kind: 'action-required' },
    { status: 429, headers: {}, kind: 'cooling' },
    { status: 503, headers: { 'retry-after': '3600' }, kind: 'cooling' }
  ])('preserves explicit resource access protection for $status', async ({ status, headers, kind }) => {
    const { access, config } = setup()
    const fetcher = vi.fn(async () => new Response(null, { status, headers }))
    const client = new HttpClient(fetcher, access)
    await expect(client.fetchResource('https://example.com/file.doc', config)).rejects.toBeInstanceOf(AccessProtectionError)
    await expect(client.fetchHtml('https://example.com/page', config)).rejects.toBeInstanceOf(AccessProtectionError)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(access.getProtection('example.com')?.kind).toBe(kind)
    if (status === 503) expect(access.getProtection('example.com')!.until - Date.now()).toBeGreaterThan(3590000)
  })

  it('restores the submitter context when a queue starts work from another profile callback', async () => {
    const { access, config } = setup()
    const client = new HttpClient(async () => new Response('legacy'), access)
    const identity = { userAgent: 'Profile-UA', language: 'en', fetch: async () => new Response('profile') }
    let release!: () => void
    const first = access.withContext('profile', undefined, () => access.run('https://example.com/slow', 0, () => new Promise<void>(resolve => { release = resolve })), identity)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const second = client.fetchHtml('https://example.com/legacy', config)
    release()
    await first
    const result = await second
    expect(result.kind === 'success' && result.html).toBe('legacy')
  })
  it('isolates concurrent profile transports and identities without splitting hostname cooldowns', async () => {
    const { access, config } = setup()
    const fallback = vi.fn(async () => new Response('<p>legacy</p>'))
    const seen: string[] = []
    const identity = (name: string) => ({ userAgent: `UA-${name}`, language: `lang-${name}`, fetch: (async (_url, init) => {
      const headers = new Headers(init?.headers)
      seen.push(`${headers.get('user-agent')} ${headers.get('accept-language')}`)
      return new Response('<p>ok</p>')
    }) as typeof fetch })
    const client = new HttpClient(fallback, access)
    await Promise.all(['one', 'two'].map(name => access.withContext(name, undefined, () => client.fetchHtml('https://example.com/list', config), identity(name))))
    expect(seen.sort()).toEqual(['UA-one lang-one', 'UA-two lang-two'])
    expect(fallback).not.toHaveBeenCalled()
    access.protect('example.com', 'Retry-After', Date.now() + 60000)
    await expect(access.withContext('other-profile', undefined, () => client.fetchHtml('https://example.com/list', config), identity('other'))).rejects.toBeInstanceOf(AccessProtectionError)
    expect(seen).toHaveLength(2)
  })
  it('spaces starts across tasks and schedules every redirect', async () => {
    const { access, config } = setup()
    access.configure({ ...access.settings, minIntervalMs: 50, hostConcurrency: 2 })
    const starts: number[] = []
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      starts.push(Date.now())
      return String(url).endsWith('/redirect') ? new Response(null, { status: 302, headers: { location: '/final' } }) : new Response('<p>ok</p>')
    })
    const client = new HttpClient(fetcher as typeof fetch, access)
    const results = Promise.all([
      access.withContext('a', undefined, () => client.fetchHtml('https://example.com/redirect', config)),
      access.withContext('b', undefined, () => client.fetchHtml('https://example.com/b', config))
    ])
    expect((await results).every(result => result.kind === 'success')).toBe(true)
    expect(starts).toHaveLength(3)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(50)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(50)
  })

  it('holds concurrency until streaming bodies finish while other hosts proceed', async () => {
    const { access, config } = setup()
    let finish!: () => void
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls++
      return calls === 1 ? new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'))
        finish = () => controller.close()
      } })) : new Response('done')
    })
    const client = new HttpClient(fetcher as typeof fetch, access)
    const first = await client.fetchResource('https://example.com/one', config)
    if (first.kind !== 'success') throw new Error('expected success')
    const body = first.response.text()
    const second = client.fetchHtml('https://example.com/two', config)
    const other = await client.fetchHtml('https://other.example.com/three', config)
    expect(other.kind).toBe('success')
    expect(calls).toBe(2)
    finish()
    expect(await body).toBe('hello')
    await second
    expect(calls).toBe(3)
  })

  it('blocks an entire host for Retry-After and cannot reset it by saving settings', async () => {
    const { access, config } = setup()
    const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '3600' } }))
    const client = new HttpClient(fetcher as typeof fetch, access)
    await expect(client.fetchHtml('https://example.com/a', config)).rejects.toBeInstanceOf(AccessProtectionError)
    access.configure({ ...access.settings, cooldownSeconds: 5 })
    access.clearManual('example.com')
    await expect(client.fetchHtml('https://example.com/b', config)).rejects.toBeInstanceOf(AccessProtectionError)
    expect(access.getProtection('example.com')!.until - Date.now()).toBeGreaterThan(3590000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('uses one retry policy and trips the circuit after consecutive failures', async () => {
    vi.useFakeTimers()
    const { access, config } = setup()
    access.configure({ ...access.settings, retryBaseMs: 100, failureThreshold: 3 })
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }))
    const client = new HttpClient(fetcher as typeof fetch, access)
    const result = client.fetchHtml('https://example.com/a', config).catch(error => error)
    await vi.runAllTimersAsync()
    expect(await result).toBeInstanceOf(AccessProtectionError)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(access.getProtection('example.com')?.kind).toBe('cooling')
  })

  it('removes aborted queued requests without sending them', async () => {
    const { access, config } = setup()
    const abort = new AbortController()
    let finish!: () => void
    const occupied = access.run('https://example.com/first', 0, () => new Promise<void>(resolve => { finish = resolve }))
    const fetcher = vi.fn(async () => new Response('ok'))
    const client = new HttpClient(fetcher as typeof fetch, access)
    const pending = access.withContext('queued', abort.signal, () => client.fetchHtml('https://example.com/second', config)).catch(error => error)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    abort.abort()
    expect(await pending).toBeInstanceOf(RequestInterruptedError)
    finish()
    await occupied
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('recognizes 200 challenges and uses the runtime identity', async () => {
    const { access, config } = setup()
    config.headers.push({ id: 'ua', key: 'User-Agent', value: 'old-chrome' })
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('user-agent')).toBe('runtime-chromium')
      return new Response('<title>安全验证</title><input name="captcha">请输入验证码')
    })
    const client = new HttpClient(fetcher as typeof fetch, access)
    await expect(client.fetchHtml('https://example.com/a', config)).rejects.toBeInstanceOf(AccessProtectionError)
    expect(access.getProtection('example.com')?.kind).toBe('action-required')
    access.clearManual('example.com')
    expect(access.getProtection('example.com')).toBeUndefined()
  })
})
