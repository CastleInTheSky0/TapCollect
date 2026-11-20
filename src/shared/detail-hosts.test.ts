import { describe, expect, it } from 'vitest'
import { createTask } from './defaults'
import { allowedDetailHostname, analyzeDetailHosts, detailHostScope } from './detail-hosts'

describe('detail hostname scope', () => {
  it('matches whole normalized hostnames, with no userinfo or non-HTTP scheme', () => {
    const { detail } = createTask('cross-host')
    detail.allowedExternalHosts = ' News.Example.com \r\n\nnews.example.com\nother.example.org'
    const scope = detailHostScope(detail, 'http://list.example.com')
    expect([...scope.externalHostnames]).toEqual(['news.example.com', 'other.example.org'])
    expect(allowedDetailHostname(scope, 'https://News.Example.COM:8443/story')).toBe('news.example.com')
    expect(allowedDetailHostname(scope, 'http://list.example.com/story')).toBe('list.example.com')
    for (const url of ['https://cdn.news.example.com', 'https://news.example.com.evil.test',
      'https://login:pass@news.example.com/story', 'ftp://news.example.com']) {
      expect(allowedDetailHostname(scope, url)).toBe('')
    }
    detail.navigationMode = 'click'
    expect(detailHostScope(detail, 'http://list.example.com').externalHostnames.size).toBe(0)
  })

  it('rejects explicit URLs, ports, and wildcards and fails closed on a partially invalid draft', () => {
    const { detail } = createTask('invalid-scope')
    detail.allowedExternalHosts = 'news.example.com\nhttps://news.example.com\n*.example.org\nnews.example.com:8443'
    expect(analyzeDetailHosts(detail.allowedExternalHosts).issues).toHaveLength(3)
    expect(detailHostScope(detail, 'https://list.example.com').externalHostnames.size).toBe(0)
  })
})
