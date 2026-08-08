import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { createTask } from '@shared/defaults'
import { HttpClient, decodeHtml } from './http-client'

describe('HTTP client', () => {
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
