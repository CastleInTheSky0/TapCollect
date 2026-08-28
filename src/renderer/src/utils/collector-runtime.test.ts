import { describe, expect, it } from 'vitest'
import {
  hasCollectorRuntime,
  isRunItemLocked,
  isTaskActivityLocked,
  resolveRunTaskSelection
} from './collector-runtime'

describe('collector renderer runtime', () => {
  it('rejects a normal browser page without the Electron preload API', () => {
    expect(hasCollectorRuntime(undefined)).toBe(false)
    expect(hasCollectorRuntime({ getSettings: async () => ({}) })).toBe(false)
  })

  it('accepts the preload methods required during application mount', () => {
    expect(
      hasCollectorRuntime({
        getAppRuntimeInfo: async () => ({}),
        checkForUpdates: async () => ({}),
        downloadUpdate: async () => ({}),
        installUpdate: async () => ({}),
        openUpdateRelease: async () => true,
        getSettings: async () => ({}),
        getRunSession: async () => ({}),
        listTasks: async () => [],
        chooseResourceDirectory: async () => '',
        onRunProgress: () => () => undefined,
        onRunLog: () => () => undefined,
        onRunFinished: () => () => undefined,
        onRunSession: () => () => undefined,
        onUpdateDownloadProgress: () => () => undefined
      })
    ).toBe(true)
  })

  it('does not treat an empty task id as an active test task', () => {
    expect(isTaskActivityLocked('', '', undefined)).toBe(false)
  })

  it('locks only active task states or the matching test task', () => {
    expect(isTaskActivityLocked('task-a', 'task-a', undefined)).toBe(true)
    expect(isTaskActivityLocked('task-a', '', { status: 'queued' })).toBe(true)
    expect(isTaskActivityLocked('task-a', '', { status: 'completed' })).toBe(false)
    expect(isRunItemLocked({ status: 'paused' })).toBe(true)
    expect(isRunItemLocked({ status: 'failed' })).toBe(false)
  })

  it('falls back to a remaining active run when the selected run record is removed', () => {
    const previousItems = [
      { taskId: 'deleted-task', status: 'completed' as const },
      { taskId: 'running-task', status: 'running' as const }
    ]
    const nextItems = [
      { taskId: 'finished-task', status: 'completed' as const },
      { taskId: 'running-task', status: 'running' as const }
    ]

    expect(resolveRunTaskSelection('deleted-task', previousItems, nextItems)).toBe('running-task')
    expect(resolveRunTaskSelection('running-task', previousItems, nextItems)).toBe('running-task')
  })

  it('keeps an idle task selection outside the run center and clears an empty session', () => {
    const items = [{ taskId: 'finished-task', status: 'completed' as const }]

    expect(resolveRunTaskSelection('idle-task', items, items)).toBe('idle-task')
    expect(resolveRunTaskSelection('idle-task', items, items, true)).toBe('finished-task')
    expect(resolveRunTaskSelection('deleted-task', items, [])).toBe('deleted-task')
    expect(resolveRunTaskSelection('finished-task', items, [])).toBe('')
  })
})
