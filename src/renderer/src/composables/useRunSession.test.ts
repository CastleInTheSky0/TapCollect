// @vitest-environment jsdom

import { createApp, defineComponent, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFieldMapping, createTask, DEFAULT_SETTINGS } from '@shared/defaults'
import type { TaskConfig, XmlFieldDefinition } from '@shared/types'
import { useRunSession } from './useRunSession'

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

describe('useRunSession formal run validation', () => {
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

    let store!: ReturnType<typeof useRunSession>
    const app = createApp(
      defineComponent({
        setup() {
          store = useRunSession({
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
            closePreview: vi.fn(async () => {}),
            getPreviewVisible: () => false,
            getActiveTask: () => task,
            getHasUnsavedChanges: () => true,
            getConfigurationIssues: () => ['当前配置尚未保存']
          })
          return () => null
        }
      })
    )
    const container = document.createElement('div')
    app.mount(container)

    await store.requestRun()

    expect(showWarning).toHaveBeenCalledOnce()
    expect(showWarning.mock.calls[0]?.[0]).toContain('页面来源不能选择“详情页”：content')
    expect(showWarning.mock.calls[0]?.[0]).not.toContain('请先点击“保存草稿”')
    expect(getCheckpoint).not.toHaveBeenCalled()
    app.unmount()
  })
})
