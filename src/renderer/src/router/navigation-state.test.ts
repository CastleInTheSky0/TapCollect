import { describe, expect, it } from 'vitest'
import type { RunSessionItem, RunSessionStatus, TaskSummary } from '@shared/types'
import {
  normalizeRouteParam,
  resolveRunCenterRouteId,
  resolveTaskRouteId
} from './index'

const task = (id: string): TaskSummary => ({
  id,
  name: id,
  listUrl: '',
  updatedAt: '',
  runnable: true,
  hasCheckpoint: false
})

const runItem = (taskId: string, status: RunSessionStatus): RunSessionItem => ({
  taskId,
  taskName: taskId,
  runId: `run-${taskId}`,
  status,
  resume: false,
  queuePosition: 0,
  queueReason: '',
  queuedAt: '',
  startedAt: '',
  pausedAt: '',
  finishedAt: '',
  message: '',
  progress: null,
  result: null,
  logs: []
})

describe('navigation state', () => {
  it('normalizes optional and repeated route params', () => {
    expect(normalizeRouteParam(undefined)).toBe('')
    expect(normalizeRouteParam('task-1')).toBe('task-1')
    expect(normalizeRouteParam(['task-2', 'ignored'])).toBe('task-2')
  })

  it('keeps a valid task route and safely falls back from an invalid one', () => {
    const tasks = [task('task-1'), task('task-2')]
    expect(resolveTaskRouteId('task-2', tasks, 'task-1')).toBe('task-2')
    expect(resolveTaskRouteId('missing', tasks, 'task-1')).toBe('task-1')
    expect(resolveTaskRouteId('missing', tasks, '')).toBe('task-1')
    expect(resolveTaskRouteId('draft-id', tasks, 'draft-id')).toBe('draft-id')
    expect(resolveTaskRouteId('', [], '')).toBe('')
  })

  it('keeps a valid run selection and otherwise prefers the current or active item', () => {
    const items = [runItem('idle-result', 'completed'), runItem('active', 'running')]
    expect(resolveRunCenterRouteId('idle-result', 'active', items)).toBe('idle-result')
    expect(resolveRunCenterRouteId('missing', 'idle-result', items)).toBe('idle-result')
    expect(resolveRunCenterRouteId('missing', 'missing', items)).toBe('active')
    expect(resolveRunCenterRouteId('', '', [])).toBe('')
  })
})
