import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildResourceMirrorPath,
  classifyResourceReference,
  createResourcePlan,
  joinResourcePrefix,
  rewriteInternalResourceWithPrefix
} from './resource-planner'

describe('resource planner', () => {
  it('mirrors the URL pathname without the hostname and joins a configured prefix', () => {
    const root = resolve('D:/exports/resources')
    const plan = createResourcePlan(
      '/upload/2026/a.jpg',
      'https://www.example.com/news/1.html',
      'https://www.example.com/news/1.html',
      root,
      '/resources/',
      'image'
    )

    expect(plan).toMatchObject({
      sourceUrl: 'https://www.example.com/upload/2026/a.jpg',
      relativePath: 'upload/2026/a.jpg',
      xmlUrl: '/resources/upload/2026/a.jpg',
      kind: 'image'
    })
    expect(plan?.localPath).toBe(resolve(root, 'upload', '2026', 'a.jpg'))
  })

  it('adds a stable query hash before the extension and avoids collisions', () => {
    const first = buildResourceMirrorPath('https://example.com/a.jpg?size=small&v=1', true)
    const reordered = buildResourceMirrorPath('https://example.com/a.jpg?v=1&size=small', true)
    const second = buildResourceMirrorPath('https://example.com/a.jpg?size=large&v=1', true)

    expect(first.relativePath).toMatch(/^a__[a-f0-9]{8}\.jpg$/)
    expect(reordered.relativePath).toBe(first.relativePath)
    expect(second.relativePath).not.toBe(first.relativePath)
  })

  it('keeps decoded traversal and Windows-invalid names inside the selected root', () => {
    const root = resolve('D:/exports/resources')
    const plan = createResourcePlan(
      'https://example.com/%2e%2e/%2Foutside/CON?.pdf=1',
      'https://example.com/list',
      'https://example.com/detail',
      root,
      'https://static.example.com/resources',
      'attachment'
    )!
    const relativePath = relative(root, plan.localPath)

    expect(relativePath.startsWith('..')).toBe(false)
    expect(plan.relativePath).not.toContain('..')
    expect(plan.xmlUrl).toMatch(/^https:\/\/static\.example\.com\/resources\//)
  })

  it('does not plan a resource from another hostname', () => {
    expect(
      createResourcePlan(
        'https://cdn.example.com/a.jpg',
        'https://www.example.com/detail',
        'https://www.example.com/detail',
        'D:/resources',
        '/resources',
        'image'
      )
    ).toBeNull()
  })

  it('recognizes media and attachments without treating ordinary links as downloads', () => {
    expect(
      classifyResourceReference('https://example.com/video/stream', {
        tagName: 'source',
        parentTagName: 'video',
        attributeName: 'src'
      })
    ).toBe('video')
    expect(
      classifyResourceReference('https://example.com/files/a.pdf', {
        tagName: 'a',
        attributeName: 'href'
      })
    ).toBe('attachment')
    expect(
      classifyResourceReference('https://example.com/news/1.html', {
        tagName: 'a',
        attributeName: 'href'
      })
    ).toBeNull()
    expect(
      classifyResourceReference('https://example.com/download?id=1', {
        tagName: 'a',
        attributeName: 'href',
        hasDownloadAttribute: true
      })
    ).toBe('attachment')
  })

  it('rewrites only same-host resources in non-download prefix mode', () => {
    expect(
      rewriteInternalResourceWithPrefix(
        'https://www.example.com/upload/a.jpg?size=small',
        'https://www.example.com/detail/1',
        '/resources'
      )
    ).toBe('/resources/upload/a.jpg')
    expect(
      rewriteInternalResourceWithPrefix(
        'https://cdn.example.com/upload/a.jpg',
        'https://www.example.com/detail/1',
        '/resources'
      )
    ).toBe('https://cdn.example.com/upload/a.jpg')
    expect(joinResourcePrefix('/', 'upload/a.jpg')).toBe('/upload/a.jpg')
  })

  it('preserves the original encoded pathname in non-download prefix mode', () => {
    expect(
      rewriteInternalResourceWithPrefix(
        'https://www.example.com/files/a%2Fb.pdf?download=1',
        'https://www.example.com/detail/1',
        '/resources'
      )
    ).toBe('/resources/files/a%2Fb.pdf')
  })
})
