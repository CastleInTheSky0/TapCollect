import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyCounters,
  createEmptyResourceCounters,
  createTask
} from '@shared/defaults'
import type {
  RunCheckpoint,
  RunProgress,
  RunResult,
  RunSessionSnapshot,
  TaskConfig,
  TestCollectionResult
} from '@shared/types'
import type {
  CollectorEvents,
  CollectorRunResult
} from '@main/core/collector-engine'
import { CollectorRunControl } from '@main/core/collector-engine'
import { configureXmlRecord } from '@main/core/xml-template'
import { RunManager } from './run-manager'
import { TaskStore } from './task-store'

const temporaryDirectories: string[] = []

const flushTasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const runnableTask = (
  id: string,
  root: string,
  name = id,
  outputRoot = join(root, 'exports')
): TaskConfig => {
  const task = createTask(id)
  task.name = name
  task.listPageRules = [`https://example.com/${id}`]
  task.listUrl = task.listPageRules[0]!
  task.listItem.selector = '.item'
  task.detail.enabled = false
  task.output.rootDirectory = outputRoot
  task.xml = configureXmlRecord(
    '<book><article><title/></article></book>',
    'template.xml',
    '/book/article'
  )
  const mapping = task.xml.mappings[0]!
  mapping.mode = 'fixed'
  mapping.fixedValue = id
  task.dedupeFieldPath = task.xml.fields[0]!.path
  return task
}

const checkpointFor = (task: TaskConfig, runId = `run-${task.id}`): RunCheckpoint => ({
  version: 1,
  taskId: task.id,
  runId,
  startedAt: '2026-08-08T00:00:00.000Z',
  runStamp: '20260808_080000',
  nextRuleIndex: 0,
  nextPage: 1,
  templatePagesVisited: 0,
  nextSequence: 0,
  nextFileIndex: 1,
  pagesVisited: 0,
  seenPageUrls: [],
  seenKeys: [],
  pendingRecords: [],
  outputFiles: [],
  errorLogPath: '',
  counters: createEmptyCounters(),
  resources: createEmptyResourceCounters(),
  processedResourceUrls: []
})

const terminalResult = (
  checkpoint: RunCheckpoint,
  status: RunResult['status'] = 'completed'
): RunResult => ({
  runId: checkpoint.runId,
  taskId: checkpoint.taskId,
  status,
  startedAt: checkpoint.startedAt,
  finishedAt: '2026-08-08T00:01:00.000Z',
  pagesVisited: checkpoint.pagesVisited,
  outputFiles: checkpoint.outputFiles,
  errorLogPath: checkpoint.errorLogPath,
  counters: checkpoint.counters,
  resources: checkpoint.resources,
  message: status === 'completed' ? '采集完成' : '任务已取消'
})

class FakeCollectorEngine {
  readonly started: string[] = []
  private readonly pending = new Map<
    string,
    {
      checkpoint: RunCheckpoint
      control: CollectorRunControl
      resolve: (result: CollectorRunResult) => void
    }
  >()
  private testResolve: ((result: TestCollectionResult) => void) | null = null

  constructor(private readonly store: TaskStore) {}

  async getDetailSamples(): Promise<string[]> {
    return []
  }

  testTask(): Promise<TestCollectionResult> {
    return new Promise<TestCollectionResult>((resolve) => {
      this.testResolve = resolve
    })
  }

  async run(
    task: TaskConfig,
    resumeCheckpoint: RunCheckpoint | null,
    control: CollectorRunControl,
    events: CollectorEvents
  ): Promise<CollectorRunResult> {
    const checkpoint = resumeCheckpoint ?? checkpointFor(task)
    control.setCheckpoint(checkpoint)
    this.started.push(task.id)
    const progress: RunProgress = {
      runId: checkpoint.runId,
      taskId: task.id,
      status: 'running',
      stage: 'list',
      page: 1,
      maxPages: task.pagination.maxPages,
      currentUrl: task.listUrl,
      currentFile: '',
      recordsInCurrentFile: 0,
      counters: createEmptyCounters(),
      resources: createEmptyResourceCounters(),
      message: '正在采集'
    }
    events.progress(progress)
    events.log({
      runId: checkpoint.runId,
      taskId: task.id,
      level: 'info',
      time: '2026-08-08T00:00:00.000Z',
      message: `开始 ${task.name}`
    })
    if (control.isCancelled()) return terminalResult(checkpoint, 'cancelled')
    return new Promise<CollectorRunResult>((resolve) => {
      this.pending.set(task.id, { checkpoint, control, resolve })
    })
  }

  complete(taskId: string): void {
    const pending = this.pending.get(taskId)
    if (!pending) throw new Error(`No pending run for ${taskId}`)
    this.pending.delete(taskId)
    pending.resolve(terminalResult(pending.checkpoint))
  }

  async settlePause(taskId: string): Promise<void> {
    const pending = this.pending.get(taskId)
    if (!pending || !pending.control.isPaused()) throw new Error(`Run ${taskId} is not pausing`)
    this.pending.delete(taskId)
    await this.store.saveCheckpoint(pending.checkpoint)
    pending.resolve({
      ...terminalResult(pending.checkpoint),
      status: 'paused',
      message: '任务已暂停，当前安全进度已保存'
    })
  }

