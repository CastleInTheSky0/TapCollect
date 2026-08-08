import type { CollectorApi } from '@shared/types'

export const COLLECTOR_RUNTIME_METHODS = [
  'getSettings',
  'listTasks',
  'chooseResourceDirectory',
  'onRunProgress',
  'onRunLog',
  'onRunFinished'
] as const satisfies ReadonlyArray<keyof CollectorApi>

export const hasCollectorRuntime = (value: unknown): value is CollectorApi => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Record<keyof CollectorApi, unknown>>
  return COLLECTOR_RUNTIME_METHODS.every((method) => typeof candidate[method] === 'function')
}
