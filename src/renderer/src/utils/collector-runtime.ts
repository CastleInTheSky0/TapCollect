import type { CollectorApi, RunSessionItem } from '@shared/types'

const LOCKED_RUN_STATUSES = new Set<RunSessionItem['status']>([
  'queued',
  'preparing',
  'running',
  'pausing',
  'paused'
])

export const COLLECTOR_RUNTIME_METHODS = [
  'getAppRuntimeInfo',
  'checkForUpdates',
  'downloadUpdate',
  'installUpdate',
  'openUpdateRelease',
  'getSettings',
  'getRunSession',
  'listTasks',
  'chooseResourceDirectory',
  'onRunProgress',
  'onRunLog',
  'onRunFinished',
  'onRunSession',
  'onUpdateDownloadProgress'
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

type RunSelectionItem = Pick<RunSessionItem, 'taskId' | 'status'>

export const resolveRunTaskSelection = (
  currentTaskId: string,
  previousItems: readonly RunSelectionItem[],
  nextItems: readonly RunSelectionItem[],
  requireSessionItem = false
): string => {
  if (currentTaskId && nextItems.some((item) => item.taskId === currentTaskId)) {
    return currentTaskId
  }

  const selectedPreviousItem = previousItems.some((item) => item.taskId === currentTaskId)
  if (currentTaskId && !requireSessionItem && !selectedPreviousItem) return currentTaskId

  return nextItems.find((item) => isRunItemLocked(item))?.taskId ?? nextItems[0]?.taskId ?? ''
}
