// @vitest-environment jsdom

import { createApp, defineComponent, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFieldMapping, createTask, DEFAULT_SETTINGS } from '@shared/defaults'
import type { TaskConfig, XmlFieldDefinition } from '@shared/types'
import { useRunSession } from './useRunSession'
import type { RunSessionDeps } from './useRunSession'

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
  vi.restoreAllMocks()
})

const mountRunSession = (deps: RunSessionDeps) => {
  let store!: ReturnType<typeof useRunSession>
  const app = createApp(
    defineComponent({
      setup() {
        store = useRunSession(deps)
        return () => null
      }
    })
  )
  const container = document.createElement('div')
  app.mount(container)
  return { app, store }
}

describe('useRunSession formal runs', () => {
  it('reports the detail-page mapping conflict before an unsaved-draft reminder', async () => {
    const task = detailMappingConflictTask()
    const getCheckpoint = vi.fn()
    const showWarning = vi.fn()
    const removeListener = vi.fn()
    Object.defineProperty(window, 'collector', {
      configurable: true,
      value: {
        getCheckpoint,
        onRunProgress: vi.fn(() => removeListener),
        onRunLog: vi.fn(() => removeListener),
        onRunFinished: vi.fn(() => removeListener),
        onRunSession: vi.fn(() => removeListener)
      }
    })

    const { app, store } = mountRunSession({
      showError: vi.fn(),
      showNotice: vi.fn(),
      showWarning,
      formatConfigurationIssues: (intro, issues) => `${intro}：${issues.join('；')}`,
      settings: ref({ ...DEFAULT_SETTINGS }),
      appView: ref('task'),
      openRunCenter: vi.fn(async () => {}),
      getActiveId: () => task.id,
      refreshTasks: vi.fn(async () => {}),
      loadTask: vi.fn(async () => {}),
      getActiveTask: () => task,
      getHasUnsavedChanges: () => true,
      getConfigurationIssues: () => ['当前配置尚未保存']
    })

    await store.requestRun()

    expect(showWarning).toHaveBeenCalledOnce()
    expect(showWarning.mock.calls[0]?.[0]).toContain('页面来源不能选择“详情页”：content')
    expect(showWarning.mock.calls[0]?.[0]).not.toContain('请先点击“保存草稿”')
    expect(getCheckpoint).not.toHaveBeenCalled()
    app.unmount()
  })

  it('starts formal collection without closing an open preview', async () => {
    const task = createTask('keep-preview-open')
    const startRun = vi.fn(async () => ({
      accepted: true,
      taskId: task.id,
      runId: 'run-1',
      status: 'preparing' as const,
      queuePosition: 0,
      message: '任务已开始采集'
    }))
    const getRunSession = vi.fn(async () => ({
      maxConcurrentRuns: 3,
      activeCount: 1,
      queuedCount: 0,
      testingTaskId: '',
      items: []
    }))
    const previewClose = vi.fn(async () => true)
    const removeListener = vi.fn()
    Object.defineProperty(window, 'collector', {
      configurable: true,
      value: {
        startRun,
        getRunSession,
        previewClose,
        onRunProgress: vi.fn(() => removeListener),
        onRunLog: vi.fn(() => removeListener),
        onRunFinished: vi.fn(() => removeListener),
        onRunSession: vi.fn(() => removeListener)
      }
    })

    const legacyClosePreview = vi.fn(async () => {})
    const deps: RunSessionDeps & {
      closePreview: () => Promise<void>
      getPreviewVisible: () => boolean
    } = {
      showError: vi.fn(),
      showNotice: vi.fn(),
      showWarning: vi.fn(),
      formatConfigurationIssues: (intro, issues) => `${intro}：${issues.join('；')}`,
      settings: ref({ ...DEFAULT_SETTINGS }),
      appView: ref('task'),
      openRunCenter: vi.fn(async () => {}),
      getActiveId: () => task.id,
      refreshTasks: vi.fn(async () => {}),
      loadTask: vi.fn(async () => {}),
      getActiveTask: () => task,
      getHasUnsavedChanges: () => false,
      getConfigurationIssues: () => [],
      closePreview: legacyClosePreview,
      getPreviewVisible: () => true
    }
    const { app, store } = mountRunSession(deps)

    await store.launchRun(false)

    expect(startRun).toHaveBeenCalledWith(task.id, false)
    expect(legacyClosePreview).not.toHaveBeenCalled()
    expect(previewClose).not.toHaveBeenCalled()
    app.unmount()
  })
})
