import type { RouteRecordRaw, RouteRecordSingleView } from 'vue-router'

export const APP_ROUTE_NAMES = {
  task: 'task',
  runCenter: 'run-center',
  settings: 'settings'
} as const

export type AppView = (typeof APP_ROUTE_NAMES)[keyof typeof APP_ROUTE_NAMES]

type AppRouteComponent = RouteRecordSingleView['component']

export interface AppRouteComponents {
  task: AppRouteComponent
  runCenter: AppRouteComponent
  settings?: AppRouteComponent
}

const defaultComponents: Required<AppRouteComponents> = {
  task: () => import('@renderer/views/TaskWorkspace/index.vue'),
  runCenter: () => import('@renderer/views/RunCenter/index.vue'),
  settings: () => import('@renderer/views/Settings/index.vue')
}

export const createAppRoutes = (
  components: AppRouteComponents = defaultComponents
): RouteRecordRaw[] => [
  { path: '/', redirect: '/tasks' },
  {
    path: '/tasks/:taskId?',
    name: APP_ROUTE_NAMES.task,
    component: components.task
  },
  {
    path: '/run-center/:taskId?',
    name: APP_ROUTE_NAMES.runCenter,
    component: components.runCenter
  },
  { path: '/settings/:section?', name: APP_ROUTE_NAMES.settings, component: components.settings ?? defaultComponents.settings },
  { path: '/:pathMatch(.*)*', redirect: '/tasks' }
]
