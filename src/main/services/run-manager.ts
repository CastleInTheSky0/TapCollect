import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { net } from 'electron'
import {
  createEmptyCounters,
  createEmptyResourceCounters,
  normalizeMaxConcurrentRuns,
  taskConfigurationIssues
} from '@shared/defaults'
import type {
  RunCheckpoint,
  RunLog,
  RunProgress,
  RunResult,
  RunSessionItem,
  RunSessionSnapshot,
  StartRunResult,
  TaskConfig,
  TestCollectionResult
} from '@shared/types'
import {
  CollectorEngine,
  CollectorRunControl,
  type CollectorEvents,
  type CollectorRunResult
} from '@main/core/collector-engine'
import type { DynamicPageProvider } from '@main/core/dynamic-page'
import { HttpClient } from '@main/core/http-client'
import { sanitizeFileName } from '@main/core/url-utils'
import type { TaskStore } from './task-store'

const ACTIVE_STATUSES = new Set<RunSessionItem['status']>([
  'preparing',
  'running',
  'pausing'
])
const LOCKED_STATUSES = new Set<RunSessionItem['status']>([
  'queued',
  'preparing',
  'running',
  'pausing',
  'paused'
])
const MAX_RETAINED_LOGS = 500

interface CollectorEngineLike {
  getDetailSamples(task: TaskConfig): Promise<string[]>
  testTask(task: TaskConfig): Promise<TestCollectionResult>
  run(
    task: TaskConfig,
    resumeCheckpoint: RunCheckpoint | null,
    control: CollectorRunControl,
    events: CollectorEvents
  ): Promise<CollectorRunResult>
}

interface ManagedRun {
  task: TaskConfig
  outputKey: string
  item: RunSessionItem
  control: CollectorRunControl | null
  execution: Promise<void> | null
  pauseOrder: number
  finalizingCancellation: boolean
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const normalizedOutputKey = (task: TaskConfig): string => {
  const path = resolve(join(task.output.rootDirectory, sanitizeFileName(task.name)))
  return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
}

const nowIso = (): string => new Date().toISOString()

export class RunManager extends EventEmitter {
  private readonly runs = new Map<string, ManagedRun>()
  private readonly queue: string[] = []
  private readonly outputLocks = new Map<string, string>()
  private readonly startingTaskIds = new Set<string>()
  private readonly engine: CollectorEngineLike
  private maxConcurrentRuns = 3
  private testingTaskId = ''
  private pauseSequence = 0
  private shuttingDown = false

  constructor(
    private readonly store: TaskStore,
    dynamicPageProvider: DynamicPageProvider | null = null,
    engine: CollectorEngineLike | null = null
  ) {
    super()
    this.engine =
      engine ??
      new CollectorEngine(
        store,
        new HttpClient(net.fetch as typeof fetch),
        dynamicPageProvider
      )
  }

  async initialize(): Promise<void> {
    const settings = await this.store.getSettings()
    this.maxConcurrentRuns = normalizeMaxConcurrentRuns(settings.maxConcurrentRuns)
  }

  hasActiveRun(): boolean {
    return (
      Boolean(this.testingTaskId) ||
      this.startingTaskIds.size > 0 ||
      [...this.runs.values()].some(({ item }) => LOCKED_STATUSES.has(item.status))
    )
  }

  isTaskLocked(taskId: string): boolean {
    if (this.startingTaskIds.has(taskId)) return true
    const managed = this.runs.get(taskId)
    return Boolean(managed && LOCKED_STATUSES.has(managed.item.status))
  }

  isTaskMutationLocked(taskId: string): boolean {
    return this.testingTaskId === taskId || this.isTaskLocked(taskId)
  }

  getSessionSnapshot(): RunSessionSnapshot {
    this.refreshQueueMetadata()
    return clone({
      maxConcurrentRuns: this.maxConcurrentRuns,
      activeCount: this.activeCount(),
      queuedCount: this.queue.length,
      testingTaskId: this.testingTaskId,
      items: [...this.runs.values()].map(({ item }) => item)
    })
  }

  setMaxConcurrentRuns(value: number): void {
    const normalized = normalizeMaxConcurrentRuns(value)
    if (normalized === this.maxConcurrentRuns) return
    this.maxConcurrentRuns = normalized
    this.schedule()
    this.emitSession()
  }

  async getDetailSamples(taskId: string): Promise<string[]> {
    return this.withTestSlot(taskId, async (task) => this.engine.getDetailSamples(task))
  }

  async testTask(taskId: string): Promise<TestCollectionResult> {
    return this.withTestSlot(taskId, async (task) => this.engine.testTask(task))
  }

