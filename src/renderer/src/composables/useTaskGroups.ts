import { computed, ref, watch } from 'vue'
import { emptyTaskGroups, taskGroupFor, validateTaskGroupName } from '@shared/task-groups'
import type { TaskGroupRegistry, TaskSummary } from '@shared/types'
import { messageFromError } from '@renderer/utils/error-message'

export type TaskGroupDialog =
  | { kind: 'create-group' }
  | { kind: 'rename-group'; groupId: string }
  | { kind: 'delete-group'; groupId: string }
  | { kind: 'move'; taskIds: string[] }
  | { kind: 'create-task' }

interface TaskGroupsDeps {
  getTasks: () => TaskSummary[]
  getActiveTaskId: () => string
  getDraftGroupId: () => string | null
  isNewTask: () => boolean
  createNewTask: (groupId: string | null, name: string) => void
  showError: (error: unknown) => void
  showNotice: (message: string) => void
}

export const useTaskGroups = (deps: TaskGroupsDeps) => {
  const api = window.collector
  const registry = ref<TaskGroupRegistry>(emptyTaskGroups())
  const loadError = ref('')
  const dialog = ref<TaskGroupDialog | null>(null)
  const dialogName = ref('')
  const dialogDestination = ref('')
  const dialogError = ref('')
  const pending = ref(false)
  const batchMode = ref(false)
  const selectedIds = ref<string[]>([])
  let refreshSequence = 0

  const activeGroupName = computed(() => {
    if (deps.isNewTask()) return registry.value.groups.find(group => group.id === deps.getDraftGroupId())?.name ?? ''
    return taskGroupFor(registry.value, deps.getActiveTaskId())?.name ?? ''
  })
  const groups = computed(() => registry.value.groups)
  watch(() => deps.getTasks().map(task => task.id), (ids) => {
    selectedIds.value = selectedIds.value.filter(id => ids.includes(id))
  })

  const acceptRegistry = (next: TaskGroupRegistry): void => {
    refreshSequence += 1
    registry.value = next
    loadError.value = ''
  }
  const refreshGroups = async (): Promise<void> => {
    const sequence = ++refreshSequence
    try {
      const next = await api.getTaskGroups()
      if (sequence === refreshSequence) acceptRegistry(next)
    } catch (error) {
      if (sequence !== refreshSequence) return
      loadError.value = messageFromError(error)
      deps.showError(error)
    }
  }
  const openDialog = (next: TaskGroupDialog, name = '', destination = ''): void => {
    if (pending.value) return
    dialogName.value = name
    dialogDestination.value = destination
    dialogError.value = ''
    dialog.value = next
  }
  const requestCreateGroup = (): void => openDialog({ kind: 'create-group' })
  const requestCreateTask = (groupId: string | null = null): void => openDialog({ kind: 'create-task' }, '', groupId ?? '')
  const requestRenameGroup = (groupId: string): void => {
    const group = groups.value.find(item => item.id === groupId)
    if (group) openDialog({ kind: 'rename-group', groupId }, group.name)
  }
  const requestDeleteGroup = (groupId: string): void => openDialog({ kind: 'delete-group', groupId })
  const requestMove = (taskIds: string[]): void => {
    const ids = taskIds.filter(id => deps.getTasks().some(task => task.id === id))
    if (ids.length === 0) return
    const destination = ids.length === 1 ? taskGroupFor(registry.value, ids[0]!)?.id ?? '' : ''
    openDialog({ kind: 'move', taskIds: [...new Set(ids)] }, '', destination)
  }
  const closeDialog = (): void => { if (!pending.value) dialog.value = null }
  const startBatch = (): void => { batchMode.value = true; selectedIds.value = [] }
  const finishBatch = (): void => { batchMode.value = false; selectedIds.value = [] }
  const toggleTaskSelection = (id: string): void => {
    if (!deps.getTasks().some(task => task.id === id)) return
    selectedIds.value = selectedIds.value.includes(id)
      ? selectedIds.value.filter(item => item !== id) : [...selectedIds.value, id]
  }
  const confirmDialog = async (): Promise<void> => {
    const operation = dialog.value
    if (!operation || pending.value) return
    pending.value = true
    dialogError.value = ''
    try {
      const destination = dialogDestination.value || null
      if (operation.kind === 'create-task') {
        const name = dialogName.value.trim()
        if (!name) throw new Error('请输入任务名称')
        if (name.length > 120) throw new Error('任务名称最多 120 个字符')
        deps.createNewTask(destination, name)
      } else {
        let next: TaskGroupRegistry
        let notice: string
        if (operation.kind === 'create-group') {
          next = await api.createTaskGroup(validateTaskGroupName(dialogName.value))
          notice = '分组已创建'
        } else if (operation.kind === 'rename-group') {
          next = await api.renameTaskGroup(operation.groupId, validateTaskGroupName(dialogName.value))
          notice = '分组名称已更新'
        } else if (operation.kind === 'delete-group') {
          next = await api.deleteTaskGroup(operation.groupId, destination)
          notice = '分组已删除，任务已保留'
        } else {
          next = await api.moveTasksToGroup([...operation.taskIds], destination)
          notice = `已移动 ${operation.taskIds.length} 个任务`
          selectedIds.value = []
        }
        acceptRegistry(next)
        deps.showNotice(notice)
      }
      dialog.value = null
    } catch (error) {
      dialogError.value = messageFromError(error)
    } finally {
      pending.value = false
    }
  }

  return {
    registry, groups, loadError, activeGroupName, dialog, dialogName, dialogDestination, dialogError,
    pending, batchMode, selectedIds, refreshGroups, requestCreateGroup, requestCreateTask,
    requestRenameGroup, requestDeleteGroup, requestMove, closeDialog, startBatch, finishBatch,
    toggleTaskSelection, confirmDialog
  }
}
