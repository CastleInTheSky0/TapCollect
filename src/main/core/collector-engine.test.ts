import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyCounters,
  createEmptyResourceCounters,
  createTask
} from '@shared/defaults'
import { configureXmlRecord } from './xml-template'
import type { FetchHtmlResult, HttpClient } from './http-client'
import type { DynamicPageProvider, DynamicPageSnapshot } from './dynamic-page'
import { CollectorEngine, CollectorRunControl } from './collector-engine'
import { TaskStore } from '@main/services/task-store'
import { readOutputXml } from '@main/services/output-writer'
import type { ResourceDownloader } from '@main/services/resource-downloader'
import type { RunCheckpoint, TaskConfig } from '@shared/types'

const temporaryDirectories: string[] = []

const createListOnlyTask = (id: string, root: string): TaskConfig => {
  const task = createTask(id)
  task.name = '分页规则测试'
  task.listItem.selector = '.item'
  task.detail.enabled = false
  task.request.delayMs = 0
  task.output.rootDirectory = join(root, 'exports')
  task.xml = configureXmlRecord(
    '<book><article><title/></article></book>',
    'template.xml',
    '/book/article'
  )
  const title = task.xml.mappings.find((mapping) => mapping.fieldPath === 'title')!
  title.mode = 'page'
  title.pageSource = 'list'
  title.selector = '.title'
  task.dedupeFieldPath = 'title'
  return task
}

const createResourceTask = (id: string, root: string): TaskConfig => {
  const task = createTask(id)
  task.name = '资源下载测试'
  task.listPageRules = ['https://example.com/list']
  task.listUrl = task.listPageRules[0]!
  task.listItem.selector = '.item'
  task.detail.enabled = false
  task.request.delayMs = 0
  task.output.rootDirectory = join(root, 'exports')
  task.resources.download.enabled = true
  task.resources.download.rootDirectory = join(root, 'resources')
  task.resources.download.urlPrefix = '/resources'
  task.xml = configureXmlRecord(
    '<book><article><title/><text><![CDATA[]]></text></article></book>',
    'template.xml',
    '/book/article'
  )
  const title = task.xml.mappings.find((mapping) => mapping.fieldPath === 'title')!
  title.mode = 'page'
  title.pageSource = 'list'
  title.selector = '.title'
  const text = task.xml.mappings.find((mapping) => mapping.fieldPath === 'text')!
  text.mode = 'page'
  text.pageSource = 'list'
  text.selector = '.body'
  text.extraction = 'html'
  task.dedupeFieldPath = 'title'
  return task
}

const createDynamicProvider = (
  snapshots: DynamicPageSnapshot[],
  endReason = '页面中找不到下一页按钮'
): {
  provider: DynamicPageProvider
  create: ReturnType<typeof vi.fn>
  current: ReturnType<typeof vi.fn>
  advance: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} => {
  let index = 0
  const current = vi.fn(async () => snapshots[index]!)
  const advance = vi.fn(async () => {
    const next = snapshots[index + 1]
    if (!next) return { kind: 'end' as const, reason: endReason }
    index += 1
    return { kind: 'page' as const, snapshot: next }
  })
  const close = vi.fn(async () => undefined)
  const openDetail = vi.fn(async () => snapshots[index]!)
  const returnToList = vi.fn(async () => snapshots[index]!)
  const create = vi.fn(async () => ({ current, advance, openDetail, returnToList, close }))
  return { provider: { create }, create, current, advance, close }
}

