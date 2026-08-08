import { EventEmitter } from 'node:events'
import { net } from 'electron'
import type { RunLog, RunProgress, RunResult, TestCollectionResult } from '@shared/types'
import { CollectorEngine, CollectorRunControl } from '@main/core/collector-engine'
import type { DynamicPageProvider } from '@main/core/dynamic-page'
import { HttpClient } from '@main/core/http-client'
import type { TaskStore } from './task-store'

interface ActiveRun {
  taskId: string
  runId: string
  control: CollectorRunControl
}

export class RunManager extends EventEmitter {
  private active: ActiveRun | null = null
  private latestProgress: RunProgress | null = null
  private readonly engine: CollectorEngine

  constructor(
    private readonly store: TaskStore,
    dynamicPageProvider: DynamicPageProvider | null = null
  ) {
    super()
    this.engine = new CollectorEngine(
      store,
      new HttpClient(net.fetch as typeof fetch),
      dynamicPageProvider
    )
  }

  hasActiveRun(): boolean {
    return this.active !== null
  }

  async getDetailSamples(taskId: string): Promise<string[]> {
    if (this.active) throw new Error('正式采集运行期间不能读取详情样例')
    const task = await this.store.loadTask(taskId)
    if (!task) throw new Error('找不到任务')
    return this.engine.getDetailSamples(task)
  }

  async testTask(taskId: string): Promise<TestCollectionResult> {
    if (this.active) throw new Error('正式采集运行期间不能执行测试采集')
    const task = await this.store.loadTask(taskId)
    if (!task) throw new Error('找不到任务')
    return this.engine.testTask(task)
  }

  async start(taskId: string, resume: boolean): Promise<RunResult> {
    if (this.active) throw new Error('已有任务正在运行，同一时间只能运行一个任务')
    const task = await this.store.loadTask(taskId)
    if (!task) throw new Error('找不到任务')
    const checkpoint = resume ? await this.store.getCheckpoint(taskId) : null
    if (!resume) await this.store.clearCheckpoint(taskId)
    if (resume && !checkpoint) throw new Error('没有可继续的检查点')

    const control = new CollectorRunControl()
    const runId = checkpoint?.runId ?? 'preparing'
    this.active = { taskId, runId, control }
    try {
      const result = await this.engine.run(task, checkpoint, control, {
        progress: (progress) => {
          if (this.active) this.active.runId = progress.runId
          this.latestProgress = progress
          this.emit('progress', progress)
        },
        log: (log) => this.emit('log', log)
      })
      this.emit('finished', result)
      return result
    } finally {
      this.active = null
      this.latestProgress = null
    }
  }

  async pause(runId: string): Promise<boolean> {
    if (!this.matches(runId) || !this.active?.control.pause()) return false
    const checkpoint = this.active.control.getCheckpoint()
    if (checkpoint) await this.store.saveCheckpoint(checkpoint)
    if (this.latestProgress) {
      this.emit('progress', {
        ...this.latestProgress,
        status: 'paused',
        message: '任务已暂停，当前进度已保存'
      } satisfies RunProgress)
    }
    return true
  }

  resume(runId: string): boolean {
    const resumed = this.matches(runId) ? (this.active?.control.resume() ?? false) : false
    if (resumed && this.latestProgress) {
      this.emit('progress', {
        ...this.latestProgress,
        status: 'running',
        message: '继续采集'
      } satisfies RunProgress)
    }
    return resumed
  }

  cancel(runId: string): boolean {
    return this.matches(runId) ? (this.active?.control.cancel() ?? false) : false
  }

  async prepareForShutdown(): Promise<void> {
    if (!this.active) return
    this.active.control.pause()
    const checkpoint = this.active.control.getCheckpoint()
    if (checkpoint) await this.store.saveCheckpoint(checkpoint)
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

  private matches(runId: string): boolean {
    return Boolean(this.active && (this.active.runId === runId || this.active.runId === 'preparing'))
  }
}
