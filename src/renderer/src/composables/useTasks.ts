import { ref } from 'vue'
import type { Ref } from 'vue'
import type {
  RunSessionItem,
  RunSessionSnapshot,
  TaskConfigImportResult,
  TaskSummary
} from '@shared/types'
import { isRunItemLocked } from '../collector-runtime'

export interface TasksDeps {
  showError: (error: unknown) => void
  showNotice: (message: string) => void
  showWarning: (message: string) => void
  applyRunSession: (snapshot: RunSessionSnapshot, requireSessionItem?: boolean) => void
  getSelectedRunTaskId: () => string
  clearDismissedTask: (taskId: string) => void
  getRunItem: (taskId: string) => RunSessionItem | null
  getTestingTaskId: () => string
  loadTask: (id: string) => Promise<void>
  clearActiveTask: (id: string) => void
}

export const useTasks = (deps: TasksDeps): {
  tasks: Ref<TaskSummary[]>
  taskConfigTransferring: Ref<boolean>
  taskConfigImportResult: Ref<TaskConfigImportResult | null>
  exportTaskConfigsPrompt: Ref<boolean>
  pendingDeleteTaskId: Ref<string>
  refreshTasks: () => Promise<void>
  duplicateTask: (id: string) => Promise<void>
  importTaskConfigs: () => Promise<void>
  requestExportTaskConfigs: () => void
  exportTaskConfigs: () => Promise<void>
  removeTask: (id: string) => void
  confirmRemoveTask: () => Promise<void>
} => {
  const api = window.collector
  const tasks = ref<TaskSummary[]>([])
  const taskConfigTransferring = ref(false)
  const taskConfigImportResult = ref<TaskConfigImportResult | null>(null)
  const exportTaskConfigsPrompt = ref(false)
  const pendingDeleteTaskId = ref('')

  const refreshTasks = async (): Promise<void> => {
    tasks.value = await api.listTasks()
  }

  const duplicateTask = async (id: string): Promise<void> => {
    try {
      const copy = await api.duplicateTask(id)
      await refreshTasks()
      await deps.loadTask(copy.id)
      deps.showNotice('已创建任务副本')
    } catch (error) {
      deps.showError(error)
    }
  }

  const importTaskConfigs = async (): Promise<void> => {
    if (taskConfigTransferring.value) return
    taskConfigTransferring.value = true
    try {
      const result = await api.importTaskConfigs()
      if (result.cancelled) return
      taskConfigImportResult.value = result
      await refreshTasks()
      const firstImported = result.imported[0]
      if (firstImported) await deps.loadTask(firstImported.id)
    } catch (error) {
      deps.showError(error)
    } finally {
      taskConfigTransferring.value = false
    }
  }

  const requestExportTaskConfigs = (): void => {
    if (tasks.value.length === 0) {
      deps.showWarning('请先保存至少一个任务，再导出任务配置')
      return
    }
    exportTaskConfigsPrompt.value = true
  }

  const exportTaskConfigs = async (): Promise<void> => {
    if (taskConfigTransferring.value) return
    exportTaskConfigsPrompt.value = false
    taskConfigTransferring.value = true
    try {
      const result = await api.exportTaskConfigs()
      if (!result.cancelled) deps.showNotice(`已导出 ${result.taskCount} 个任务配置`)
    } catch (error) {
      deps.showError(error)
    } finally {
      taskConfigTransferring.value = false
    }
  }

  const removeTask = (id: string): void => {
    const item = deps.getRunItem(id)
    if (isRunItemLocked(item) || deps.getTestingTaskId() === id) {
      deps.showWarning('运行、暂停、排队或测试中的任务不能删除')
      return
    }
    pendingDeleteTaskId.value = id
  }

  const confirmRemoveTask = async (): Promise<void> => {
    const id = pendingDeleteTaskId.value
    if (!id) return
    try {
      await api.deleteTask(id)
      deps.applyRunSession(await api.getRunSession(), deps.getSelectedRunTaskId() === id)
      deps.clearActiveTask(id)
      deps.clearDismissedTask(id)
      await refreshTasks()
      pendingDeleteTaskId.value = ''
      deps.showNotice('任务配置和运行中心记录已删除，采集输出文件已保留')
    } catch (error) {
      deps.showError(error)
    }
  }

  return {
    tasks,
    taskConfigTransferring,
    taskConfigImportResult,
    exportTaskConfigsPrompt,
    pendingDeleteTaskId,
    refreshTasks,
    duplicateTask,
    importTaskConfigs,
    requestExportTaskConfigs,
    exportTaskConfigs,
    removeTask,
    confirmRemoveTask
  }
}
