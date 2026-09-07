import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask } from '@shared/defaults'
import { DEFAULT_ACCESS_POLICY } from '@shared/access-protection'
import { AccessProtectionError, RequestInterruptedError } from '@main/core/access-errors'
import { HttpClient } from '@main/core/http-client'
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
