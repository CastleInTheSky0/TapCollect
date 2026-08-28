import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildResourceMirrorPath,
  classifyResourceReference,
  createResourcePlan,
  formatResourceReferenceUrl,
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
      sourcePageUrl: 'https://www.example.com/news/1.html',
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

  it.each([
    ['Report.PDF', 'attachment'],
    ['Cover.JpG', 'image'],
    ['Data.XLSX', 'attachment']
  ] as const)(
    'recognizes mixed-case extensions without changing their original spelling: %s',
    (fileName, kind) => {
      const root = resolve('D:/exports/resources')
      const plan = createResourcePlan(
        `/files/${fileName}`,
        'https://example.com/list',
        'https://example.com/detail',
        root,
        '/resources',
        kind
      )

      expect(plan?.sourceUrl).toBe(`https://example.com/files/${fileName}`)
      expect(plan?.relativePath).toBe(`files/${fileName}`)
      expect(plan?.localPath).toBe(resolve(root, 'files', fileName))
      expect(plan?.xmlUrl).toBe(`/resources/files/${fileName}`)
    }
  )

  it('inserts a query hash before the original mixed-case extension', () => {
    const mirror = buildResourceMirrorPath(
      'https://example.com/files/Report.PDF?download=1',
      true
    )

    expect(mirror.sourceUrl).toBe('https://example.com/files/Report.PDF?download=1')
    expect(mirror.relativePath).toMatch(/^files\/Report__[a-f0-9]{8}\.PDF$/)
    expect(mirror.encodedPath).toBe(mirror.relativePath)
  })

  it('keeps readable resource paths by default and URL-encodes them only when enabled', () => {
    const root = resolve('D:/exports/resources')
    const readable = createResourcePlan(
      '/附件/会议材料.doc',
      'https://example.com/list',
      'https://example.com/detail',
      root,
      '/resources',
      'attachment'
    )
    const encoded = createResourcePlan(
      '/附件/会议材料.doc',
      'https://example.com/list',
      'https://example.com/detail',
      root,
      '/resources',
      'attachment',
      true
    )

    expect(readable).toMatchObject({
      relativePath: '附件/会议材料.doc',
      xmlUrl: '/resources/附件/会议材料.doc'
    })
    expect(encoded?.xmlUrl).toBe(
      '/resources/%E9%99%84%E4%BB%B6/%E4%BC%9A%E8%AE%AE%E6%9D%90%E6%96%99.doc'
    )
    expect(formatResourceReferenceUrl('/附件/a%2Fb.pdf?download=1', false)).toBe(
      '/附件/a%2Fb.pdf?download=1'
    )
    expect(formatResourceReferenceUrl('/附件/a%2Fb.pdf?download=1', true)).toBe(
      '/%E9%99%84%E4%BB%B6/a%2Fb.pdf?download=1'
    )
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
    expect(
      ['a.PNG', 'b.jpg', 'c.DOC', 'd.xls', 'e.pdf', 'f.zip'].map((fileName) =>
        classifyResourceReference(`https://example.com/files/${fileName}`, {
          tagName: '',
          attributeName: ''
        })
      )
    ).toEqual(['image', 'image', 'attachment', 'attachment', 'attachment', 'attachment'])
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

  it('applies the URL-encoding switch to non-download prefix paths', () => {
    expect(
      rewriteInternalResourceWithPrefix(
        'https://www.example.com/files/%E4%B8%AD%E6%96%87%E6%9D%90%E6%96%99.pdf',
        'https://www.example.com/detail/1',
        '/resources'
      )
    ).toBe('/resources/files/中文材料.pdf')
    expect(
      rewriteInternalResourceWithPrefix(
        'https://www.example.com/files/中文材料.pdf',
        'https://www.example.com/detail/1',
        '/resources',
        true
      )
    ).toBe('/resources/files/%E4%B8%AD%E6%96%87%E6%9D%90%E6%96%99.pdf')
  })
})
