import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { net } from 'electron'
import { setTimeout as wait } from 'node:timers/promises'
import PQueue from 'p-queue'
import {
  createEmptyCounters,
  createEmptyResourceCounters,
  normalizeMaxConcurrentRuns,
  taskConfigurationIssues
} from '@shared/defaults'
import type {
  AppSettings,
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
import type { AccessCoordinator, AccessRequestTarget } from './access-coordinator'
import { redactDiagnostic, type HostProtection } from '@shared/access-protection'
import { firstTaskListPageUrl } from '@shared/list-page-rules'
import type { AccessProfileLease, AccessProfileService } from './access-profile-service'
import { profileMatchesUrl } from '@shared/access-profile'
import { ManualVerificationService, type ManualVerificationProvider, type VerificationRequest } from './manual-verification-service'

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
  verification?: { request: VerificationRequest; controller?: AbortController | undefined; execution?: Promise<void> | undefined; disposing?: boolean } | undefined
  profile?: AccessProfileLease | undefined
  task: TaskConfig
  outputKey: string
  item: RunSessionItem
  control: CollectorRunControl | null
  execution: Promise<void> | null
  pauseOrder: number
  finalizingCancellation: boolean
  autoResumePending: boolean
}

export interface RunShutdownSnapshot {
  runs: Array<{
    taskId: string
    status: RunSessionItem['status']
    resume: boolean
  }>
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
  private readonly deletingTaskIds = new Set<string>()
  private readonly engine: CollectorEngineLike
  private maxConcurrentRuns = 3
  private testingTaskId = ''
  private pauseSequence = 0
  private shuttingDown = false
  private readonly protectionTimers = new Map<string, NodeJS.Timeout>()
  private readonly verificationQueues = new Map<string, PQueue>()
  private readonly verifier: ManualVerificationProvider | undefined

  constructor(
    private readonly store: TaskStore,
    dynamicPageProvider: DynamicPageProvider | null = null,
    engine: CollectorEngineLike | null = null,
    private readonly access?: AccessCoordinator,
    private readonly profiles?: AccessProfileService,
    verifier?: ManualVerificationProvider
  ) {
    super()
    this.verifier = verifier ?? (access ? new ManualVerificationService(access) : undefined)
    this.engine =
      engine ??
      new CollectorEngine(
        store,
        new HttpClient(net.fetch as typeof fetch, access),
        dynamicPageProvider
      )
    access?.on('protected', (protection: HostProtection, target?: AccessRequestTarget) => this.handleProtection(protection, target))
    access?.on('cleared', (hostname: string) => this.releaseProtection(hostname))
  }

  async initialize(): Promise<void> {
    const settings = await this.store.getSettings()
    this.maxConcurrentRuns = normalizeMaxConcurrentRuns(settings.maxConcurrentRuns)
    this.access?.configure(settings.access)
  }

  applySettings(settings: AppSettings): void {
    this.access?.configure(settings.access)
    this.setMaxConcurrentRuns(settings.maxConcurrentRuns)
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
    return (
      this.deletingTaskIds.has(taskId) ||
      this.testingTaskId === taskId ||
      this.isTaskLocked(taskId)
    )
  }

