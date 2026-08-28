import { defineComponent } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_ROUTE_NAMES,
  appViewFromRouteName,
  createAppRouter,
  runCenterRouteLocation,
  taskRouteLocation
} from './index'

const routePage = defineComponent({ name: 'TestRoutePage', render: () => null })
const routeComponents = { task: routePage, runCenter: routePage }

const navigate = async (path: string) => {
  const router = createAppRouter(createMemoryHistory(), routeComponents)
  await router.push(path)
  await router.isReady()
  return router
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('app routes', () => {
  it('redirects the root and unknown paths to the task entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rootRouter = await navigate('/')
    expect(rootRouter.currentRoute.value.name).toBe(APP_ROUTE_NAMES.task)
    expect(rootRouter.currentRoute.value.fullPath).toBe('/tasks')

    const unknownRouter = await navigate('/future/missing-page')
    expect(unknownRouter.currentRoute.value.name).toBe(APP_ROUTE_NAMES.task)
    expect(unknownRouter.currentRoute.value.fullPath).toBe('/tasks')
    expect(warn).not.toHaveBeenCalled()
  })

  it('matches task and run-center context parameters', async () => {
    const taskRouter = await navigate('/tasks/task-42')
    expect(taskRouter.currentRoute.value.name).toBe(APP_ROUTE_NAMES.task)
    expect(taskRouter.currentRoute.value.params.taskId).toBe('task-42')

    const runRouter = await navigate('/run-center/task-7')
    expect(runRouter.currentRoute.value.name).toBe(APP_ROUTE_NAMES.runCenter)
    expect(runRouter.currentRoute.value.params.taskId).toBe('task-7')
  })

  it('builds named locations without empty params and derives the page view', () => {
    expect(taskRouteLocation()).toEqual({ name: APP_ROUTE_NAMES.task })
    expect(taskRouteLocation('task-1')).toEqual({
      name: APP_ROUTE_NAMES.task,
      params: { taskId: 'task-1' }
    })
    expect(runCenterRouteLocation()).toEqual({ name: APP_ROUTE_NAMES.runCenter })
    expect(appViewFromRouteName(APP_ROUTE_NAMES.runCenter)).toBe('run-center')
    expect(appViewFromRouteName(null)).toBe('task')
  })

  it('restores task and run-center context through back and forward navigation', async () => {
    const router = await navigate('/tasks/task-1')
    await router.push('/run-center/task-2')

    router.back()
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe('/tasks/task-1')
    })

    router.forward()
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe('/run-center/task-2')
    })
  })
})
