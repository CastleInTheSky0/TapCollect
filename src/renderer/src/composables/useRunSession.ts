import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import type {
  AppSettings,
  RunLog,
  RunProgress,
  RunResult,
  RunSessionItem,
  RunSessionSnapshot,
  TaskConfig
} from '@shared/types'
import {
  isRunItemLocked,
  isTaskActivityLocked,
  resolveRunTaskSelection
} from '../collector-runtime'
import type { AppView } from './useAppView'

export interface RunSessionDeps {
  showError: (error: unknown) => void
  showNotice: (message: string) => void
  showWarning: (message: string) => void
  formatConfigurationIssues: (intro: string, issues: string[]) => string
  settings: Ref<AppSettings>
  appView: Ref<AppView>
  schedulePreviewBoundsUpdate: () => void
  getActiveId: () => string
  refreshTasks: () => Promise<void>
  loadTask: (id: string) => Promise<void>
  closePreview: () => Promise<void>
  getPreviewVisible: () => boolean
  getActiveTask: () => TaskConfig | null
  getHasUnsavedChanges: () => boolean
  getConfigurationIssues: () => string[]
}

export const useRunSession = (deps: RunSessionDeps) => {
  const api = window.collector
  const runSession = ref<RunSessionSnapshot>({
    maxConcurrentRuns: 3,
    activeCount: 0,
    queuedCount: 0,
    testingTaskId: '',
    items: []
  })
  const selectedRunTaskId = ref('')
  const dismissedRunTaskIds = ref<Set<string>>(new Set())
  const runActionTaskId = ref('')
  const batchRunAction = ref('')
  const resumePrompt = ref(false)
  const pendingRunTaskId = ref('')
  const cancelPromptTaskId = ref('')
  const cancelAllPrompt = ref(false)

  const runItemMap = computed(() =>
    new Map(runSession.value.items.map((item) => [item.taskId, item] as const))
  )
  const activeTaskRunItem = computed(() => runItemMap.value.get(deps.getActiveId()))
  const activeTaskLocked = computed(
    () =>
      isTaskActivityLocked(
        deps.getActiveId(),
        runSession.value.testingTaskId,
        activeTaskRunItem.value
      )
  )
  const selectedRunItem = computed(() => runItemMap.value.get(selectedRunTaskId.value) ?? null)
  const runProgress = computed<RunProgress | null>(() => selectedRunItem.value?.progress ?? null)
  const runLogs = computed<RunLog[]>(() => selectedRunItem.value?.logs ?? [])
  const runResult = computed<RunResult | null>(() => selectedRunItem.value?.result ?? null)
  const selectedRunLocked = computed(() => isRunItemLocked(selectedRunItem.value ?? undefined))
  const showRunDrawer = computed(
    () =>
      deps.appView.value === 'task' &&
      Boolean(selectedRunItem.value) &&
      !dismissedRunTaskIds.value.has(selectedRunItem.value?.taskId ?? '')
  )

  const applyRunSession = (
    snapshot: RunSessionSnapshot,
    requireSessionItem = false
  ): void => {
    selectedRunTaskId.value = resolveRunTaskSelection(
      selectedRunTaskId.value,
      runSession.value.items,
      snapshot.items,
      requireSessionItem
    )
    runSession.value = snapshot
    deps.settings.value.maxConcurrentRuns = snapshot.maxConcurrentRuns
  }

  const refreshFromMain = async (): Promise<void> => {
    runSession.value = await api.getRunSession()
  }

  const showRunCenter = (): void => {
    deps.appView.value = 'run-center'
    selectedRunTaskId.value = resolveRunTaskSelection(
      selectedRunTaskId.value,
      runSession.value.items,
      runSession.value.items,
      true
    )
    deps.schedulePreviewBoundsUpdate()
  }

  const requestRun = async (id?: string): Promise<void> => {
    const requestedId = id ?? deps.getActiveTask()?.id ?? ''
    const existing = runItemMap.value.get(requestedId)
    if (existing?.status === 'paused') {
      await resumeRun(requestedId)
      return
    }
    if (isRunItemLocked(existing) || runSession.value.testingTaskId === requestedId) {
      deps.showWarning('该任务已经在运行、暂停、排队或测试中')
      return
    }
    if (id && id !== deps.getActiveTask()?.id) {
      await deps.loadTask(id)
      if (deps.getActiveTask()?.id !== id) return
    }
    const task = deps.getActiveTask()
    if (!task) return
    if (deps.getHasUnsavedChanges()) {
      deps.showWarning('当前配置尚未保存，请先点击“保存草稿”，再开始正式采集')
      return
    }
    const issues = deps.getConfigurationIssues()
    if (issues.length > 0) {
      deps.showWarning(deps.formatConfigurationIssues('任务配置尚未完成，无法开始正式采集', issues))
      return
    }
    const checkpoint = await api.getCheckpoint(task.id)
    pendingRunTaskId.value = task.id
    if (checkpoint) resumePrompt.value = true
    else await launchRun(false)
  }

  const launchRun = async (resume: boolean): Promise<void> => {
    const taskId = pendingRunTaskId.value || deps.getActiveTask()?.id || ''
    if (!taskId) return
    resumePrompt.value = false
    pendingRunTaskId.value = ''
    if (deps.getPreviewVisible()) await deps.closePreview()
    selectedRunTaskId.value = taskId
    dismissedRunTaskIds.value = new Set(
      [...dismissedRunTaskIds.value].filter((candidate) => candidate !== taskId)
    )
    runActionTaskId.value = taskId
    try {
      const result = await api.startRun(taskId, resume)
      if (result.status === 'queued') {
        deps.showNotice(`任务已加入等待队列${result.queuePosition ? `，当前排队第 ${result.queuePosition}` : ''}`)
      } else {
        deps.showNotice(resume ? '任务已开始继续采集' : '任务已开始采集')
      }
      runSession.value = await api.getRunSession()
      await deps.refreshTasks()
    } catch (error) {
      deps.showError(error)
    } finally {
      runActionTaskId.value = ''
    }
  }

  const pauseRun = async (taskId = selectedRunItem.value?.taskId ?? ''): Promise<void> => {
    if (!taskId || runActionTaskId.value) return
    runActionTaskId.value = taskId
    try {
      if (!(await api.pauseRun(taskId))) deps.showWarning('当前任务暂时不能暂停')
    } catch (error) {
      deps.showError(error)
    } finally {
      runActionTaskId.value = ''
    }
  }

  const resumeRun = async (taskId = selectedRunItem.value?.taskId ?? ''): Promise<void> => {
    if (!taskId || runActionTaskId.value) return
    selectedRunTaskId.value = taskId
    runActionTaskId.value = taskId
    try {
      if (await api.resumeRun(taskId)) deps.showNotice('任务已加入继续采集队列')
      else deps.showWarning('当前任务暂时不能继续')
    } catch (error) {
      deps.showError(error)
    } finally {
      runActionTaskId.value = ''
    }
  }

  const cancelRun = (taskId = selectedRunItem.value?.taskId ?? ''): void => {
    if (!taskId) return
    cancelPromptTaskId.value = taskId
  }

  const confirmCancelRun = async (): Promise<void> => {
    const taskId = cancelPromptTaskId.value
    if (!taskId) return
    cancelPromptTaskId.value = ''
    runActionTaskId.value = taskId
    try {
      if (!(await api.cancelRun(taskId))) deps.showWarning('当前任务已经不能取消')
    } catch (error) {
      deps.showError(error)
    } finally {
      runActionTaskId.value = ''
    }
  }

  const pauseAllRuns = async (): Promise<void> => {
    if (batchRunAction.value) return
    batchRunAction.value = 'pause'
    try {
      if (!(await api.pauseAllRuns())) deps.showWarning('当前没有可暂停的任务')
    } catch (error) {
      deps.showError(error)
    } finally {
      batchRunAction.value = ''
    }
  }

  const resumeAllRuns = async (): Promise<void> => {
    if (batchRunAction.value) return
    batchRunAction.value = 'resume'
    try {
      if (!(await api.resumeAllRuns())) deps.showWarning('当前没有已暂停的任务')
    } catch (error) {
      deps.showError(error)
    } finally {
      batchRunAction.value = ''
    }
  }

  const requestCancelAllRuns = (): void => {
    cancelAllPrompt.value = true
  }

  const confirmCancelAllRuns = async (): Promise<void> => {
    cancelAllPrompt.value = false
    if (batchRunAction.value) return
    batchRunAction.value = 'cancel'
    try {
      if (!(await api.cancelAllRuns())) deps.showWarning('当前没有可取消的任务')
    } catch (error) {
      deps.showError(error)
    } finally {
      batchRunAction.value = ''
    }
  }

  const selectRunTask = (taskId: string): void => {
    selectedRunTaskId.value = taskId
    dismissedRunTaskIds.value = new Set(
      [...dismissedRunTaskIds.value].filter((candidate) => candidate !== taskId)
    )
  }

  const dismissRunDrawer = (): void => {
    const taskId = selectedRunItem.value?.taskId
    if (!taskId) return
    dismissedRunTaskIds.value = new Set([...dismissedRunTaskIds.value, taskId])
  }

  const openOutput = async (taskId = selectedRunItem.value?.taskId ?? deps.getActiveTask()?.id ?? ''): Promise<void> => {
    if (taskId) await api.openOutputDirectory(taskId)
  }

  const openErrorLog = async (taskId = selectedRunItem.value?.taskId ?? ''): Promise<void> => {
    const item = runItemMap.value.get(taskId)
    if (taskId && item?.result?.errorLogPath) {
      await api.openErrorLog(taskId, item.result.errorLogPath)
    }
  }

  const clearDismissedTask = (taskId: string): void => {
    dismissedRunTaskIds.value = new Set(
      [...dismissedRunTaskIds.value].filter((candidate) => candidate !== taskId)
    )
  }

  const getRunItem = (taskId: string): RunSessionItem | null =>
    runItemMap.value.get(taskId) ?? null

  onMounted(() => {
    const removeProgressListener = api.onRunProgress((progress) => {
      const item = runSession.value.items.find((candidate) => candidate.taskId === progress.taskId)
      if (!item) return
      item.runId = progress.runId
      item.progress = progress
      item.message = progress.message
      if (progress.status !== 'idle') item.status = progress.status
      dismissedRunTaskIds.value = new Set(
        [...dismissedRunTaskIds.value].filter((taskId) => taskId !== progress.taskId)
      )
    })
    const removeLogListener = api.onRunLog((log) => {
      const item = runSession.value.items.find((candidate) => candidate.taskId === log.taskId)
      if (!item) return
      item.logs.push(log)
      if (item.logs.length > 500) item.logs.splice(0, item.logs.length - 500)
    })
    const removeFinishedListener = api.onRunFinished((result) => {
      const item = runSession.value.items.find((candidate) => candidate.taskId === result.taskId)
      if (item) {
        item.status = result.status
        item.result = result
        item.message = result.message
        item.finishedAt = result.finishedAt
      }
      void deps.refreshTasks()
    })
    const removeSessionListener = api.onRunSession(applyRunSession)
    onBeforeUnmount(() => {
      removeProgressListener()
      removeLogListener()
      removeFinishedListener()
      removeSessionListener()
    })
  })

  return {
    runSession,
    selectedRunTaskId,
    dismissedRunTaskIds,
    runActionTaskId,
    batchRunAction,
    resumePrompt,
    pendingRunTaskId,
    cancelPromptTaskId,
    cancelAllPrompt,
    runItemMap,
    activeTaskRunItem,
    activeTaskLocked,
    selectedRunItem,
    runProgress,
    runLogs,
    runResult,
    selectedRunLocked,
    showRunDrawer,
    applyRunSession,
    showRunCenter,
    requestRun,
    launchRun,
    pauseRun,
    resumeRun,
    cancelRun,
    confirmCancelRun,
    pauseAllRuns,
    resumeAllRuns,
    requestCancelAllRuns,
    confirmCancelAllRuns,
    selectRunTask,
    dismissRunDrawer,
    openOutput,
    openErrorLog,
    clearDismissedTask,
    getRunItem,
    refreshFromMain
  }
}