  async start(taskId: string, resume: boolean): Promise<StartRunResult> {
    if (this.shuttingDown) throw new Error('应用正在退出，不能开始新任务')
    if (this.testingTaskId === taskId) throw new Error('该任务正在执行测试采集')
    if (this.isTaskLocked(taskId)) throw new Error('该任务已经在运行、暂停或排队中')

    this.startingTaskIds.add(taskId)
    try {
      const task = await this.store.loadTask(taskId)
      if (!task) throw new Error('找不到任务')
      if (this.shuttingDown) throw new Error('应用正在退出，不能开始新任务')
      const issues = taskConfigurationIssues(task)
      if (issues.length > 0) throw new Error(`任务配置尚未完成：${issues.join('；')}`)

      const checkpoint = resume ? await this.store.getCheckpoint(taskId) : null
      if (resume && !checkpoint) throw new Error('没有可继续的检查点')
      if (!resume) await this.store.clearCheckpoint(taskId)

      this.runs.delete(taskId)
      const queuedAt = nowIso()
      const item: RunSessionItem = {
        taskId,
        taskName: task.name,
        runId: checkpoint?.runId ?? `queued-${randomUUID()}`,
        status: 'queued',
        resume,
        queuePosition: 0,
        queueReason: 'capacity',
        queuedAt,
        startedAt: checkpoint?.startedAt ?? '',
        pausedAt: '',
        finishedAt: '',
        message: '等待运行名额',
        progress: null,
        result: null,
        logs: []
      }
      this.runs.set(taskId, {
        task: clone(task),
        outputKey: normalizedOutputKey(task),
        item,
        control: null,
        execution: null,
        pauseOrder: 0,
        finalizingCancellation: false
      })
      this.queue.push(taskId)
      this.schedule()
      this.emitSession()

      const current = this.runs.get(taskId)?.item ?? item
      return {
        accepted: true,
        taskId,
        runId: current.runId,
        status:
          current.status === 'running' || current.status === 'preparing'
            ? current.status
            : 'queued',
        queuePosition: current.queuePosition,
        message: current.message
      }
    } finally {
      this.startingTaskIds.delete(taskId)
    }
  }

  async pause(taskId: string): Promise<boolean> {
    const managed = this.runs.get(taskId)
    if (!managed || !ACTIVE_STATUSES.has(managed.item.status) || !managed.control?.pause()) {
      return false
    }
    managed.pauseOrder = ++this.pauseSequence
    managed.item.status = 'pausing'
    managed.item.message = '正在保存安全检查点并释放运行名额'
    if (managed.item.progress) {
      managed.item.progress = {
        ...managed.item.progress,
        status: 'pausing',
        message: managed.item.message
      }
      this.emit('progress', clone(managed.item.progress))
    }
    this.emitSession()
    return true
  }

  async resume(taskId: string): Promise<boolean> {
    const managed = this.runs.get(taskId)
    if (!managed || managed.item.status !== 'paused' || this.shuttingDown) return false
    managed.item.status = 'queued'
    managed.item.resume = true
    managed.item.queuedAt = nowIso()
    managed.item.queuePosition = 0
    managed.item.queueReason = 'capacity'
    managed.item.message = '已加入继续采集队列'
    if (managed.item.progress) {
      managed.item.progress = {
        ...managed.item.progress,
        status: 'queued',
        message: managed.item.message
      }
      this.emit('progress', clone(managed.item.progress))
    }
    this.queue.push(taskId)
    this.schedule()
    this.emitSession()
    return true
  }

  async cancel(taskId: string): Promise<boolean> {
    const managed = this.runs.get(taskId)
    if (!managed || !LOCKED_STATUSES.has(managed.item.status)) return false

    if (managed.item.status === 'queued') {
      this.removeFromQueue(taskId)
      managed.item.status = 'cancelled'
      managed.item.queuePosition = 0
      managed.item.queueReason = ''
      managed.item.finishedAt = nowIso()
      managed.item.message = '已取消排队，任务未启动'
      this.releaseOutputLock(managed)
      this.emitSession()
      this.schedule()
      return true
    }

    if (managed.item.status === 'paused') {
      this.startPausedCancellation(managed)
      return true
    }

    const cancelled = managed.control?.cancel() ?? false
    if (!cancelled) return false
    managed.item.message = '正在取消任务并写出当前有效记录'
    this.emitSession()
    return true
  }

  async pauseAll(): Promise<boolean> {
    const active = [...this.runs.values()]
      .filter(({ item }) => ACTIVE_STATUSES.has(item.status))
      .sort((left, right) => left.item.startedAt.localeCompare(right.item.startedAt))
    const results = await Promise.all(active.map(({ item }) => this.pause(item.taskId)))
    return results.some(Boolean)
  }

