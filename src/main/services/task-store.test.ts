import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEmptyCounters,
  createEmptyResourceCounters,
  createTask
} from '@shared/defaults'
import type { RunCheckpoint } from '@shared/types'
import { configureXmlRecord } from '@main/core/xml-template'
import { TaskStore } from './task-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('TaskStore', () => {
  it('migrates legacy settings and clamps the formal task concurrency limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-store-settings-'))
    temporaryDirectories.push(root)
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ defaultOutputDirectory: ' D:/output ' }),
      'utf8'
    )
    const store = new TaskStore(root)

    await expect(store.getSettings()).resolves.toEqual({
      defaultOutputDirectory: 'D:/output',
      maxConcurrentRuns: 3
    })
    await expect(
      store.saveSettings({ defaultOutputDirectory: ' D:/next ', maxConcurrentRuns: 99 })
    ).resolves.toEqual({
      defaultOutputDirectory: 'D:/next',
      maxConcurrentRuns: 5
    })
  })

  it('preserves ordered multiline list-page rules across save and reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-store-rules-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    const task = createTask('rules-task')
    task.listPageRules = [
      ' https://www.example.com/news/node.htm ',
      '',
      'https://www.example.com/news/node_{page}.htm',
      'https://www.example.com/news/special.htm'
    ]
    task.pagination.startPage = 2
    task.pagination.step = -2
    task.pagination.maxPages = 8

    await store.saveTask(task)
    const loaded = await store.loadTask(task.id)

    expect(loaded?.listPageRules).toEqual([
      'https://www.example.com/news/node.htm',
      'https://www.example.com/news/node_{page}.htm',
      'https://www.example.com/news/special.htm'
    ])
    expect(loaded?.listUrl).toBe('https://www.example.com/news/node.htm')
    expect(loaded?.pagination).toMatchObject({
      urlTemplate: 'https://www.example.com/news/node_{page}.htm',
      startPage: 2,
      step: -2,
      maxPages: 8
    })
  })

  it('loads legacy pagination tasks into the ordered rule model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-store-legacy-'))
    temporaryDirectories.push(root)
    const task = createTask('legacy-task')
    task.listUrl = 'https://example.com/list?page=1'
    task.pagination.urlTemplate = 'https://example.com/list?page={page}'
    const legacy = JSON.parse(JSON.stringify(task)) as Record<string, unknown>
    delete legacy.listPageRules
    delete legacy.resources
    delete (legacy.pagination as Record<string, unknown>).mode
    delete (legacy.pagination as Record<string, unknown>).step
    delete (legacy.pagination as Record<string, unknown>).nextButton
    const taskDirectory = join(root, 'tasks', task.id)
    await mkdir(taskDirectory, { recursive: true })
    await writeFile(join(taskDirectory, 'task.json'), JSON.stringify(legacy), 'utf8')

    const store = new TaskStore(root)
    const loaded = await store.loadTask(task.id)

    expect(loaded?.listPageRules).toEqual(['https://example.com/list?page={page}'])
    expect(loaded?.listUrl).toBe('https://example.com/list?page=1')
    expect(loaded?.pagination.step).toBe(1)
    expect(loaded?.pagination.mode).toBe('url')
    expect(loaded?.pagination.nextButton).toEqual({ selectorType: 'css', selector: '' })
    expect(loaded?.resources).toEqual({
      addressMode: 'absolute-replace',
      urlPrefix: '',
      download: { enabled: false, rootDirectory: '', urlPrefix: '' }
    })
  })

  it('preserves click-pagination configuration across save and reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-store-click-pagination-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    const task = createTask('click-pagination-task')
    task.listPageRules = ['https://example.com/dynamic']
    task.pagination.mode = 'click'
    task.pagination.maxPages = 25
    task.pagination.nextButton = { selectorType: 'xpath', selector: '//a[@title="下页"]' }

    await store.saveTask(task)
    const loaded = await store.loadTask(task.id)

    expect(loaded?.pagination).toMatchObject({
      mode: 'click',
      maxPages: 25,
      nextButton: { selectorType: 'xpath', selector: '//a[@title="下页"]' }
    })
  })

  it('normalizes resource prefixes and preserves download configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-store-resources-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    const task = createTask('resource-task')
    task.resources.addressMode = 'prefix'
    task.resources.urlPrefix = '/resources///'
    task.resources.download = {
      enabled: true,
      rootDirectory: ' D:/resource-root ',
      urlPrefix: 'https://static.example.com/resources/'
    }

    await store.saveTask(task)
    const loaded = await store.loadTask(task.id)

    expect(loaded?.resources).toEqual({
      addressMode: 'prefix',
      urlPrefix: '/resources',
      download: {
        enabled: true,
        rootDirectory: 'D:/resource-root',
        urlPrefix: 'https://static.example.com/resources'
      }
    })
  })

  it('adds merge defaults when loading a task saved before merge mappings existed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-store-legacy-merge-'))
    temporaryDirectories.push(root)
    const task = createTask('legacy-merge-task')
    task.xml = configureXmlRecord(
      '<book><article><title/></article></book>',
      'template.xml',
      '/book/article'
    )
    const mapping = task.xml.mappings[0]!
    mapping.mode = 'page'
    mapping.selector = '.title'
    const legacy = JSON.parse(JSON.stringify(task)) as Record<string, unknown>
    const legacyXml = legacy.xml as { mappings: Array<Record<string, unknown>> }
    delete legacyXml.mappings[0]!.mergeSeparator
    delete legacyXml.mappings[0]!.mergeValues
    const taskDirectory = join(root, 'tasks', task.id)
    await mkdir(taskDirectory, { recursive: true })
    await writeFile(join(taskDirectory, 'task.json'), JSON.stringify(legacy), 'utf8')

    const loaded = await new TaskStore(root).loadTask(task.id)

    expect(loaded?.xml?.mappings[0]).toMatchObject({
      mode: 'page',
      selector: '.title',
      mergeSeparator: '',
      mergeValues: []
    })
  })

  it('persists pending records separately and restores a checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-store-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    const task = await store.saveTask(createTask('task-1'))
    const checkpoint: RunCheckpoint = {
      version: 1,
      taskId: task.id,
      runId: 'run-1',
      startedAt: '2026-08-06T00:00:00.000Z',
      runStamp: '20260806_080000',
      nextRuleIndex: 0,
      nextPage: 2,
      templatePagesVisited: 1,
      nextSequence: 1,
      nextFileIndex: 1,
      pagesVisited: 1,
      seenPageUrls: ['https://example.com/list?page=1'],
      seenKeys: ['https://example.com/detail/1'],
      pendingRecords: [
        {
          sequence: 0,
          collectedAt: '2026-08-06T00:00:00.000Z',
          page: 1,
          itemIndex: 1,
          listUrl: 'https://example.com/list?page=1',
          detailUrl: 'https://example.com/detail/1',
          externalUrl: '',
          values: { title: '标题' },
          resources: []
        }
      ],
      outputFiles: [],
      errorLogPath: '',
      counters: createEmptyCounters(),
      resources: createEmptyResourceCounters(),
      processedResourceUrls: ['https://example.com/image.jpg']
    }
    await store.saveCheckpoint(checkpoint)
    await expect(store.getCheckpoint(task.id)).resolves.toEqual(checkpoint)
    await store.clearCheckpoint(task.id)
    await expect(store.getCheckpoint(task.id)).resolves.toBeNull()
  })

  it('adds resource defaults when restoring a checkpoint saved before resource downloads existed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-store-legacy-resource-checkpoint-'))
    temporaryDirectories.push(root)
    const taskId = 'legacy-resource-checkpoint'
    const checkpointDirectory = join(root, 'checkpoints', taskId)
    await mkdir(checkpointDirectory, { recursive: true })
    await writeFile(
      join(checkpointDirectory, 'checkpoint.json'),
      JSON.stringify({
        version: 1,
        taskId,
        runId: 'run-legacy',
        startedAt: '2026-08-06T00:00:00.000Z',
        runStamp: '20260806_080000',
        nextRuleIndex: 0,
        nextPage: 1,
        templatePagesVisited: 0,
        nextSequence: 0,
        nextFileIndex: 1,
        pagesVisited: 0,
        seenPageUrls: [],
        seenKeys: [],
        outputFiles: [],
        errorLogPath: '',
        counters: createEmptyCounters()
      }),
      'utf8'
    )

    const checkpoint = await new TaskStore(root).getCheckpoint(taskId)

    expect(checkpoint?.resources).toEqual(createEmptyResourceCounters())
    expect(checkpoint?.processedResourceUrls).toEqual([])
    expect(checkpoint?.pendingRecords).toEqual([])
  })
})
