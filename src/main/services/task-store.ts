import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  createEmptyResourceCounters,
  DEFAULT_SETTINGS,
  isTaskRunnable,
  normalizeAppSettings,
  normalizeTaskConfig
} from '@shared/defaults'
import { firstTaskListPageUrl } from '@shared/list-page-rules'
import type {
  AppSettings,
  ExtractedRecord,
  RunCheckpoint,
  TaskConfig,
  TaskSummary
} from '@shared/types'

interface OutputManifest {
  taskId: string
  files: string[]
}

type StoredCheckpoint = Omit<RunCheckpoint, 'pendingRecords'>
type LegacyStoredCheckpoint = Omit<
  StoredCheckpoint,
  'nextRuleIndex' | 'templatePagesVisited' | 'resources' | 'processedResourceUrls'
> &
  Partial<
    Pick<
      StoredCheckpoint,
      'nextRuleIndex' | 'templatePagesVisited' | 'resources' | 'processedResourceUrls'
    >
  >

const validateId = (id: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('任务 ID 非法')
  return id
}

const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

const atomicWrite = async (path: string, content: string | Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content)
  try {
    await rename(temporary, path)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    await rm(path, { force: true })
    await rename(temporary, path)
  }
}

const readNdjson = async <T>(path: string): Promise<T[]> => {
  try {
    const content = await readFile(path, 'utf8')
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export class TaskStore {
  private readonly settingsPath: string
  private readonly tasksDirectory: string
  private readonly checkpointsDirectory: string
  private readonly manifestsDirectory: string

  constructor(readonly rootDirectory: string) {
    this.settingsPath = join(rootDirectory, 'settings.json')
    this.tasksDirectory = join(rootDirectory, 'tasks')
    this.checkpointsDirectory = join(rootDirectory, 'checkpoints')
    this.manifestsDirectory = join(rootDirectory, 'manifests')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.tasksDirectory, { recursive: true }),
      mkdir(this.checkpointsDirectory, { recursive: true }),
      mkdir(this.manifestsDirectory, { recursive: true })
    ])
  }

  async getSettings(): Promise<AppSettings> {
    return normalizeAppSettings(
      await readJson<Partial<AppSettings>>(this.settingsPath, { ...DEFAULT_SETTINGS })
    )
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    const normalized = normalizeAppSettings(settings)
    await atomicWrite(this.settingsPath, JSON.stringify(normalized, null, 2))
    return normalized
  }

  async listTasks(): Promise<TaskSummary[]> {
    await this.initialize()
    const entries = await readdir(this.tasksDirectory, { withFileTypes: true })
    const summaries: TaskSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue
      const task = await this.loadTask(entry.name)
      if (!task) continue
      summaries.push({
        id: task.id,
        name: task.name,
        listUrl: firstTaskListPageUrl(task),
        updatedAt: task.updatedAt,
        runnable: isTaskRunnable(task),
        hasCheckpoint: await this.hasCheckpoint(task.id)
      })
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async loadTask(id: string): Promise<TaskConfig | null> {
    const taskPath = this.taskPath(validateId(id))
    const task = await readJson<TaskConfig | null>(taskPath, null)
    return task ? normalizeTaskConfig(task) : null
  }

  async saveTask(task: TaskConfig): Promise<TaskConfig> {
    validateId(task.id)
    const existing = await this.loadTask(task.id)
    const now = new Date().toISOString()
    const normalized = normalizeTaskConfig(JSON.parse(
      JSON.stringify({
        ...task,
        name: task.name.trim() || '未命名任务',
        createdAt: existing?.createdAt ?? task.createdAt ?? now,
        updatedAt: now
      })
    ) as TaskConfig)
    await atomicWrite(this.taskPath(task.id), JSON.stringify(normalized, null, 2))
    return normalized
  }

  async duplicateTask(id: string): Promise<TaskConfig> {
    const source = await this.loadTask(id)
    if (!source) throw new Error('找不到要复制的任务')
    const now = new Date().toISOString()
    const copy: TaskConfig = {
      ...JSON.parse(JSON.stringify(source)) as TaskConfig,
      id: randomUUID(),
      name: `${source.name} - 副本`,
      createdAt: now,
      updatedAt: now
    }
    return this.saveTask(copy)
  }

  async deleteTask(id: string): Promise<boolean> {
    validateId(id)
    const task = await this.loadTask(id)
    if (!task) return false
    await rm(join(this.tasksDirectory, id), { recursive: true, force: true })
    await this.clearCheckpoint(id)
    await rm(this.manifestPath(id), { force: true })
    return true
  }

  async hasCheckpoint(taskId: string): Promise<boolean> {
    validateId(taskId)
    const checkpoint = await readJson<LegacyStoredCheckpoint | null>(this.checkpointPath(taskId), null)
    return checkpoint !== null
  }

  async getCheckpoint(taskId: string): Promise<RunCheckpoint | null> {
    validateId(taskId)
    const stored = await readJson<LegacyStoredCheckpoint | null>(this.checkpointPath(taskId), null)
    if (!stored) return null
    const pendingRecords = (await readNdjson<ExtractedRecord>(this.pendingPath(taskId))).map(
      (record) => ({ ...record, resources: record.resources ?? [] })
    )
    return {
      ...stored,
      nextRuleIndex: stored.nextRuleIndex ?? 0,
      templatePagesVisited: stored.templatePagesVisited ?? stored.pagesVisited,
      resources: stored.resources ?? createEmptyResourceCounters(),
      processedResourceUrls: stored.processedResourceUrls ?? [],
      pendingRecords
    }
  }

  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    validateId(checkpoint.taskId)
    const { pendingRecords, ...stored } = checkpoint
    await Promise.all([
      atomicWrite(this.checkpointPath(checkpoint.taskId), JSON.stringify(stored, null, 2)),
      atomicWrite(
        this.pendingPath(checkpoint.taskId),
        pendingRecords.map((record) => JSON.stringify(record)).join('\n')
      )
    ])
  }

  async clearCheckpoint(taskId: string): Promise<void> {
    validateId(taskId)
    await Promise.all([
      rm(this.checkpointPath(taskId), { force: true }),
      rm(this.pendingPath(taskId), { force: true })
    ])
  }

  async getOutputManifest(taskId: string): Promise<string[]> {
    validateId(taskId)
    const manifest = await readJson<OutputManifest>(this.manifestPath(taskId), {
      taskId,
      files: []
    })
    return manifest.files
  }

  async saveOutputManifest(taskId: string, files: string[]): Promise<void> {
    validateId(taskId)
    const manifest: OutputManifest = { taskId, files: [...new Set(files)] }
    await atomicWrite(this.manifestPath(taskId), JSON.stringify(manifest, null, 2))
  }

  private taskPath(id: string): string {
    return join(this.tasksDirectory, id, 'task.json')
  }

  private checkpointPath(id: string): string {
    return join(this.checkpointsDirectory, id, 'checkpoint.json')
  }

  private pendingPath(id: string): string {
    return join(this.checkpointsDirectory, id, 'pending.ndjson')
  }

  private manifestPath(id: string): string {
    return join(this.manifestsDirectory, `${id}.json`)
  }
}