  async deleteTask(taskId: string): Promise<boolean> {
    if (this.isTaskMutationLocked(taskId)) {
      throw new Error('运行、暂停、排队或测试中的任务不能删除')
    }

    this.deletingTaskIds.add(taskId)
    try {
      const deleted = await this.store.deleteTask(taskId)
      if (!deleted) return false

      const managed = this.runs.get(taskId)
      if (managed) {
        this.removeFromQueue(taskId)
        this.releaseOutputLock(managed)
        this.runs.delete(taskId)
        this.emitSession()
      }
      return true
    } finally {
      this.deletingTaskIds.delete(taskId)
    }
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
    if (this.deletingTaskIds.has(taskId)) throw new Error('该任务正在删除')
    if (this.testingTaskId === taskId) throw new Error('该任务正在执行测试采集')
    if (this.isTaskLocked(taskId)) throw new Error('该任务已经在运行、暂停或排队中')

    this.startingTaskIds.add(taskId)
    let profile: AccessProfileLease | undefined
    let admitted = false
    try {
      const task = await this.store.loadTask(taskId)
      if (!task) throw new Error('找不到任务')
      if (this.shuttingDown) throw new Error('应用正在退出，不能开始新任务')
      const issues = taskConfigurationIssues(task)
      if (issues.length > 0) throw new Error(`任务配置尚未完成：${issues.join('；')}`)
      if (task.accessProfileId && !this.profiles) throw new Error('访问配置服务不可用')
      profile = await this.profiles?.acquire(task)

      const checkpoint = resume ? await this.store.getCheckpoint(taskId) : null
      if (resume && !checkpoint) throw new Error('没有可继续的检查点')
      if (!resume) await this.store.clearCheckpoint(taskId)

      this.runs.delete(taskId)
      this.access?.forgetTask(taskId)
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
        profile,
        task: clone(task),
        outputKey: normalizedOutputKey(task),
        item,
        control: null,
        execution: null,
        pauseOrder: 0,
        finalizingCancellation: false,
        autoResumePending: false
      })
      admitted = true
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
      if (!admitted) profile?.release()
      this.startingTaskIds.delete(taskId)
    }
  }

  async pause(taskId: string): Promise<boolean> {
    const managed = this.runs.get(taskId)
    if (managed) managed.autoResumePending = false
    if (managed?.verification?.controller) {
      this.stopVerification(managed)
      managed.item.message = '已停止验证后恢复，任务保持暂停'
      this.emitSession()
      return true
    }
    if (managed && ['paused', 'pausing'].includes(managed.item.status) && managed.item.protection?.kind === 'cooling') {
      managed.item.protection = undefined
      managed.item.message = '已停止自动恢复，任务保持暂停'
      this.emitSession()
      return true
    }
    if (!managed || !ACTIVE_STATUSES.has(managed.item.status) || !managed.control?.pause()) {
      return false
    }
    managed.pauseOrder = ++this.pauseSequence
    managed.item.protection = undefined
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
    if (managed?.verification) throw new Error('请在人工处理提示中点击“我已完成验证，尝试恢复”')
    if (!managed || managed.item.status !== 'paused' || this.shuttingDown) return false
    const protection = this.access?.taskProtection(taskId, this.taskHostname(managed.task))
    if (protection?.kind === 'cooling' && protection.until > Date.now()) {
      throw new Error(`站点仍在冷却，请等待 ${Math.ceil((protection.until - Date.now()) / 1000)} 秒`)
    }
    if (protection?.kind === 'action-required') {
      this.requireVerification(managed, protection)
      this.emitSession()
      throw new Error('请先完成验证并确认后再尝试恢复')
    }
    managed.item.protection = undefined
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
    managed.autoResumePending = false
    if (managed.item.status === 'queued') this.removeFromQueue(taskId)
    await this.disposeVerification(managed)
    managed.item.protection = undefined

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
      .filter(managed => ACTIVE_STATUSES.has(managed.item.status) || Boolean(managed.verification?.controller) || (managed.item.status === 'paused' && managed.item.protection?.kind === 'cooling'))
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
      if (managed.verification) continue
      const protection = this.access?.taskProtection(managed.item.taskId, this.taskHostname(managed.task))
      if (protection?.kind === 'action-required') continue
      if (protection?.kind === 'cooling' && protection.until > Date.now()) continue
      resumed = (await this.resume(managed.item.taskId)) || resumed
    }
    return resumed
  }

  async cancelAll(): Promise<boolean> {
    const targets = [...this.runs.values()].filter(({ item }) => LOCKED_STATUSES.has(item.status))
    if (targets.length === 0) return false
    for (const managed of targets) {
      managed.autoResumePending = false
      if (managed.item.status === 'queued') this.removeFromQueue(managed.item.taskId)
      else if (ACTIVE_STATUSES.has(managed.item.status)) managed.control?.cancel()
    }
    // Revoke the whole batch before awaiting any active probe's cleanup.
    await Promise.all(targets.map(managed => this.disposeVerification(managed)))

    for (const managed of targets) {
      managed.item.protection = undefined
      if (managed.item.status === 'queued') {
        managed.item.status = 'cancelled'
        managed.item.queuePosition = 0
        managed.item.queueReason = ''
        managed.item.finishedAt = nowIso()
        managed.item.message = '已从等待队列移除'
        this.releaseOutputLock(managed)
      } else if (managed.item.status === 'paused') this.startPausedCancellation(managed)
    }
    this.emitSession()

    const executions = targets
      .map((managed) => managed.execution)
      .filter((execution): execution is Promise<void> => execution !== null)
    await Promise.allSettled(executions)
    return true
  }

  async prepareForShutdown(): Promise<RunShutdownSnapshot> {
    const snapshot: RunShutdownSnapshot = {
      runs: [...this.runs.values()]
        .filter(({ item }) => LOCKED_STATUSES.has(item.status))
        .map(({ item }) => ({
          taskId: item.taskId,
          status: item.status,
          resume: item.resume
        }))
    }
    this.shuttingDown = true
    for (const managed of this.runs.values()) {
      if (managed.control && ACTIVE_STATUSES.has(managed.item.status) && managed.item.status !== 'pausing') managed.control.pause()
    }
    await Promise.all([...this.runs.values()].map(managed => this.disposeVerification(managed, false)))
    for (const timer of this.protectionTimers.values()) clearTimeout(timer)
    this.protectionTimers.clear()
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
    return snapshot
  }

  async restoreAfterFailedShutdown(snapshot: RunShutdownSnapshot): Promise<void> {
    this.shuttingDown = false
    const restoreQueuedItem = (
      previous: RunShutdownSnapshot['runs'][number],
      message: string
    ): void => {
      const managed = this.runs.get(previous.taskId)
      if (!managed) return
      managed.item.status = 'queued'
      managed.item.resume = previous.status === 'queued' ? previous.resume : true
      managed.item.queuedAt = nowIso()
      managed.item.finishedAt = ''
      managed.item.queuePosition = 0
      managed.item.queueReason = 'capacity'
      managed.item.message = message
      if (!this.queue.includes(previous.taskId)) this.queue.push(previous.taskId)
    }
    for (const previous of snapshot.runs) {
      const managed = this.runs.get(previous.taskId)
      if (
        managed?.item.status === 'paused' &&
        ['preparing', 'running'].includes(previous.status)
      ) {
        restoreQueuedItem(previous, '更新安装未启动，正在恢复采集')
      }
    }
    for (const previous of snapshot.runs) {
      const managed = this.runs.get(previous.taskId)
      if (previous.status === 'queued' && managed?.item.status === 'cancelled') {
        managed.profile = await this.profiles?.acquire(managed.task)
        restoreQueuedItem(previous, '更新安装未启动，已恢复等待队列')
      }
    }
    for (const { item } of this.runs.values()) {
      if (item.protection?.kind === 'cooling') this.armCooldown(item.protection)
    }
    this.schedule()
    this.emitSession()
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
    if (this.deletingTaskIds.has(taskId)) throw new Error('该任务正在删除')
    if (this.isTaskLocked(taskId)) throw new Error('运行、暂停或排队中的任务不能执行测试')
    this.testingTaskId = taskId
    this.emitSession()
    let profile: AccessProfileLease | undefined
    try {
      const task = await this.store.loadTask(taskId)
      if (!task) throw new Error('找不到任务')
      if (task.accessProfileId && !this.profiles) throw new Error('访问配置服务不可用')
      profile = await this.profiles?.acquire(task)
      return await (this.access ? this.access.withContext(taskId, undefined, () => operation(task), profile) : operation(task))
    } finally {
      profile?.release()
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
      if (managed.verification) { index += 1; continue }
      const protection = this.access?.taskProtection(managed.item.taskId, this.taskHostname(managed.task))
      if (protection) {
        managed.item.protection = protection
        if (protection.kind === 'action-required') this.requireVerification(managed, protection)
        const sameHostActive = [...this.runs.values()].some(other =>
          other !== managed && ACTIVE_STATUSES.has(other.item.status) && this.usesHost(other, protection.hostname))
        if (protection.kind === 'action-required' || protection.until > Date.now() || sameHostActive) {
          managed.item.message = protection.reason
          index += 1
          continue
        }
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
      const run = (): Promise<CollectorRunResult> => this.engine.run(managed.task, checkpoint, control, {
        progress: (progress) => this.handleProgress(managed, progress),
        log: (log) => this.handleLog(managed, log)
      })
      const result = await (this.access ? this.access.withContext(managed.item.taskId, control.signal, run, managed.profile) : run())
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
      if (managed.autoResumePending && managed.item.status === 'paused' && !this.shuttingDown) {
        managed.item.status = 'queued'
        managed.item.resume = true
        this.queue.push(managed.item.taskId)
      }
      managed.autoResumePending = false
      if (!LOCKED_STATUSES.has(managed.item.status)) this.releaseOutputLock(managed)
      this.emitSession()
      if (managed.item.protection?.kind === 'cooling') this.armCooldown(managed.item.protection)
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
    progress = { ...progress, currentUrl: redactDiagnostic(progress.currentUrl), message: redactDiagnostic(progress.message) }
    managed.item.runId = progress.runId
    managed.item.progress = clone(progress)
    managed.item.message = progress.message
    if (progress.status === 'paused' || managed.item.status !== 'pausing') {
      managed.item.status = progress.status === 'idle' ? 'preparing' : progress.status
    }
    this.emit('progress', clone(progress))
  }

  private handleLog(managed: ManagedRun, log: RunLog): void {
    const normalized = { ...log, message: redactDiagnostic(log.message), taskId: managed.item.taskId }
    managed.item.logs.push(normalized)
    if (managed.item.logs.length > MAX_RETAINED_LOGS) {
      managed.item.logs.splice(0, managed.item.logs.length - MAX_RETAINED_LOGS)
    }
    this.emit('log', clone(normalized))
  }

  private finishManagedRun(managed: ManagedRun, result: RunResult): void {
    result = { ...result, message: redactDiagnostic(result.message) }
    managed.item.protection = undefined
    this.stopVerification(managed)
    if (managed.verification) this.verifier?.close(managed.verification.request.id)
    managed.verification = undefined
    managed.item.verification = undefined
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
      if (managed.item.queueReason !== 'output-lock' && !managed.item.protection) {
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
    managed.profile?.release()
    managed.profile = undefined
    if (this.outputLocks.get(managed.outputKey) === managed.item.taskId) {
      this.outputLocks.delete(managed.outputKey)
    }
  }

  private emitSession(): void {
    this.emit('session', this.getSessionSnapshot())
  }

  private taskHostname(task: TaskConfig): string {
    try { return new URL(firstTaskListPageUrl(task)).hostname.toLowerCase() } catch { return '' }
  }

  private usesHost(managed: ManagedRun, hostname: string): boolean {
    return this.taskHostname(managed.task) === hostname || Boolean(this.access?.hasVisited(managed.item.taskId, hostname))
  }

  private handleProtection(protection: HostProtection, target?: AccessRequestTarget): void {
    for (const managed of this.runs.values()) {
      if (!this.usesHost(managed, protection.hostname) || !LOCKED_STATUSES.has(managed.item.status)) continue
      // 手动暂停的任务不加入自动恢复名单。
      if (managed.item.status === 'paused' && !managed.item.protection) continue
      managed.item.protection = protection
      if (protection.kind === 'action-required') this.requireVerification(managed, protection, target)
      managed.item.message = protection.reason
      if (managed.control && ACTIVE_STATUSES.has(managed.item.status)) {
        managed.control.pause()
        managed.item.status = 'pausing'
      }
    }
    if (protection.kind === 'cooling') this.armCooldown(protection)
    this.emitSession()
  }

  private armCooldown(protection: HostProtection): void {
    if (this.shuttingDown || this.protectionTimers.has(protection.hostname)) return
    if (![...this.runs.values()].some(({ item }) => item.protection?.hostname === protection.hostname && LOCKED_STATUSES.has(item.status))) return
    const timer = setTimeout(() => {
      this.protectionTimers.delete(protection.hostname)
      if (this.shuttingDown) return
      const current = this.access?.getProtection(protection.hostname)
      if (!current || current.kind !== 'cooling') return
      if (current.until > Date.now()) { this.armCooldown(current); return }
      const probing = [...this.runs.values()].some(managed =>
        this.usesHost(managed, current.hostname) && ACTIVE_STATUSES.has(managed.item.status))
      if (!probing) {
        const candidate = [...this.runs.values()].find(managed =>
          managed.item.protection?.hostname === current.hostname && managed.item.protection.kind === 'cooling' && managed.item.status === 'paused')
        if (candidate) {
          candidate.item.status = 'queued'
          candidate.item.resume = true
          this.queue.push(candidate.item.taskId)
        }
        this.schedule()
        this.emitSession()
      }
      if (this.access?.getProtection(current.hostname)) this.armCooldown(current)
    }, Math.min(60000, Math.max(1000, protection.until - Date.now())))
    timer.unref()
    this.protectionTimers.set(protection.hostname, timer)
  }

  private releaseProtection(hostname: string): void {
    const timer = this.protectionTimers.get(hostname)
    if (timer) clearTimeout(timer)
    this.protectionTimers.delete(hostname)
    for (const managed of this.runs.values()) {
      if (managed.item.protection?.hostname !== hostname) continue
      // 共享 Cookie 不等于其他任务已经确认；各任务保留自己的验证入口。
      if (managed.verification) continue
      const automatic = managed.item.protection.kind === 'cooling'
      managed.item.protection = undefined
      if (automatic && managed.item.status === 'pausing') managed.autoResumePending = true
      if (automatic && managed.item.status === 'paused' && !this.shuttingDown) {
        managed.item.status = 'queued'
        managed.item.resume = true
        managed.item.message = '站点已恢复，等待继续采集'
        this.queue.push(managed.item.taskId)
      }
    }
    this.schedule()
    this.emitSession()
  }

  openVerification(taskId: string, id: string): boolean {
    const managed = this.verificationRun(taskId, id)
    if (!managed || !this.verifier) return false
    const state = managed.item.verification!
    if (!state.canOpen) throw new Error(state.message)
    this.verifier.open(managed.verification!.request, () => {
      if (this.runs.get(taskId) !== managed || managed.item.verification?.id !== id) return
      this.stopVerification(managed)
      managed.item.verification.windowOpen = false
      managed.item.verification.message = '验证页面已关闭；任务保持暂停，可重新打开后确认'
      this.emitSession()
    })
    state.windowOpen = true
    this.emitSession()
    return true
  }

  confirmVerification(taskId: string, id: string): boolean {
    const managed = this.verificationRun(taskId, id)
    if (!managed || !this.verifier || !this.access) return false
    const work = managed.verification!
    if (work.controller) return true
    if (work.execution) return false
    const controller = new AbortController()
    work.controller = controller
    managed.item.verification!.status = 'waiting'
    managed.item.verification!.message = '已确认，等待站点期限和探测名额；仅恢复本任务'
    work.execution = this.performVerification(managed, controller)
    this.emitSession()
    return true
  }

  private verificationRun(taskId: string, id: string): ManagedRun | undefined {
    const managed = this.runs.get(taskId)
    if (this.shuttingDown || !managed || !['paused', 'queued'].includes(managed.item.status) || managed.execution ||
      !managed.verification || managed.verification.disposing || managed.item.verification?.id !== id) return undefined
    return managed
  }

  private requireVerification(managed: ManagedRun, protection: HostProtection, trigger?: AccessRequestTarget): void {
    if (managed.verification) return
    const own = trigger?.taskId === managed.item.taskId ? trigger : this.access?.taskTarget(managed.item.taskId, protection.hostname)
    const url = own?.url ?? firstTaskListPageUrl(managed.task)
    const id = randomUUID()
    const canOpen = Boolean(managed.profile && profileMatchesUrl(managed.profile, url))
    managed.verification = { request: { id, url, resource: own?.resource ?? false, task: managed.task, profile: managed.profile } }
    managed.item.verification = {
      id, hostname: protection.hostname, status: 'required', windowOpen: false, canOpen,
      message: canOpen ? '在验证页面完成登录或验证后，返回这里确认；关闭窗口不会恢复任务' :
        '网页登录需要绑定与触发地址来源一致的访问配置；请取消后调整。权限已在外部修复时可直接确认探测'
    }
  }

  private async performVerification(managed: ManagedRun, controller: AbortController): Promise<void> {
    const work = managed.verification!
    const state = managed.item.verification!
    const { signal } = controller
    const queue = this.verificationQueues.get(state.hostname) ?? new PQueue({ concurrency: 1 })
    this.verificationQueues.set(state.hostname, queue)
    // 排队时可立即取消；启动后由探测自己的信号结束清理，不能提前释放队列名额。
    const queuedCancellation = new AbortController()
    const cancelQueued = (): void => queuedCancellation.abort()
    signal.addEventListener('abort', cancelQueued, { once: true })
    const valid = (): boolean => !signal.aborted && this.verificationRun(managed.item.taskId, state.id) === managed && work.controller === controller
    try {
      await queue.add(async () => {
        signal.removeEventListener('abort', cancelQueued)
        while (valid()) {
          const until = this.access!.getProtection(state.hostname)?.until ?? 0
          if (until <= Date.now()) break
          await wait(Math.min(60000, until - Date.now()), undefined, { signal })
        }
        if (!valid()) return
        state.status = 'probing'
        state.message = '正在探测触发页面，成功后按原检查点继续'
        this.emitSession()
        await this.access!.withManualProbe(managed.item.taskId, state.hostname, signal,
          () => this.verifier!.probe(work.request, signal), managed.profile)
        if (!valid()) return
        // 探测期间其他请求可能延长服务端期限，确认不能把它清掉。
        if ((this.access!.getProtection(state.hostname)?.until ?? 0) > Date.now()) throw new Error('站点仍在冷却')
        this.access!.clearManual(state.hostname)
        this.verifier!.close(state.id)
        managed.verification = undefined
        managed.item.verification = undefined
        const remaining = this.access!.taskProtection(managed.item.taskId, this.taskHostname(managed.task))
        managed.item.protection = remaining
        if (remaining?.kind === 'action-required') this.requireVerification(managed, remaining)
        if (remaining?.kind === 'cooling') this.armCooldown(remaining)
        if (managed.item.status === 'queued') this.schedule()
        else if (!remaining) await this.resume(managed.item.taskId)
      }, { signal: queuedCancellation.signal })
    } catch {
      if (valid()) {
        state.status = 'failed'
        state.message = '探测未通过，任务保持暂停；请检查验证页面和站点期限后再次确认'
        managed.item.message = state.message
      }
    } finally {
      signal.removeEventListener('abort', cancelQueued)
      if (!queue.pending && !queue.size && this.verificationQueues.get(state.hostname) === queue) this.verificationQueues.delete(state.hostname)
      if (work.controller === controller) work.controller = undefined
      work.execution = undefined
      this.emitSession()
    }
  }

  private stopVerification(managed: ManagedRun): void {
    managed.verification?.controller?.abort()
    if (managed.verification) managed.verification.controller = undefined
    if (managed.item.verification) {
      managed.item.verification.status = 'required'
      managed.item.verification.message = '已停止验证后恢复，任务保持暂停；继续前请重新确认'
    }
  }

  private async disposeVerification(managed: ManagedRun, remove = true): Promise<void> {
    const work = managed.verification
    if (!work) return
    work.disposing = true
    this.stopVerification(managed)
    this.verifier?.close(work.request.id)
    if (managed.item.verification) managed.item.verification.windowOpen = false
    await work.execution
    if (remove && managed.verification === work) { managed.verification = undefined; managed.item.verification = undefined }
    else work.disposing = false
  }
}