  completeTest(): void {
    if (!this.testResolve) throw new Error('No pending test collection')
    this.testResolve({
      records: [],
      rows: [],
      matchCounts: {},
      failures: [],
      listItemCount: 0,
      xmlPreview: '',
      resourcePlans: [],
      messages: []
    })
    this.testResolve = null
  }

  hasPendingTest(): boolean {
    return this.testResolve !== null
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('RunManager', () => {
  it('runs up to the configured limit and fills freed slots in FIFO order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-fifo-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveSettings({ defaultOutputDirectory: '', maxConcurrentRuns: 2 })
    for (const id of ['task-a', 'task-b', 'task-c']) {
      await store.saveTask(runnableTask(id, root))
    }
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    await manager.start('task-a', false)
    await manager.start('task-b', false)
    await manager.start('task-c', false)

    expect(engine.started).toEqual(['task-a', 'task-b'])
    expect(manager.getSessionSnapshot()).toMatchObject({ activeCount: 2, queuedCount: 1 })
    expect(
      manager.getSessionSnapshot().items.find((item) => item.taskId === 'task-c')
    ).toMatchObject({ status: 'queued', queuePosition: 1 })

    engine.complete('task-a')
    await flushTasks()

    expect(engine.started).toEqual(['task-a', 'task-b', 'task-c'])
    expect(manager.getSessionSnapshot()).toMatchObject({ activeCount: 2, queuedCount: 0 })
  })

  it('reserves a task before async loading so duplicate starts cannot race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-start-race-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveTask(runnableTask('task-a', root))
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    const attempts = await Promise.allSettled([
      manager.start('task-a', false),
      manager.start('task-a', false)
    ])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    expect(engine.started).toEqual(['task-a'])

    engine.complete('task-a')
    await flushTasks()
  })

  it('rejects a saved disabled-detail mapping conflict before the collector starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-detail-source-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    const task = runnableTask('task-a', root)
    const mapping = task.xml!.mappings[0]!
    mapping.mode = 'page'
    mapping.pageSource = 'detail'
    mapping.selector = '#content'
    await store.saveTask(task)
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    await expect(manager.start(task.id, false)).rejects.toThrow(
      '页面来源不能选择“详情页”：title'
    )

    expect(engine.started).toEqual([])
    expect(manager.getSessionSnapshot().items).toEqual([])
  })

