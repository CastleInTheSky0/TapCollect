import { computed, onBeforeUnmount, watch } from 'vue'
import type { WatchHandle } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { RunSessionItem, TaskSummary } from '@shared/types'
import {
  APP_ROUTE_NAMES,
  appViewFromRouteName,
  normalizeRouteParam,
  resolveRunCenterRouteId,
  resolveTaskRouteId,
  runCenterRouteLocation,
  taskRouteLocation
} from '@renderer/router'

export interface AppNavigationDeps {
  showError: (error: unknown) => void
  getTasks: () => readonly TaskSummary[]
  getRunItems: () => readonly RunSessionItem[]
  getActiveTaskId: () => string
  getSelectedRunTaskId: () => string
  loadTask: (taskId: string) => Promise<void>
  selectRunTask: (taskId: string) => void
  schedulePreviewBoundsUpdate: () => void
}

export const useAppNavigation = (deps: AppNavigationDeps) => {
  const route = useRoute()
  const router = useRouter()
  const appView = computed(() => appViewFromRouteName(route.name))
  const routeTaskId = computed(() => normalizeRouteParam(route.params.taskId))
  const stopHandles: WatchHandle[] = []
  let started = false
  let synchronizationQueue = Promise.resolve()

  const synchronizeTaskRoute = async (): Promise<void> => {
    const requestedTaskId = routeTaskId.value
    const taskId = resolveTaskRouteId(
      requestedTaskId,
      deps.getTasks(),
      deps.getActiveTaskId()
    )

    if (taskId && deps.getSelectedRunTaskId() !== taskId) deps.selectRunTask(taskId)
    if (route.name !== APP_ROUTE_NAMES.task || requestedTaskId !== taskId) {
      await router.replace(taskRouteLocation(taskId))
    }
    if (taskId && deps.getActiveTaskId() !== taskId) await deps.loadTask(taskId)
  }

  const synchronizeRunCenterRoute = async (): Promise<void> => {
    const requestedTaskId = routeTaskId.value
    const taskId = resolveRunCenterRouteId(
      requestedTaskId,
      deps.getSelectedRunTaskId(),
      deps.getRunItems()
    )

    if (deps.getSelectedRunTaskId() !== taskId) deps.selectRunTask(taskId)
    if (route.name !== APP_ROUTE_NAMES.runCenter || requestedTaskId !== taskId) {
      await router.replace(runCenterRouteLocation(taskId))
    }
  }

  const synchronizeRoute = async (): Promise<void> => {
    try {
      if (appView.value === 'run-center') await synchronizeRunCenterRoute()
      else await synchronizeTaskRoute()
    } finally {
      deps.schedulePreviewBoundsUpdate()
    }
  }

  const enqueueSynchronization = (): Promise<void> => {
    synchronizationQueue = synchronizationQueue
      .then(synchronizeRoute)
      .catch((error: unknown) => deps.showError(error))
    return synchronizationQueue
  }

  const openTask = async (taskId: string): Promise<void> => {
    await router.push(taskRouteLocation(taskId))
    await enqueueSynchronization()
  }

  const openRunCenter = async (requestedTaskId = ''): Promise<void> => {
    const taskId = resolveRunCenterRouteId(
      requestedTaskId,
      deps.getSelectedRunTaskId(),
      deps.getRunItems()
    )
    if (deps.getSelectedRunTaskId() !== taskId) deps.selectRunTask(taskId)
    await router.push(runCenterRouteLocation(taskId))
    await enqueueSynchronization()
  }

  const start = async (): Promise<void> => {
    if (started) return
    started = true
    stopHandles.push(
      watch(
        () => [
          route.name,
          routeTaskId.value,
          deps.getTasks().map((task) => task.id).join('\u0000'),
          deps.getRunItems().map((item) => item.taskId).join('\u0000')
        ],
        () => void enqueueSynchronization()
      )
    )
    await enqueueSynchronization()
  }

  onBeforeUnmount(() => {
    for (const stop of stopHandles) stop()
  })

  return {
    appView,
    routeTaskId,
    openTask,
    openRunCenter,
    start
  }
}
