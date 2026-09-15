import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TaskGroupStore } from './task-group-store'
import { taskGroupFor, taskGroupNameKey } from '@shared/task-groups'
import {
  createEmptyResourceCounters,
  DEFAULT_SETTINGS,
  isTaskRunnable,
  normalizeAppSettings,
  normalizeTaskConfig
} from '@shared/defaults'
import { firstTaskListPageUrl } from '@shared/list-page-rules'
import {
  importedTaskCandidateName,
  prepareImportedTaskConfig
} from '@shared/task-config-bundle'
import type {
  AppSettings,
  ExtractedRecord,
  RunCheckpoint,
  ParsedTaskConfigBundle,
  TaskConfig,
  TaskCreationResult,
  TaskGroupRegistry,
  TaskConfigImportFailure,
  TaskConfigImportSuccess,
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

export const atomicWrite = async (path: string, content: string | Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content)
    await rename(temporary, path)
  } finally {
    // 替换失败时保留旧文件；不可先删目标，否则第二次重命名失败会丢失数据。
    await rm(temporary, { force: true }).catch(() => undefined)
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
  readonly groups: TaskGroupStore
  private readonly settingsPath: string
  private readonly tasksDirectory: string
  private readonly checkpointsDirectory: string
  private readonly manifestsDirectory: string

  constructor(readonly rootDirectory: string) {
    this.groups = new TaskGroupStore(rootDirectory, atomicWrite)
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

  async saveSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
    const previous = await this.getSettings()
    const normalized = normalizeAppSettings({ ...previous, ...settings, access: { ...previous.access, ...settings?.access } })
    await atomicWrite(this.settingsPath, JSON.stringify(normalized, null, 2))
    return normalized
  }

  async listTasks(): Promise<TaskSummary[]> {
    const taskConfigs = await this.listTaskConfigs()
    const summaries: TaskSummary[] = []
    for (const task of taskConfigs) {
      summaries.push({
        id: task.id,
        name: task.name,
        listUrl: firstTaskListPageUrl(task),
        updatedAt: task.updatedAt,
        runnable: isTaskRunnable(task),
        hasCheckpoint: await this.hasCheckpoint(task.id)
      })
    }
    return summaries
  }

  async listTaskConfigs(): Promise<TaskConfig[]> {
    await this.initialize()
    const entries = await readdir(this.tasksDirectory, { withFileTypes: true })
    const tasks: TaskConfig[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue
      const task = await this.loadTask(entry.name)
      if (task) tasks.push(task)
    }
    return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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

  async saveNewTask(task: TaskConfig, groupId: string | null): Promise<TaskCreationResult> {
    if (groupId !== null && typeof groupId !== 'string') throw new Error('请选择有效的分组或“不分组”')
    return this.groups.serialize(async () => {
      if (await this.loadTask(task.id)) throw new Error('任务已存在，请刷新后再保存')
      const saved = await this.saveTask(task)
      return this.assignCreatedTask(saved, groupId)
    })
  }

  private async assignCreatedTask(task: TaskConfig, groupId: string | null): Promise<TaskCreationResult> {
    if (groupId === null) return { task, warning: '' }
    try {
      const registry = await this.groups.read()
      if (!registry.groups.some(group => group.id === groupId)) {
        return { task, warning: '任务已保存，原分组已不存在，任务已保留在“不分组”位置' }
      }
      Object.defineProperty(registry.memberships, task.id, { value: groupId, enumerable: true, configurable: true, writable: true })
      await this.groups.persist(registry)
      return { task, warning: '' }
    } catch {
      return { task, warning: '任务已保存，但分组保存失败，任务已保留在“不分组”位置，请稍后重新移动' }
    }
  }

  async moveTasksToGroup(ids: string[], destination: string | null): Promise<TaskGroupRegistry> {
    return this.groups.serialize(async () => {
      if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string')) {
        throw new Error('请至少选择一个已保存任务')
      }
      const registry = await this.groups.read()
      this.groups.validateDestination(registry, destination)
      for (const id of new Set(ids)) {
        if (!await this.loadTask(id)) throw new Error('找不到任务，请刷新列表后重试')
        if (destination === null) delete registry.memberships[id]
        else Object.defineProperty(registry.memberships, id, { value: destination, enumerable: true, configurable: true, writable: true })
      }
      return this.groups.persist(registry)
    })
  }

  async duplicateTask(id: string): Promise<TaskCreationResult> {
    return this.groups.serialize(async () => {
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
      const saved = await this.saveTask(copy)
      try {
        const groupId = taskGroupFor(await this.groups.read(), id)?.id ?? null
        return await this.assignCreatedTask(saved, groupId)
      } catch {
        return { task: saved, warning: '副本已创建，但无法读取原任务分组，副本已保留在“不分组”位置' }
      }
    })
  }

  async importTaskConfigs(input: unknown[] | ParsedTaskConfigBundle): Promise<{
    imported: TaskConfigImportSuccess[]
    skipped: TaskConfigImportFailure[]
    warnings: TaskConfigImportFailure[]
  }> {
    return this.groups.serialize(async () => {
      const bundle = Array.isArray(input) ? { tasks: input, groups: [], taskGroupIds: [] } : input
      const entries = bundle.tasks
      const imported: TaskConfigImportSuccess[] = []
      const skipped: TaskConfigImportFailure[] = []
      const warnings: TaskConfigImportFailure[] = []

      for (const [index, entry] of entries.entries()) {
        const sourceIndex = index + 1
        const name = importedTaskCandidateName(entry)
        try {
          const prepared = prepareImportedTaskConfig(entry, randomUUID())
          const saved = await this.saveTask(prepared)
          imported.push({ sourceIndex, id: saved.id, name: saved.name })
        } catch (error) {
          skipped.push({
            sourceIndex,
            name,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }

      if (imported.length > 0 && (bundle.groups.length > 0 || bundle.taskGroupIds.some(Boolean))) {
        try {
          const registry = await this.groups.read()
          const groupMap = new Map<string, string>()
          for (const group of bundle.groups) {
            const local = registry.groups.find(item => taskGroupNameKey(item.name) === taskGroupNameKey(group.name))
            groupMap.set(group.id, local?.id ?? this.groups.addGroup(registry, group.name))
          }
          for (const entry of imported) {
            const sourceGroupId = bundle.taskGroupIds[entry.sourceIndex - 1]
            if (!sourceGroupId) continue
            const groupId = groupMap.get(sourceGroupId)
            if (groupId) registry.memberships[entry.id] = groupId
            else warnings.push({ ...entry, reason: '引用的分组不存在，任务已保留在“不分组”位置' })
          }
          await this.groups.persist(registry)
        } catch {
          warnings.length = 0
          for (const entry of imported) {
            warnings.push({ ...entry, reason: '任务已导入，但分组保存失败，任务已保留在“不分组”位置' })
          }
        }
      }
      return { imported, skipped, warnings }
    })
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.groups.serialize(async () => {
      validateId(id)
      const task = await this.loadTask(id)
      if (!task) return false
      const registry = await this.groups.read()
      if (Object.hasOwn(registry.memberships, id)) {
        delete registry.memberships[id]
        await this.groups.persist(registry)
      }
      await rm(join(this.tasksDirectory, id), { recursive: true, force: true })
      await this.clearCheckpoint(id)
      await rm(this.manifestPath(id), { force: true })
      return true
    })
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
