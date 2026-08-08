import { describe, expect, it } from 'vitest'
import {
  hasCollectorRuntime,
  isRunItemLocked,
  isTaskActivityLocked
} from './collector-runtime'

describe('collector renderer runtime', () => {
  it('rejects a normal browser page without the Electron preload API', () => {
    expect(hasCollectorRuntime(undefined)).toBe(false)
    expect(hasCollectorRuntime({ getSettings: async () => ({}) })).toBe(false)
  })

  it('accepts the preload methods required during application mount', () => {
    expect(
      hasCollectorRuntime({
        getSettings: async () => ({}),
        getRunSession: async () => ({}),
        listTasks: async () => [],
        chooseResourceDirectory: async () => '',
        onRunProgress: () => () => undefined,
        onRunLog: () => () => undefined,
        onRunFinished: () => () => undefined,
        onRunSession: () => () => undefined
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
})