const dynamicSnapshot = (page: number, title: string): DynamicPageSnapshot => ({
  html: `<main><div class="item"><span class="title">${title}</span></div></main>`,
  url: `https://example.com/dynamic#page-${page}`,
  itemCount: 1,
  signature: `page-${page}`
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('CollectorEngine', () => {
  it('returns detail samples when the link is the list item itself or its wrapper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-detail-samples-'))
    temporaryDirectories.push(root)
    const html = `
      <div id="project">
        <a href="/detail/1"><li><h1>标题一</h1></li></a>
        <a href="/detail/2"><li><h1>标题二</h1></li></a>
      </div>
    `
    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html,
      encoding: 'utf-8',
      retries: 0
    }))
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient
    )
    const rootTask = createTask('root-detail-samples')
    rootTask.listUrl = 'https://www.example.com/list'
    rootTask.listPageRules = [rootTask.listUrl]
    rootTask.listItem.selector = '#project > a'
    rootTask.detail.link.selector = ':scope'

    const wrappedTask = createTask('wrapped-detail-samples')
    wrappedTask.listUrl = rootTask.listUrl
    wrappedTask.listPageRules = [wrappedTask.listUrl]
    wrappedTask.listItem.selector = '#project > a > li'
    wrappedTask.detail.link.selector = 'a[href]'

    const expected = [
      'https://www.example.com/detail/1',
      'https://www.example.com/detail/2'
    ]
    await expect(engine.getDetailSamples(rootTask)).resolves.toEqual(expected)
    await expect(engine.getDetailSamples(wrappedTask)).resolves.toEqual(expected)
  })

  it('pauses only after committing the current page and resumes without losing records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-safe-pause-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-safe-pause', root)
    task.listPageRules = [
      'https://example.com/first.htm',
      'https://example.com/second.htm'
    ]
    task.output.recordsPerFile = 200
    const control = new CollectorRunControl()
    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => {
      if (url.endsWith('/first.htm')) control.pause()
      const title = url.endsWith('/first.htm') ? '第一条' : '第二条'
      return {
        kind: 'success',
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        html: `<div class="item"><span class="title">${title}</span></div>`,
        encoding: 'utf-8',
        retries: 0
      }
    })
    const store = new TaskStore(join(root, 'data'))
    const engine = new CollectorEngine(store, { fetchHtml } as unknown as HttpClient)

    const paused = await engine.run(task, null, control, {
      progress: () => undefined,
      log: () => undefined
    })
    const checkpoint = await store.getCheckpoint(task.id)

    expect(paused.status).toBe('paused')
    expect(checkpoint).toMatchObject({
      nextRuleIndex: 1,
      pagesVisited: 1,
      nextSequence: 1,
      seenKeys: ['第一条'],
      counters: { discovered: 1, succeeded: 1, skipped: 0, failed: 0 }
    })
    expect(checkpoint?.pendingRecords.map((record) => record.values.title)).toEqual(['第一条'])

    const resumed = await engine.run(task, checkpoint, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })
    expect(resumed.status).toBe('completed')
    expect(resumed.counters).toMatchObject({ discovered: 2, succeeded: 2, skipped: 0, failed: 0 })
    expect(fetchHtml.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/first.htm',
      'https://example.com/second.htm'
    ])
    const xml = await readOutputXml(resumed.outputFiles[0]!, 'utf-8')
    expect(xml).toContain('第一条')
    expect(xml).toContain('第二条')
  })

  it('keeps list order when detail requests complete out of order and splits XML batches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-'))
    temporaryDirectories.push(root)
    const task = createTask('task-run')
    task.name = '顺序测试'
    task.listUrl = 'https://www.example.com/list?page=1'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a'
    task.pagination.urlTemplate = 'https://www.example.com/list?page={page}'
    task.pagination.maxPages = 1
    task.request.delayMs = 0
    task.output.rootDirectory = join(root, 'exports')
    task.output.recordsPerFile = 2
    task.xml = configureXmlRecord(
      '<?xml version="1.0" encoding="UTF-8"?><book><article><title/><text/></article></book>',
      'template.xml',
      '/book/article'
    )
    const title = task.xml.mappings.find((mapping) => mapping.fieldPath === 'title')!
    title.mode = 'page'
    title.pageSource = 'list'
    title.selector = 'a'
    const text = task.xml.mappings.find((mapping) => mapping.fieldPath === 'text')!
    text.mode = 'page'
    text.pageSource = 'detail'
    text.selector = '#body'

    const listHtml = [1, 2, 3]
      .map((value) => `<div class="item"><a href="/detail/${value}">标题${value}</a></div>`)
      .join('')
    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => {
      if (url.includes('/list')) {
        return {
          kind: 'success',
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          html: listHtml,
          encoding: 'utf-8',
          retries: 0
        }
      }
      const id = Number(url.split('/').at(-1))
      await new Promise<void>((resolve) => setTimeout(resolve, (4 - id) * 5))
      return {
        kind: 'success',
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        html: `<div id="body">正文${id}</div>`,
        encoding: 'utf-8',
        retries: 0
      }
    })
    const client = { fetchHtml } as unknown as HttpClient
    const store = new TaskStore(join(root, 'data'))
    const engine = new CollectorEngine(store, client)
    const logMessages: string[] = []
    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: (log) => logMessages.push(log.message)
    })

    expect(result.status).toBe('completed')
    expect(result.outputFiles).toHaveLength(2)
    const first = await readOutputXml(result.outputFiles[0]!, 'utf-8')
    const second = await readOutputXml(result.outputFiles[1]!, 'utf-8')
    expect(first.indexOf('标题1')).toBeLessThan(first.indexOf('标题2'))
    expect(first).not.toContain('标题3')
    expect(second).toContain('标题3')
    expect(logMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('解析完成，共 3 条信息'),
        expect.stringContaining(
          '正在采集详情：列表页 1 · 第 1 条 · 标题1 · https://www.example.com/detail/1'
        ),
        expect.stringContaining(
          '采集成功：列表页 1 · 第 3 条 · 标题3 · https://www.example.com/detail/3'
        )
      ])
    )
    await expect(store.getCheckpoint(task.id)).resolves.toBeNull()
  })

  it('deduplicates a redirected external target against a direct external link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-redirect-'))
    temporaryDirectories.push(root)
    const task = createTask('task-redirect')
    task.name = '重定向去重'
    task.listUrl = 'https://www.example.com/list?page=1'
    task.listItem.selector = '.item'
    task.detail.link.selector = 'a'
    task.pagination.urlTemplate = 'https://www.example.com/list?page={page}'
    task.pagination.maxPages = 1
    task.request.delayMs = 0
    task.output.rootDirectory = join(root, 'exports')
    task.xml = configureXmlRecord(
      '<book><article><title/><outside/></article></book>',
      'template.xml',
      '/book/article'
    )
    const title = task.xml.mappings.find((mapping) => mapping.fieldPath === 'title')!
    title.mode = 'page'
    title.pageSource = 'list'
    title.selector = 'a'
    const outside = task.xml.mappings.find((mapping) => mapping.fieldPath === 'outside')!
    outside.mode = 'external-url'

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => {
      if (url.includes('/list')) {
        return {
          kind: 'success',
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          html:
            '<div class="item"><a href="/redirect">先出现</a></div>' +
            '<div class="item"><a href="https://outside.example/article">后出现</a></div>',
          encoding: 'utf-8',
          retries: 0
        }
      }
      return {
        kind: 'external-redirect',
        requestedUrl: url,
        finalUrl: 'https://outside.example/article',
        status: 302,
        retries: 0
      }
    })
    const store = new TaskStore(join(root, 'data'))
    const engine = new CollectorEngine(store, { fetchHtml } as unknown as HttpClient)
    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.counters.succeeded).toBe(1)
    expect(result.counters.duplicated).toBe(1)
  })

  it('processes fixed URLs around one template and limits only generated pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-rules-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-rules', root)
    task.listPageRules = [
      'https://example.com/first.htm',
      'https://example.com/list_{page}.htm',
      'https://example.com/last.htm'
    ]
    task.pagination.startPage = 2
    task.pagination.step = 1
    task.pagination.maxPages = 2

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html: `<div class="item"><span class="title">${url}</span></div>`,
      encoding: 'utf-8',
      retries: 0
    }))
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient
    )

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(fetchHtml.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/first.htm',
      'https://example.com/list_2.htm',
      'https://example.com/list_3.htm',
      'https://example.com/last.htm'
    ])
    expect(result.pagesVisited).toBe(4)
    expect(result.counters.succeeded).toBe(4)
  })

  it('supports descending pagination with a step smaller than minus one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-descending-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-descending', root)
    task.listPageRules = ['https://example.com/list_{page}.htm']
    task.pagination.startPage = 100
    task.pagination.step = -2
    task.pagination.maxPages = 3

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html: `<div class="item"><span class="title">${url}</span></div>`,
      encoding: 'utf-8',
      retries: 0
    }))
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient
    )

    await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(fetchHtml.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/list_100.htm',
      'https://example.com/list_98.htm',
      'https://example.com/list_96.htm'
    ])
  })

  it('replays an unfinished template page after a full batch checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-mid-page-resume-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-mid-page-resume', root)
    task.listPageRules = ['https://example.com/list_{page}.htm']
    task.pagination.startPage = 1
    task.pagination.step = 1
    task.pagination.maxPages = 1
    task.output.recordsPerFile = 1

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html:
        '<div class="item"><span class="title">记录1</span></div>' +
        '<div class="item"><span class="title">记录2</span></div>' +
        '<div class="item"><span class="title">记录3</span></div>',
      encoding: 'utf-8',
      retries: 0
    }))
    const store = new TaskStore(join(root, 'data'))
    const engine = new CollectorEngine(store, { fetchHtml } as unknown as HttpClient)
    const saveCheckpoint = store.saveCheckpoint.bind(store)
    let interrupted = false
    const saveSpy = vi.spyOn(store, 'saveCheckpoint').mockImplementation(async (checkpoint) => {
      await saveCheckpoint(checkpoint)
      if (!interrupted && checkpoint.outputFiles.length === 1) {
        interrupted = true
        throw new Error('模拟批次写出后的异常退出')
      }
    })

    const firstResult = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })
    expect(firstResult.status).toBe('failed')
    saveSpy.mockRestore()

    const checkpoint = await store.getCheckpoint(task.id)
    expect(checkpoint).toMatchObject({
      nextRuleIndex: 0,
      nextPage: 1,
      templatePagesVisited: 0,
      pagesVisited: 0,
      seenPageUrls: [],
      outputFiles: [expect.any(String)]
    })

    const resumedResult = await engine.run(task, checkpoint, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })
    const output = (
      await Promise.all(resumedResult.outputFiles.map((path) => readOutputXml(path, 'utf-8')))
    ).join('\n')

    expect(resumedResult.status).toBe('completed')
    expect(resumedResult.outputFiles).toHaveLength(3)
    expect(resumedResult.counters.succeeded).toBe(3)
    expect(fetchHtml.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/list_1.htm',
      'https://example.com/list_1.htm'
    ])
    expect(output).toContain('记录1')
    expect(output).toContain('记录2')
    expect(output).toContain('记录3')
  })

  it('keeps pending records recoverable when an XML batch write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-write-recovery-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-write-recovery', root)
    task.listPageRules = ['https://example.com/list_{page}.htm']
    task.pagination.maxPages = 1
    task.output.recordsPerFile = 1
    task.xml!.encoding = 'unsupported-encoding'

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html: '<div class="item"><span class="title">可恢复记录</span></div>',
      encoding: 'utf-8',
      retries: 0
    }))
    const store = new TaskStore(join(root, 'data'))
    const engine = new CollectorEngine(store, { fetchHtml } as unknown as HttpClient)

    const firstResult = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })
    expect(firstResult.status).toBe('failed')

    const checkpoint = await store.getCheckpoint(task.id)
    expect(checkpoint?.pendingRecords).toHaveLength(1)
    expect(checkpoint).toMatchObject({
      nextRuleIndex: 0,
      nextPage: 1,
      templatePagesVisited: 0,
      pagesVisited: 0,
      outputFiles: []
    })

    task.xml!.encoding = 'UTF-8'
    const resumedResult = await engine.run(task, checkpoint, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })
    const output = await readOutputXml(resumedResult.outputFiles[0]!, 'utf-8')

    expect(resumedResult.status).toBe('completed')
    expect(resumedResult.outputFiles).toHaveLength(1)
    expect(output).toContain('可恢复记录')
  })

  it('continues with later fixed URLs after a template reaches a natural end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-template-end-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-template-end', root)
    task.listPageRules = [
      'https://example.com/list_{page}.htm',
      'https://example.com/after.htm'
    ]
    task.pagination.startPage = 2
    task.pagination.step = 1
    task.pagination.maxPages = 10

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => {
      if (url.endsWith('list_3.htm')) {
        return { kind: 'not-found', requestedUrl: url, finalUrl: url, status: 404, retries: 0 }
      }
      return {
        kind: 'success',
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        html: `<div class="item"><span class="title">${url}</span></div>`,
        encoding: 'utf-8',
        retries: 0
      }
    })
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient
    )

    await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(fetchHtml.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/list_2.htm',
      'https://example.com/list_3.htm',
      'https://example.com/after.htm'
    ])
  })

  it('skips duplicate, missing, and empty fixed URLs but continues in order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-fixed-skip-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-fixed-skip', root)
    task.listPageRules = [
      'https://example.com/first.htm',
      'https://example.com/first.htm',
      'https://example.com/missing.htm',
      'https://example.com/empty.htm',
      'https://example.com/last.htm'
    ]

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => {
      if (url.endsWith('/missing.htm')) {
        return { kind: 'not-found', requestedUrl: url, finalUrl: url, status: 404, retries: 0 }
      }
      if (url.endsWith('/empty.htm')) {
        return {
          kind: 'success',
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          html: '<div>没有列表项</div>',
          encoding: 'utf-8',
          retries: 0
        }
      }
      return {
        kind: 'success',
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        html: `<div class="item"><span class="title">${url}</span></div>`,
        encoding: 'utf-8',
        retries: 0
      }
    })
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient
    )

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.pagesVisited).toBe(3)
    expect(result.counters.succeeded).toBe(2)
    expect(fetchHtml.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/first.htm',
      'https://example.com/missing.htm',
      'https://example.com/empty.htm',
      'https://example.com/last.htm'
    ])
  })

  it('resumes from the saved rule index and descending page value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resume-rules-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-resume-rules', root)
    task.listPageRules = [
      'https://example.com/first.htm',
      'https://example.com/list_{page}.htm',
      'https://example.com/after.htm'
    ]
    task.pagination.startPage = 100
    task.pagination.step = -1
    task.pagination.maxPages = 3
    const checkpoint: RunCheckpoint = {
      version: 1,
      taskId: task.id,
      runId: 'resume-run',
      startedAt: '2026-08-06T00:00:00.000Z',
      runStamp: '20260806_080000',
      nextRuleIndex: 1,
      nextPage: 99,
      templatePagesVisited: 1,
      nextSequence: 2,
      nextFileIndex: 1,
      pagesVisited: 2,
      seenPageUrls: [
        'https://example.com/first.htm',
        'https://example.com/list_100.htm'
      ],
      seenKeys: ['first', 'page-100'],
      pendingRecords: [],
      outputFiles: [],
      errorLogPath: '',
      counters: createEmptyCounters(),
      resources: createEmptyResourceCounters(),
      processedResourceUrls: []
    }
    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html: `<div class="item"><span class="title">${url}</span></div>`,
      encoding: 'utf-8',
      retries: 0
    }))
    const store = new TaskStore(join(root, 'data'))
    const engine = new CollectorEngine(store, { fetchHtml } as unknown as HttpClient)

    await engine.run(task, checkpoint, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(fetchHtml.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/list_99.htm',
      'https://example.com/list_98.htm',
      'https://example.com/after.htm'
    ])
  })

  it('collects rendered DOM pages until the dynamic next action ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-dynamic-pages-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-dynamic-pages', root)
    task.listPageRules = ['https://example.com/dynamic']
    task.pagination.mode = 'click'
    task.pagination.maxPages = 10
    task.pagination.nextButton.selector = '.next'
    const dynamic = createDynamicProvider([
      dynamicSnapshot(1, '动态记录1'),
      dynamicSnapshot(2, '动态记录2')
    ])
    const fetchHtml = vi.fn()
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient,
      dynamic.provider
    )
    const logs: string[] = []

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: (entry) => logs.push(entry.message)
    })
    const output = await readOutputXml(result.outputFiles[0]!, 'utf-8')

    expect(result.status).toBe('completed')
    expect(result.pagesVisited).toBe(2)
    expect(result.counters.succeeded).toBe(2)
    expect(output.indexOf('动态记录1')).toBeLessThan(output.indexOf('动态记录2'))
    expect(dynamic.advance).toHaveBeenCalledTimes(2)
    expect(dynamic.close).toHaveBeenCalledOnce()
    expect(fetchHtml).not.toHaveBeenCalled()
    expect(logs).toContain('页面中找不到下一页按钮')
  })

  it('clicks each configured list item to collect a JavaScript-rendered detail page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-click-detail-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-click-detail', root)
    task.listPageRules = ['https://example.com/catalog']
    task.detail.enabled = true
    task.detail.navigationMode = 'click'
    task.detail.link.selector = '.data-name'
    task.xml = configureXmlRecord(
      '<book><article><title/><text/></article></book>',
      'template.xml',
      '/book/article'
    )
    const title = task.xml.mappings.find((mapping) => mapping.fieldPath === 'title')!
    title.mode = 'page'
    title.pageSource = 'list'
    title.selector = '.data-name'
    const text = task.xml.mappings.find((mapping) => mapping.fieldPath === 'text')!
    text.mode = 'page'
    text.pageSource = 'detail'
    text.selector = '#content'

    const listSnapshot: DynamicPageSnapshot = {
      html:
        '<main><div class="item"><span class="data-name">目录一</span></div>' +
        '<div class="item"><span class="data-name">目录二</span></div></main>',
      url: task.listPageRules[0]!,
      itemCount: 2,
      signature: 'catalog'
    }
    const current = vi.fn(async () => listSnapshot)
    const openDetail = vi.fn(async (itemIndex: number): Promise<DynamicPageSnapshot> => ({
      html: `<main><div id="content">正文${itemIndex + 1}</div></main>`,
      url: `https://example.com/catalog#detail-${itemIndex + 1}`,
      itemCount: 0,
      signature: ''
    }))
    const returnToList = vi.fn(async () => listSnapshot)
    const close = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({
      current,
      openDetail,
      returnToList,
      close,
      advance: vi.fn(async () => ({ kind: 'end' as const, reason: '没有下一页' }))
    }))
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml: vi.fn() } as unknown as HttpClient,
      { create }
    )

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })
    const output = await readOutputXml(result.outputFiles[0]!, 'utf-8')

    expect(result.status).toBe('completed')
    expect(result.counters.succeeded).toBe(2)
    expect(openDetail.mock.calls.map(([index]) => index)).toEqual([0, 1])
    expect(returnToList).toHaveBeenCalledTimes(2)
    expect(output).toContain('正文1')
    expect(output).toContain('正文2')
    expect(output.indexOf('正文1')).toBeLessThan(output.indexOf('正文2'))
  })

  it('counts the initial dynamic page in the maximum page limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-dynamic-limit-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-dynamic-limit', root)
    task.listPageRules = ['https://example.com/dynamic']
    task.pagination.mode = 'click'
    task.pagination.maxPages = 2
    task.pagination.nextButton.selector = '.next'
    const dynamic = createDynamicProvider([
      dynamicSnapshot(1, '记录1'),
      dynamicSnapshot(2, '记录2'),
      dynamicSnapshot(3, '记录3')
    ])
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml: vi.fn() } as unknown as HttpClient,
      dynamic.provider
    )

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(result.pagesVisited).toBe(2)
    expect(result.counters.succeeded).toBe(2)
    expect(dynamic.advance).toHaveBeenCalledOnce()
    expect(result.message).toBe('动态分页已达到最大采集页数 2')
  })

  it('fast-forwards rendered pages when resuming a dynamic checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-dynamic-resume-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-dynamic-resume', root)
    task.listPageRules = ['https://example.com/dynamic']
    task.pagination.mode = 'click'
    task.pagination.maxPages = 2
    task.pagination.nextButton.selector = '.next'
    const checkpoint: RunCheckpoint = {
      version: 1,
      taskId: task.id,
      runId: 'dynamic-resume-run',
      startedAt: '2026-08-07T00:00:00.000Z',
      runStamp: '20260807_080000',
      nextRuleIndex: 0,
      nextPage: 1,
      templatePagesVisited: 0,
      nextSequence: 1,
      nextFileIndex: 1,
      pagesVisited: 1,
      seenPageUrls: ['dynamic:1:https://example.com/dynamic'],
      seenKeys: ['动态记录1'],
      pendingRecords: [],
      outputFiles: [],
      errorLogPath: '',
      counters: {
        ...createEmptyCounters(),
        discovered: 1,
        succeeded: 1
      },
      resources: createEmptyResourceCounters(),
      processedResourceUrls: []
    }
    const dynamic = createDynamicProvider([
      dynamicSnapshot(1, '动态记录1'),
      dynamicSnapshot(2, '动态记录2')
    ])
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml: vi.fn() } as unknown as HttpClient,
      dynamic.provider
    )

    const result = await engine.run(task, checkpoint, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.pagesVisited).toBe(2)
    expect(result.counters.succeeded).toBe(2)
    expect(dynamic.advance).toHaveBeenCalledOnce()
  })

  it('previews resource plans during test collection without downloading or creating directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resource-preview-'))
    temporaryDirectories.push(root)
    const task = createResourceTask('task-resource-preview', root)
    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html:
        '<div class="item"><span class="title">记录1</span>' +
        '<div class="body"><img src="/images/preview.jpg"></div></div>',
      encoding: 'utf-8',
      retries: 0
    }))
    const download = vi.fn()
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient,
      null,
      { download } as unknown as ResourceDownloader
    )

    const result = await engine.testTask(task)

    expect(result.records).toHaveLength(1)
    expect(result.resourcePlans).toHaveLength(1)
    expect(result.resourcePlans[0]?.xmlUrl).toBe('/resources/images/preview.jpg')
    expect(download).not.toHaveBeenCalled()
    await expect(stat(task.resources.download.rootDirectory)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('keeps a record when an optional date conversion fails and logs the warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-date-warning-'))
    temporaryDirectories.push(root)
    const task = createListOnlyTask('task-date-warning', root)
    task.listUrl = 'https://example.com/list'
    task.listPageRules = [task.listUrl]
    task.xml = configureXmlRecord(
      '<book><article><title/><published/></article></book>',
      'date-template.xml',
      '/book/article'
    )
    const title = task.xml.mappings.find((mapping) => mapping.fieldPath === 'title')!
    title.mode = 'page'
    title.pageSource = 'list'
    title.selector = '.title'
    const published = task.xml.mappings.find((mapping) => mapping.fieldPath === 'published')!
    published.mode = 'page'
    published.pageSource = 'list'
    published.selector = '.published'
    published.convertToTimestamp = true
    task.dedupeFieldPath = 'title'

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html:
        '<div class="item"><span class="title">正常记录</span>' +
        '<span class="published">不是日期</span></div>',
      encoding: 'utf-8',
      retries: 0
    }))
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient
    )

    const preview = await engine.testTask(task)

    expect(preview.records).toHaveLength(1)
    expect(preview.rows[0]?.published).toBe('')
    expect(preview.failures).toEqual([
      expect.objectContaining({
        stage: 'date-conversion',
        fieldPath: 'published',
        listUrl: task.listUrl,
        reason: expect.stringContaining('不是日期')
      })
    ])

    const logs: string[] = []
    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: (entry) => logs.push(entry.message)
    })

    expect(result.status).toBe('completed')
    expect(result.counters).toMatchObject({ succeeded: 1, skipped: 0, failed: 0 })
    const xml = await readOutputXml(result.outputFiles[0]!, task.xml.encoding)
    expect(xml).toContain('<title>正常记录</title>')
    expect(xml).toContain('<published></published>')
    const errorLog = await readFile(result.errorLogPath, 'utf8')
    expect(errorLog).toContain('date-conversion')
    expect(errorLog).toContain('published')
    expect(errorLog).toContain('不是日期')
    expect(errorLog).toContain(task.listUrl)
    expect(logs.some((message) => message.includes('date-conversion/published'))).toBe(true)
  })

  it('downloads the same planned resource only once across multiple records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resource-dedupe-'))
    temporaryDirectories.push(root)
    const task = createResourceTask('task-resource-dedupe', root)
    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html:
        '<div class="item"><span class="title">记录1</span><div class="body"><img src="/images/shared.jpg"></div></div>' +
        '<div class="item"><span class="title">记录2</span><div class="body"><img src="/images/shared.jpg"></div></div>',
      encoding: 'utf-8',
      retries: 0
    }))
    const download = vi.fn(async (plan: { localPath: string }) => ({
      kind: 'downloaded' as const,
      path: plan.localPath,
      retries: 0
    }))
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient,
      null,
      { download } as unknown as ResourceDownloader
    )

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.resources).toEqual({ downloaded: 1, skipped: 0, failed: 0 })
    expect(download).toHaveBeenCalledOnce()
    const xml = await readOutputXml(result.outputFiles[0]!, task.xml!.encoding)
    expect(xml.match(/\/resources\/images\/shared\.jpg/g)).toHaveLength(2)
  })

  it('keeps XML records and writes detailed error data when a resource download fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resource-failure-'))
    temporaryDirectories.push(root)
    const task = createResourceTask('task-resource-failure', root)
    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html:
        '<div class="item"><span class="title">记录1</span><div class="body"><img src="/images/missing.jpg"></div></div>',
      encoding: 'utf-8',
      retries: 0
    }))
    const download = vi.fn(async () => {
      throw new Error('磁盘写入失败')
    })
    const engine = new CollectorEngine(
      new TaskStore(join(root, 'data')),
      { fetchHtml } as unknown as HttpClient,
      null,
      { download } as unknown as ResourceDownloader
    )

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.counters.succeeded).toBe(1)
    expect(result.resources.failed).toBe(1)
    const xml = await readOutputXml(result.outputFiles[0]!, task.xml!.encoding)
    expect(xml).toContain('/resources/images/missing.jpg')
    const errorLog = await readFile(result.errorLogPath, 'utf8')
    expect(errorLog).toContain('https://example.com/images/missing.jpg')
    expect(errorLog).toContain('/resources/images/missing.jpg')
    expect(errorLog).toContain('磁盘写入失败')
  })
})
