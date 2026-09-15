import type { TaskGroup, TaskGroupRegistry } from './types'

export const TASK_GROUP_NAME_LIMIT = 40

export const taskGroupNameKey = (name: string): string => name.trim().normalize('NFKC').toLowerCase()

export const validateTaskGroupName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入分组名称')
  const name = value.trim()
  if (Array.from(name).length > TASK_GROUP_NAME_LIMIT) throw new Error('分组名称最多 40 个字符')
  if (Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('分组名称不能包含换行或控制字符')
  }
  return name
}

export const emptyTaskGroups = (): TaskGroupRegistry => ({ version: 1, groups: [], memberships: {} })

export const taskGroupFor = (registry: TaskGroupRegistry, taskId: string): TaskGroup | undefined => {
  const id = Object.hasOwn(registry.memberships, taskId) ? registry.memberships[taskId] : undefined
  return registry.groups.find(group => group.id === id)
}

export const parseTaskGroups = (value: unknown): TaskGroupRegistry => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('分组文件格式错误')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.groups) || !record.memberships ||
      typeof record.memberships !== 'object' || Array.isArray(record.memberships)) {
    throw new Error('分组文件格式或版本不受支持')
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  const groups = record.groups.map((entry: unknown): TaskGroup => {
    if (!entry || typeof entry !== 'object') throw new Error('分组记录格式错误')
    const { id, name: value } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) {
      throw new Error('分组 ID 无效或重复')
    }
    const name = validateTaskGroupName(value)
    const key = taskGroupNameKey(name)
    if (names.has(key)) throw new Error('分组名称重复')
    ids.add(id)
    names.add(key)
    return { id, name }
  })
  const memberships = Object.fromEntries(Object.entries(record.memberships).filter(
    ([taskId, groupId]) => /^[A-Za-z0-9_-]+$/.test(taskId) && typeof groupId === 'string' && ids.has(groupId)
  )) as Record<string, string>
  return { version: 1, groups, memberships }
}