  async resumeAll(): Promise<boolean> {
    const paused = [...this.runs.values()]
      .filter(({ item }) => item.status === 'paused')
      .sort((left, right) => left.pauseOrder - right.pauseOrder)
    let resumed = false
    for (const managed of paused) {
      resumed = (await this.resume(managed.item.taskId)) || resumed
    }
    return resumed
  }

  async cancelAll(): Promise<boolean> {
    const targets = [...this.runs.values()].filter(({ item }) => LOCKED_STATUSES.has(item.status))
    if (targets.length === 0) return false

    for (const taskId of [...this.queue]) {
      const managed = this.runs.get(taskId)
      if (!managed) continue
      this.removeFromQueue(taskId)
      managed.item.status = 'cancelled'
      managed.item.queuePosition = 0
      managed.item.queueReason = ''
      managed.item.finishedAt = nowIso()
      managed.item.message = '已从等待队列移除'
      this.releaseOutputLock(managed)
    }
    for (const managed of targets) {
      if (managed.item.status === 'paused') this.startPausedCancellation(managed)
      else if (ACTIVE_STATUSES.has(managed.item.status)) managed.control?.cancel()
    }
    this.emitSession()

    const executions = targets
      .map((managed) => managed.execution)
      .filter((execution): execution is Promise<void> => execution !== null)
    await Promise.allSettled(executions)
    return true
  }

  async prepareForShutdown(): Promise<void> {
    this.shuttingDown = true
    for (const taskId of [...this.queue]) {
      const managed = this.runs.get(taskId)
      this.removeFromQueue(taskId)
      if (!managed) continue
      managed.item.status = 'cancelled'
      managed.item.message = '应用退出，已丢弃尚未启动的排队任务'
      this.releaseOutputLock(managed)
    }
    for (const managed of this.runs.values()) {
      if (managed.control && ACTIVE_STATUSES.has(managed.item.status)) {
        if (managed.item.status !== 'pausing') managed.control.pause()
      }
    }
    this.emitSession()
    const executions = [...this.runs.values()]
      .map((managed) => managed.execution)
      .filter((execution): execution is Promise<void> => execution !== null)
    await Promise.allSettled(executions)
  }

  onProgress(listener: (progress: RunProgress) => void): () => void {
    this.on('progress', listener)
    return () => this.off('progress', listener)
  }

  onLog(listener: (log: RunLog) => void): () => void {
    this.on('log', listener)
    return () => this.off('log', listener)
  }

  onFinished(listener: (result: RunResult) => void): () => void {
    this.on('finished', listener)
    return () => this.off('finished', listener)
  }

  onSession(listener: (snapshot: RunSessionSnapshot) => void): () => void {
    this.on('session', listener)
    return () => this.off('session', listener)
  }

  private async withTestSlot<T>(
    taskId: string,
    operation: (task: TaskConfig) => Promise<T>
  ): Promise<T> {
    if (this.testingTaskId) throw new Error('已有测试采集正在执行，请等待完成')
    if (this.isTaskLocked(taskId)) throw new Error('运行、暂停或排队中的任务不能执行测试')
    this.testingTaskId = taskId
    this.emitSession()
    try {
      const task = await this.store.loadTask(taskId)
      if (!task) throw new Error('找不到任务')
      return await operation(task)
    } finally {
      if (this.testingTaskId === taskId) this.testingTaskId = ''
      this.emitSession()
    }
  }

  private schedule(): void {
    if (this.shuttingDown) return
    let slots = Math.max(0, this.maxConcurrentRuns - this.activeCount())
    for (let index = 0; index < this.queue.length && slots > 0; ) {
      const taskId = this.queue[index]
      const managed = taskId ? this.runs.get(taskId) : null
      if (!managed || managed.item.status !== 'queued') {
        this.queue.splice(index, 1)
        continue
      }
      const owner = this.outputLocks.get(managed.outputKey)
      if (owner && owner !== taskId) {
        managed.item.queueReason = 'output-lock'
        managed.item.message = '等待同输出目录任务完成'
        index += 1
        continue
      }

      this.queue.splice(index, 1)
      this.outputLocks.set(managed.outputKey, managed.item.taskId)
      managed.item.queuePosition = 0
      managed.item.queueReason = ''
      this.startManagedRun(managed)
      slots -= 1
    }
    this.refreshQueueMetadata()
  }

  private startManagedRun(managed: ManagedRun): void {
    const control = new CollectorRunControl()
    managed.control = control
    managed.item.status = 'preparing'
    managed.item.startedAt ||= nowIso()
    managed.item.finishedAt = ''
    managed.item.message = managed.item.resume ? '正在准备继续采集' : '正在准备新任务'
    const execution = this.executeManagedRun(managed, control)
    managed.execution = execution
    void execution
  }

