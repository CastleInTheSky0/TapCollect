import { describe, expect, it } from 'vitest'
import { hasCollectorRuntime } from './collector-runtime'

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
})
