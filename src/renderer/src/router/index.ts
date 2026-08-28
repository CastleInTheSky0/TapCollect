import { createRouter, createWebHashHistory } from 'vue-router'
import type {
  RouteLocationRaw,
  RouteRecordName,
  Router,
  RouterHistory
} from 'vue-router'
import type { RunSessionItem, TaskSummary } from '@shared/types'
import { resolveRunTaskSelection } from '@renderer/utils/collector-runtime'
import {
  APP_ROUTE_NAMES,
  createAppRoutes,
  type AppRouteComponents,
  type AppView
} from './routes'

export { APP_ROUTE_NAMES, createAppRoutes }
export type { AppRouteComponents, AppView }

export const appViewFromRouteName = (
  routeName: RouteRecordName | null | undefined
): AppView => routeName === APP_ROUTE_NAMES.runCenter ? 'run-center' : 'task'

export const taskRouteLocation = (taskId = ''): RouteLocationRaw =>
  taskId
    ? { name: APP_ROUTE_NAMES.task, params: { taskId } }
    : { name: APP_ROUTE_NAMES.task }

export const runCenterRouteLocation = (taskId = ''): RouteLocationRaw =>
  taskId
    ? { name: APP_ROUTE_NAMES.runCenter, params: { taskId } }
    : { name: APP_ROUTE_NAMES.runCenter }

export const normalizeRouteParam = (
  value: string | string[] | null | undefined
): string => Array.isArray(value) ? (value[0] ?? '') : (value ?? '')

export const resolveTaskRouteId = (
  requestedTaskId: string,
  tasks: readonly TaskSummary[],
  activeTaskId: string
): string => {
  if (
    requestedTaskId &&
    (requestedTaskId === activeTaskId || tasks.some((task) => task.id === requestedTaskId))
  ) {
    return requestedTaskId
  }
  if (activeTaskId) return activeTaskId
  return tasks[0]?.id ?? ''
}

export const resolveRunCenterRouteId = (
  requestedTaskId: string,
  selectedTaskId: string,
  items: readonly RunSessionItem[]
): string => {
  if (requestedTaskId && items.some((item) => item.taskId === requestedTaskId)) {
    return requestedTaskId
  }
  return resolveRunTaskSelection(selectedTaskId, items, items, true)
}

export const createAppRouter = (
  history: RouterHistory = createWebHashHistory(),
  components?: AppRouteComponents
): Router =>
  createRouter({
    history,
    routes: createAppRoutes(components)
  })
