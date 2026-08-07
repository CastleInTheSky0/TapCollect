import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyCounters, createTask } from '@shared/defaults'
import { configureXmlRecord } from './xml-template'
import type { FetchHtmlResult, HttpClient } from './http-client'
import { CollectorEngine, CollectorRunControl } from './collector-engine'
import { TaskStore } from '@main/services/task-store'
import { readOutputXml } from '@main/services/output-writer'
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('CollectorEngine', () => {
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
    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.outputFiles).toHaveLength(2)
    const first = await readOutputXml(result.outputFiles[0]!, 'utf-8')
    const second = await readOutputXml(result.outputFiles[1]!, 'utf-8')
    expect(first.indexOf('标题1')).toBeLessThan(first.indexOf('标题2'))
    expect(first).not.toContain('标题3')
    expect(second).toContain('标题3')
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
      counters: createEmptyCounters()
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
})
