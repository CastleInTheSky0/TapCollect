import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFieldMapping, createTask, DEFAULT_SETTINGS } from '@shared/defaults'
import type { TaskConfig, XmlFieldDefinition } from '@shared/types'
import { useTaskForm } from './useTaskForm'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const detailMappingConflictTask = (): TaskConfig => {
  const task = createTask('detail-mapping-conflict')
  const field: XmlFieldDefinition = {
    path: 'content',
    name: 'content',
    kind: 'element',
    cdata: true,
    sampleValue: ''
  }
  const mapping = createFieldMapping(field)
  mapping.mode = 'page'
  mapping.pageSource = 'detail'
  mapping.selector = '#content'
  task.detail.enabled = false
  task.dedupeFieldPath = field.path
  task.xml = {
    fileName: 'sample.xml',
    content: '<root><item><content/></item></root>',
    encoding: 'UTF-8',
    recordPath: '/root/item',
    fields: [field],
    mappings: [mapping],
    importedAt: '2026-08-28T00:00:00.000Z'
  }
  return task
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

describe('useTaskForm draft saving', () => {
  it('blocks a disabled-detail mapping conflict before IPC even for a silent save', async () => {
    const saveTask = vi.fn()
    const showWarning = vi.fn()
    vi.stubGlobal('window', {
      collector: { saveTask }
    })

    const store = useTaskForm({
      showError: vi.fn(),
      showNotice: vi.fn(),
      showWarning,
      formatConfigurationIssues: (intro, issues) => `${intro}：${issues.join('；')}`,
      settings: ref({ ...DEFAULT_SETTINGS }),
      refreshTasks: vi.fn(async () => {}),
      isActiveTaskLocked: () => false,
      navigation: {
        openTask: vi.fn(async () => {}),
        selectRunTask: vi.fn(),
        setPreviewUrl: vi.fn(),
        getPreviewVisible: () => false,
        navigatePreview: vi.fn(async () => true),
        schedulePreviewBounds: vi.fn(),
        resetDetailSamples: vi.fn()
      }
    })
    store.activeTask.value = detailMappingConflictTask()

    await expect(store.saveCurrent(true)).resolves.toBeNull()

    expect(saveTask).not.toHaveBeenCalled()
    expect(showWarning).toHaveBeenCalledOnce()
    expect(showWarning.mock.calls[0]?.[0]).toContain('页面来源不能选择“详情页”：content')
    expect(store.saving.value).toBe(false)
  })
})
