import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, DEFAULT_SETTINGS } from '@shared/defaults'
import type { TaskConfig } from '@shared/types'
import { useTaskForm } from './useTaskForm'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useTaskForm task loading', () => {
  it('does not overwrite a new unsaved task when an older load finishes later', async () => {
    const pendingLoad = deferred<TaskConfig | null>()
    const openTask = vi.fn(async () => {})
    vi.stubGlobal('window', {
      collector: {
        loadTask: vi.fn(() => pendingLoad.promise)
      }
    })

    const store = useTaskForm({
      showError: vi.fn(),
      showNotice: vi.fn(),
      showWarning: vi.fn(),
      formatConfigurationIssues: (_intro, issues) => issues.join('\n'),
      settings: ref({ ...DEFAULT_SETTINGS }),
      refreshTasks: vi.fn(async () => {}),
      isActiveTaskLocked: () => false,
      navigation: {
        openTask,
        selectRunTask: vi.fn(),
        setPreviewUrl: vi.fn(),
        getPreviewVisible: () => false,
        navigatePreview: vi.fn(async () => true),
        schedulePreviewBounds: vi.fn(),
        resetDetailSamples: vi.fn()
      }
    })

    const savedTask = createTask('saved-task')
    const loading = store.loadTask(savedTask.id)
    expect(store.busy.value).toBe(true)

    store.createNewTask()
    const draftId = store.activeTask.value?.id
    expect(draftId).toBeTruthy()
    expect(store.busy.value).toBe(false)

    pendingLoad.resolve(savedTask)
    await loading

    expect(store.activeTask.value?.id).toBe(draftId)
    expect(openTask).toHaveBeenCalledWith(draftId)
  })
})
