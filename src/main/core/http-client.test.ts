import iconv from 'iconv-lite'
import { describe, expect, it, vi } from 'vitest'
import { createTask } from '@shared/defaults'
import { HttpClient, decodeHtml } from './http-client'

describe('HTTP client', () => {
  it.each([
    { 'content-type': 'application/pdf' },
    { 'content-type': 'application/octet-stream' },
    { 'content-disposition': 'attachment; filename="report.pdf"' }
  ])('identifies extensionless attachment headers without buffering the body: %j', async (headers) => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { headers })
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer')
    const fetcher = vi.fn(async () => response)
    const result = await new HttpClient(fetcher as typeof fetch).fetchDetail(
      'https://example.com/download?id=1', createTask('test').request
    )
    expect(result).toMatchObject({ kind: 'attachment', resourceKind: 'attachment' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('recognizes a same-host file redirect but keeps HTML and external targets on their existing paths', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/start')) return new Response(null, { status: 302, headers: { location: '/files/report.PDF' } })
      if (url.endsWith('/outside')) return new Response(null, { status: 302, headers: { location: 'https://other.example/file.pdf' } })
      if (url.endsWith('/login.pdf')) return new Response('<h1>登录</h1>', { headers: { 'content-type': 'text/html;charset=utf-8' } })
      return new Response('pdf', { headers: { 'content-type': 'application/pdf' } })
    })
    const client = new HttpClient(fetcher as typeof fetch)
    const config = createTask('test').request
    await expect(client.fetchDetail('https://example.com/start', config)).resolves.toMatchObject({ kind: 'attachment', finalUrl: 'https://example.com/files/report.PDF' })
    await expect(client.fetchDetail('https://example.com/outside', config)).resolves.toMatchObject({ kind: 'external-redirect' })
    await expect(client.fetchDetail('https://example.com/login.pdf', config)).resolves.toMatchObject({ kind: 'success', html: '<h1>登录</h1>' })
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('other.example'))).toBe(false)
  })

  it('detects a GBK meta declaration and decodes bytes', () => {
    const buffer = iconv.encode('<meta charset="gb2312"><title>中文标题</title>', 'gbk')
    const result = decodeHtml(buffer, null, '')
    expect(result.encoding).toBe('gbk')
    expect(result.html).toContain('中文标题')
  })

  it('stops before a redirect to another hostname', async () => {
    const fakeFetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://outside.example/article/1' }
      })) as typeof fetch
    const client = new HttpClient(fakeFetch)
    const task = createTask('task')
    const result = await client.fetchHtml(
      'https://www.example.com/article/1',
      task.request,
      'www.example.com'
    )
    expect(result).toMatchObject({
      kind: 'external-redirect',
      finalUrl: 'https://outside.example/article/1'
    })
  })

  it('follows redirects only while the exact hostname matches', async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: '/final' } }),
      new Response('<h1>完成</h1>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    ]
    const fakeFetch = (async () => responses.shift()!) as typeof fetch
    const client = new HttpClient(fakeFetch)
    const task = createTask('task')
    const result = await client.fetchHtml(
      'https://www.example.com/start',
      task.request,
      'www.example.com'
    )
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.finalUrl).toBe('https://www.example.com/final')
      expect(result.html).toContain('完成')
    }
  })

  it('returns an unbuffered resource response after retrying a server error', async () => {
    const responses = [
      new Response(null, { status: 503 }),
      new Response('binary-content', { status: 200 })
    ]
    const fakeFetch = (async () => responses.shift()!) as typeof fetch
    const client = new HttpClient(fakeFetch)
    const task = createTask('resource-task')
    const result = await client.fetchResource(
      'https://www.example.com/files/a.bin',
      task.request,
      'www.example.com'
    )

    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.retries).toBe(1)
      await expect(result.response.text()).resolves.toBe('binary-content')
    }
  })
})