  private async executeManagedRun(
    managed: ManagedRun,
    control: CollectorRunControl
  ): Promise<void> {
    try {
      const checkpoint = managed.item.resume
        ? await this.store.getCheckpoint(managed.item.taskId)
        : null
      if (managed.item.resume && !checkpoint) throw new Error('没有可继续的检查点')
      const result = await this.engine.run(managed.task, checkpoint, control, {
        progress: (progress) => this.handleProgress(managed, progress),
        log: (log) => this.handleLog(managed, log)
      })
      if (result.status === 'paused') {
        managed.item.status = 'paused'
        managed.item.resume = true
        managed.item.pausedAt = nowIso()
        managed.item.message = result.message
        managed.item.result = null
        if (managed.item.progress) {
          managed.item.progress = {
            ...managed.item.progress,
            status: 'paused',
            message: result.message
          }
        }
      } else {
        this.finishManagedRun(managed, result)
      }
    } catch (error) {
      const result = this.failureResult(managed, control, error)
      this.finishManagedRun(managed, result)
    } finally {
      managed.control = null
      managed.execution = null
      managed.finalizingCancellation = false
      if (!LOCKED_STATUSES.has(managed.item.status)) this.releaseOutputLock(managed)
      this.emitSession()
      this.schedule()
      this.emitSession()
    }
  }

  private startPausedCancellation(managed: ManagedRun): void {
    const control = new CollectorRunControl()
    control.cancel()
    managed.control = control
    managed.finalizingCancellation = true
    managed.item.status = 'pausing'
    managed.item.message = '正在取消暂停任务并写出当前有效记录'
    const execution = this.executeManagedRun(managed, control)
    managed.execution = execution
    void execution
    this.emitSession()
  }

  private handleProgress(managed: ManagedRun, progress: RunProgress): void {
    managed.item.runId = progress.runId
    managed.item.progress = clone(progress)
    managed.item.message = progress.message
    if (progress.status === 'paused' || managed.item.status !== 'pausing') {
      managed.item.status = progress.status === 'idle' ? 'preparing' : progress.status
    }
    this.emit('progress', clone(progress))
  }

  private handleLog(managed: ManagedRun, log: RunLog): void {
    const normalized = { ...log, taskId: managed.item.taskId }
    managed.item.logs.push(normalized)
    if (managed.item.logs.length > MAX_RETAINED_LOGS) {
      managed.item.logs.splice(0, managed.item.logs.length - MAX_RETAINED_LOGS)
    }
    this.emit('log', clone(normalized))
  }

  private finishManagedRun(managed: ManagedRun, result: RunResult): void {
    managed.item.runId = result.runId
    managed.item.status = result.status
    managed.item.result = clone(result)
    managed.item.finishedAt = result.finishedAt
    managed.item.message = result.message
    this.releaseOutputLock(managed)
    this.emit('finished', clone(result))
  }

  private failureResult(
    managed: ManagedRun,
    control: CollectorRunControl,
    error: unknown
  ): RunResult {
    const checkpoint = control.getCheckpoint()
    const message = error instanceof Error ? error.message : String(error)
    return {
      runId: checkpoint?.runId ?? managed.item.runId,
      taskId: managed.item.taskId,
      status: 'failed',
      startedAt: checkpoint?.startedAt ?? (managed.item.startedAt || nowIso()),
      finishedAt: nowIso(),
      pagesVisited: checkpoint?.pagesVisited ?? 0,
      outputFiles: checkpoint?.outputFiles ?? [],
      errorLogPath: checkpoint?.errorLogPath ?? '',
      counters: checkpoint?.counters ?? createEmptyCounters(),
      resources: checkpoint?.resources ?? createEmptyResourceCounters(),
      message
    }
  }

  private activeCount(): number {
    return [...this.runs.values()].filter(
      (managed) => ACTIVE_STATUSES.has(managed.item.status) && !managed.finalizingCancellation
    ).length
  }

  private refreshQueueMetadata(): void {
    this.queue.forEach((taskId, index) => {
      const managed = this.runs.get(taskId)
      if (!managed || managed.item.status !== 'queued') return
      managed.item.queuePosition = index + 1
      if (managed.item.queueReason !== 'output-lock') {
        managed.item.queueReason = 'capacity'
        managed.item.message = `排队第 ${index + 1}，等待运行名额`
      }
    })
  }

  private removeFromQueue(taskId: string): void {
    const index = this.queue.indexOf(taskId)
    if (index >= 0) this.queue.splice(index, 1)
    this.refreshQueueMetadata()
  }

  private releaseOutputLock(managed: ManagedRun): void {
    if (this.outputLocks.get(managed.outputKey) === managed.item.taskId) {
      this.outputLocks.delete(managed.outputKey)
    }
  }

  private emitSession(): void {
    this.emit('session', this.getSessionSnapshot())
  }
}
