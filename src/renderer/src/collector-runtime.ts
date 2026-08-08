import type { CollectorApi, RunSessionItem } from '@shared/types'

const LOCKED_RUN_STATUSES = new Set<RunSessionItem['status']>([
  'queued',
  'preparing',
  'running',
  'pausing',
  'paused'
])

export const COLLECTOR_RUNTIME_METHODS = [
  'getSettings',
  'getRunSession',
  'listTasks',
  'chooseResourceDirectory',
  'onRunProgress',
  'onRunLog',
  'onRunFinished',
  'onRunSession'
] as const satisfies ReadonlyArray<keyof CollectorApi>

export const hasCollectorRuntime = (value: unknown): value is CollectorApi => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Record<keyof CollectorApi, unknown>>
  return COLLECTOR_RUNTIME_METHODS.every((method) => typeof candidate[method] === 'function')
}

export const isRunItemLocked = (
  item: Pick<RunSessionItem, 'status'> | null | undefined
): boolean => Boolean(item && LOCKED_RUN_STATUSES.has(item.status))

export const isTaskActivityLocked = (
  taskId: string,
  testingTaskId: string,
  item: Pick<RunSessionItem, 'status'> | null | undefined
): boolean => Boolean(taskId) && (testingTaskId === taskId || isRunItemLocked(item))