  it('keeps output-conflicting work queued while starting a later independent task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-output-lock-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveSettings({ defaultOutputDirectory: '', maxConcurrentRuns: 2 })
    await store.saveTask(runnableTask('task-a', root, '相同目录'))
    await store.saveTask(runnableTask('task-b', root, '相同目录'))
    await store.saveTask(runnableTask('task-c', root, '独立目录'))
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    await manager.start('task-a', false)
    await manager.start('task-b', false)
    await manager.start('task-c', false)

    expect(engine.started).toEqual(['task-a', 'task-c'])
    expect(
      manager.getSessionSnapshot().items.find((item) => item.taskId === 'task-b')
    ).toMatchObject({
      status: 'queued',
      queueReason: 'output-lock',
      message: '等待同输出目录任务完成'
    })
  })

  it('fills new slots immediately when raised and converges safely when lowered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-limit-change-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveSettings({ defaultOutputDirectory: '', maxConcurrentRuns: 1 })
    for (const id of ['task-a', 'task-b', 'task-c']) {
      await store.saveTask(runnableTask(id, root))
    }
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    await manager.start('task-a', false)
    await manager.start('task-b', false)
    manager.setMaxConcurrentRuns(2)
    expect(engine.started).toEqual(['task-a', 'task-b'])

    await manager.start('task-c', false)
    manager.setMaxConcurrentRuns(1)
    engine.complete('task-a')
    await flushTasks()
    expect(engine.started).toEqual(['task-a', 'task-b'])
    expect(manager.getSessionSnapshot()).toMatchObject({ activeCount: 1, queuedCount: 1 })

    engine.complete('task-b')
    await flushTasks()
    expect(engine.started).toEqual(['task-a', 'task-b', 'task-c'])
  })

  it('releases a formal slot after a safe pause and requeues the task on continue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-pause-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveSettings({ defaultOutputDirectory: '', maxConcurrentRuns: 1 })
    await store.saveTask(runnableTask('task-a', root))
    await store.saveTask(runnableTask('task-b', root))
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    await manager.start('task-a', false)
    await manager.start('task-b', false)
    await manager.pause('task-a')
    expect(
      manager.getSessionSnapshot().items.find((item) => item.taskId === 'task-a')?.status
    ).toBe('pausing')

    await engine.settlePause('task-a')
    await flushTasks()

    expect(engine.started).toEqual(['task-a', 'task-b'])
    expect(
      manager.getSessionSnapshot().items.find((item) => item.taskId === 'task-a')?.status
    ).toBe('paused')

    await manager.resume('task-a')
    expect(
      manager.getSessionSnapshot().items.find((item) => item.taskId === 'task-a')
    ).toMatchObject({ status: 'queued', queuePosition: 1 })
  })

  it('keeps the single test slot separate from formal run capacity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-test-slot-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveSettings({ defaultOutputDirectory: '', maxConcurrentRuns: 1 })
    await store.saveTask(runnableTask('test-task', root))
    await store.saveTask(runnableTask('formal-task', root))
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    const testPromise = manager.testTask('test-task')
    for (let attempt = 0; attempt < 20 && !engine.hasPendingTest(); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    expect(manager.getSessionSnapshot()).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
      testingTaskId: 'test-task'
    })

    await manager.start('formal-task', false)
    expect(engine.started).toEqual(['formal-task'])
    expect(manager.getSessionSnapshot()).toMatchObject({
      activeCount: 1,
      queuedCount: 0,
      testingTaskId: 'test-task'
    })
    await expect(manager.start('test-task', false)).rejects.toThrow('正在执行测试采集')
    await expect(manager.deleteTask('test-task')).rejects.toThrow(
      '运行、暂停、排队或测试中的任务不能删除'
    )

    engine.completeTest()
    await testPromise
    expect(manager.getSessionSnapshot().testingTaskId).toBe('')
  })

  it('reserves the single test slot before loading a task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-test-race-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveTask(runnableTask('test-a', root))
    await store.saveTask(runnableTask('test-b', root))
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    const firstTest = manager.testTask('test-a')
    await expect(manager.testTask('test-b')).rejects.toThrow('已有测试采集正在执行')
    for (let attempt = 0; attempt < 20 && !engine.hasPendingTest(); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    engine.completeTest()
    await firstTest
  })

  it('restores queued and active work when an update installer cannot be opened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-shutdown-restore-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveSettings({ defaultOutputDirectory: '', maxConcurrentRuns: 1 })
    await store.saveTask(runnableTask('task-a', root))
    await store.saveTask(runnableTask('task-b', root))
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    await manager.start('task-a', false)
    await manager.start('task-b', false)
    const shutdown = manager.prepareForShutdown()
    await engine.settlePause('task-a')
    const snapshot = await shutdown

    expect(manager.getSessionSnapshot().items.map((item) => item.status)).toEqual([
      'paused',
      'cancelled'
    ])

    await manager.restoreAfterFailedShutdown(snapshot)
    expect(manager.getSessionSnapshot().items.map((item) => item.status)).toEqual([
      'preparing',
      'queued'
    ])
    expect(manager.getSessionSnapshot().activeCount).toBe(1)

    for (let attempt = 0; attempt < 20 && engine.started.length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    expect(engine.started).toEqual(['task-a', 'task-a'])

    engine.complete('task-a')
    await flushTasks()
    expect(engine.started).toEqual(['task-a', 'task-a', 'task-b'])
    engine.complete('task-b')
    await flushTasks()
  })

  it('removes a completed task from the session while keeping collected output files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-delete-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveTask(runnableTask('task-a', root))
    const outputFile = join(root, 'exports', 'task-a', 'existing.xml')
    await mkdir(join(root, 'exports', 'task-a'), { recursive: true })
    await writeFile(outputFile, '<records/>', 'utf8')
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    await manager.start('task-a', false)
    await expect(manager.deleteTask('task-a')).rejects.toThrow(
      '运行、暂停、排队或测试中的任务不能删除'
    )
    expect(await store.loadTask('task-a')).not.toBeNull()

    engine.complete('task-a')
    await flushTasks()
    expect(manager.getSessionSnapshot().items).toHaveLength(1)

    const emittedSnapshots: RunSessionSnapshot[] = []
    const unsubscribe = manager.onSession((snapshot) => emittedSnapshots.push(snapshot))
    await expect(manager.deleteTask('task-a')).resolves.toBe(true)
    unsubscribe()

    expect(await store.loadTask('task-a')).toBeNull()
    expect(manager.getSessionSnapshot().items).toEqual([])
    expect(emittedSnapshots.at(-1)?.items).toEqual([])
    expect(await readFile(outputFile, 'utf8')).toBe('<records/>')
  })

  it('reserves a task while its deletion is waiting on storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-run-manager-delete-race-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(root)
    await store.initialize()
    await store.saveTask(runnableTask('task-a', root))
    const engine = new FakeCollectorEngine(store)
    const manager = new RunManager(store, null, engine)
    await manager.initialize()

    const originalDeleteTask = store.deleteTask.bind(store)
    let releaseDeletion = (): void => undefined
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve
    })
    vi.spyOn(store, 'deleteTask').mockImplementation(async (taskId) => {
      await deletionGate
      return originalDeleteTask(taskId)
    })

    const deletion = manager.deleteTask('task-a')
    await expect(manager.start('task-a', false)).rejects.toThrow('该任务正在删除')
    await expect(manager.testTask('task-a')).rejects.toThrow('该任务正在删除')
    releaseDeletion()

    await expect(deletion).resolves.toBe(true)
    expect(await store.loadTask('task-a')).toBeNull()
  })
})
