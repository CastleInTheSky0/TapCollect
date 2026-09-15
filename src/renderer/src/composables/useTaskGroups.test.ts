import { nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask } from '@shared/defaults'
import { emptyTaskGroups } from '@shared/task-groups'
import type { TaskGroupRegistry, TaskSummary } from '@shared/types'
import { taskDraftFingerprint } from '@renderer/utils/task-ipc'
import { useTaskGroups } from './useTaskGroups'

const registry = (): TaskGroupRegistry => ({ version: 1, groups: [{ id: 'g', name: '门户' }], memberships: {} })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const setup = () => {
  const tasks = ref<TaskSummary[]>([{ id: 'a', name: '任务', listUrl: '', updatedAt: '', hasCheckpoint: false, runnable: false }])
  const draft = ref(createTask('a'))
  const savedFingerprint = taskDraftFingerprint(draft.value)
  draft.value.name = '未保存修改'
  const newTask = ref(false)
  const createNewTask = vi.fn()
  const showNotice = vi.fn()
  const showError = vi.fn()
  const store = useTaskGroups({ getTasks: () => tasks.value, getActiveTaskId: () => draft.value.id,
    getDraftGroupId: () => 'g', isNewTask: () => newTask.value, createNewTask, showNotice, showError })
  return { store, tasks, draft, savedFingerprint, newTask, createNewTask, showNotice, showError }
}
afterEach(() => vi.unstubAllGlobals())

describe('useTaskGroups', () => {
  it('publishes only persisted moves and preserves the live draft and dirty fingerprint', async () => {
    const moved = deferred<TaskGroupRegistry>()
    const moveTasksToGroup = vi.fn(() => moved.promise)
    vi.stubGlobal('window', { collector: { getTaskGroups: async () => registry(), moveTasksToGroup } })
    const { store, draft, savedFingerprint } = setup()
    await store.refreshGroups()
    const originalDraft = draft.value
    const originalFingerprint = taskDraftFingerprint(draft.value)
    store.requestMove(['a'])
    store.dialogDestination.value = 'g'
    const confirming = store.confirmDialog()
    expect(store.activeGroupName.value).toBe('')
    expect(store.pending.value).toBe(true)
    moved.resolve({ ...registry(), memberships: { a: 'g' } })
    await confirming
    expect(store.activeGroupName.value).toBe('门户')
    expect(draft.value).toBe(originalDraft)
    expect(taskDraftFingerprint(draft.value)).toBe(originalFingerprint)
    expect(taskDraftFingerprint(draft.value)).not.toBe(savedFingerprint)
    expect(moveTasksToGroup).toHaveBeenCalledExactlyOnceWith(['a'], 'g')
    expect(store.dialog.value).toBeNull()
  })

  it('keeps the dialog, selection and prior registry after a failed move', async () => {
    vi.stubGlobal('window', { collector: { getTaskGroups: async () => registry(), moveTasksToGroup: vi.fn(async () => { throw new Error('写入失败') }) } })
    const { store } = setup()
    await store.refreshGroups()
    store.startBatch()
    store.toggleTaskSelection('a')
    store.requestMove(store.selectedIds.value)
    store.dialogDestination.value = 'g'
    await store.confirmDialog()
    expect(store.dialogError.value).toBe('写入失败')
    expect(store.registry.value).toEqual(registry())
    expect(store.selectedIds.value).toEqual(['a'])
    expect(store.dialog.value?.kind).toBe('move')
    expect(store.pending.value).toBe(false)
    store.closeDialog()
    expect(store.dialog.value).toBeNull()
  })

  it('ignores a stale refresh that finishes after a successful mutation', async () => {
    const loaded = deferred<TaskGroupRegistry>()
    vi.stubGlobal('window', { collector: { getTaskGroups: () => loaded.promise, createTaskGroup: async () => registry() } })
    const { store } = setup()
    const refreshing = store.refreshGroups()
    store.requestCreateGroup()
    store.dialogName.value = '门户'
    await store.confirmDialog()
    loaded.resolve(emptyTaskGroups())
    await refreshing
    expect(store.groups.value).toEqual(registry().groups)
  })

  it('updates breadcrumb for rename, removal and new drafts without adding a root label', async () => {
    vi.stubGlobal('window', { collector: {} })
    const { store, newTask } = setup()
    expect(store.activeGroupName.value).toBe('')
    store.registry.value = { ...registry(), memberships: { a: 'g' } }
    expect(store.activeGroupName.value).toBe('门户')
    store.registry.value.groups[0]!.name = '门户改名'
    expect(store.activeGroupName.value).toBe('门户改名')
    store.registry.value.groups = []
    expect(store.activeGroupName.value).toBe('')
    store.registry.value = registry()
    newTask.value = true
    expect(store.activeGroupName.value).toBe('门户')
    store.registry.value = emptyTaskGroups()
    expect(store.activeGroupName.value).toBe('')
  })

  it('passes selected ownership only when creating a draft and prunes removed batch selections', async () => {
    vi.stubGlobal('window', { collector: {} })
    const { store, tasks, createNewTask } = setup()
    store.requestCreateTask('g')
    store.dialogName.value = '  新采集任务  '
    await store.confirmDialog()
    expect(createNewTask).toHaveBeenCalledExactlyOnceWith('g', '新采集任务')
    store.startBatch()
    store.toggleTaskSelection('a')
    tasks.value = []
    await nextTick()
    expect(store.selectedIds.value).toEqual([])
    store.finishBatch()
    expect(store.batchMode.value).toBe(false)
  })
})
