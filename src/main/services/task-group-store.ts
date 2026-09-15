import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import PQueue from 'p-queue'
import { emptyTaskGroups, parseTaskGroups, taskGroupNameKey, validateTaskGroupName } from '@shared/task-groups'
import type { TaskGroupRegistry } from '@shared/types'

export class TaskGroupStore {
  private readonly queue = new PQueue({ concurrency: 1 })
  private readonly path: string

  constructor(root: string, private readonly write: (path: string, content: string) => Promise<void>) {
    this.path = join(root, 'task-groups.json')
  }

  // 任务的创建、复制、删除与分组操作共用队列，避免异步写入覆盖最新归属。
  async serialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.add(operation) as Promise<T>
  }

  async read(): Promise<TaskGroupRegistry> {
    try {
      return parseTaskGroups(JSON.parse(await readFile(this.path, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyTaskGroups()
      throw new Error('无法读取任务分组，请检查 task-groups.json；原有任务配置已保留', { cause: error })
    }
  }

  async persist(registry: TaskGroupRegistry): Promise<TaskGroupRegistry> {
    await this.write(this.path, JSON.stringify(registry, null, 2))
    return registry
  }

  private requireGroup(registry: TaskGroupRegistry, id: string): void {
    if (!registry.groups.some(group => group.id === id)) throw new Error('分组已不存在，请重新选择')
  }

  validateDestination(registry: TaskGroupRegistry, destination: string | null): void {
    if (destination !== null) this.requireGroup(registry, destination)
  }

  async create(name: string): Promise<TaskGroupRegistry> {
    return this.serialize(async () => {
      const registry = await this.read()
      this.addGroup(registry, name)
      return this.persist(registry)
    })
  }

  addGroup(registry: TaskGroupRegistry, value: string): string {
    const name = validateTaskGroupName(value)
    if (registry.groups.some(group => taskGroupNameKey(group.name) === taskGroupNameKey(name))) {
      throw new Error('已存在同名分组，请使用其他名称')
    }
    const id = randomUUID()
    registry.groups.push({ id, name })
    return id
  }

  async rename(id: string, value: string): Promise<TaskGroupRegistry> {
    return this.serialize(async () => {
      const registry = await this.read()
      this.requireGroup(registry, id)
      const name = validateTaskGroupName(value)
      if (registry.groups.some(group => group.id !== id && taskGroupNameKey(group.name) === taskGroupNameKey(name))) {
        throw new Error('已存在同名分组，请使用其他名称')
      }
      registry.groups.find(group => group.id === id)!.name = name
      return this.persist(registry)
    })
  }

  async remove(id: string, destination: string | null): Promise<TaskGroupRegistry> {
    return this.serialize(async () => {
      const registry = await this.read()
      this.requireGroup(registry, id)
      if (id === destination) throw new Error('请选择其他分组或“不分组”')
      this.validateDestination(registry, destination)
      registry.groups = registry.groups.filter(group => group.id !== id)
      for (const [taskId, groupId] of Object.entries(registry.memberships)) {
        if (groupId === id) {
          if (destination === null) delete registry.memberships[taskId]
          else registry.memberships[taskId] = destination
        }
      }
      return this.persist(registry)
    })
  }
}
