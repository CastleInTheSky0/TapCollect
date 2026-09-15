import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFieldMapping, createTask, DEFAULT_SETTINGS } from '@shared/defaults'
import type {
  ExtractedRecord,
  TaskConfig,
  TestCollectionResult,
  XmlFieldDefinition
} from '@shared/types'
import { useTaskForm, type TaskFormDeps } from './useTaskForm'

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
  const dependencies = (): TaskFormDeps => ({
    showError: vi.fn(), showNotice: vi.fn(), showWarning: vi.fn(),
    formatConfigurationIssues: (intro, issues) => `${intro}：${issues.join('；')}`,
    settings: ref({ ...DEFAULT_SETTINGS }), refreshTasks: vi.fn(async () => {}), isActiveTaskLocked: () => false,
    navigation: { openTask: vi.fn(async () => {}), selectRunTask: vi.fn(), setPreviewUrl: vi.fn(),
      getPreviewVisible: () => false, navigatePreview: vi.fn(async () => true),
      schedulePreviewBounds: vi.fn(), resetDetailSamples: vi.fn() }
  })

  it('assigns ownership only on the first save and keeps grouping outside the task and fingerprint', async () => {
    const saveNewTask = vi.fn(async (task: TaskConfig) => ({ task: structuredClone(task), warning: '' }))
    const saveTask = vi.fn(async (task: TaskConfig) => structuredClone(task))
    vi.stubGlobal('window', { collector: { saveNewTask, saveTask } })
    const store = useTaskForm(dependencies())
    store.createNewTask('group-a', '分组任务')
    expect(store.newTaskGroupId.value).toBe('group-a')
    const saved = await store.saveCurrent(true)
    expect(saved).not.toBeNull()
    expect(saveNewTask).toHaveBeenCalledWith(expect.not.objectContaining({ groupId: expect.anything() }), 'group-a')
    expect(store.newTaskGroupId.value).toBeNull()
    expect(store.hasUnsavedChanges.value).toBe(false)
    await store.saveCurrent(true)
    expect(saveNewTask).toHaveBeenCalledOnce()
    expect(saveTask).toHaveBeenCalledOnce()
  })

  it('retains a successfully saved task and reports group failure even for silent saves', async () => {
    const warning = '任务已保存，但分组保存失败'
    vi.stubGlobal('window', { collector: { saveNewTask: async (task: TaskConfig) => ({ task: structuredClone(task), warning }) } })
    const deps = dependencies()
    const store = useTaskForm(deps)
    store.createNewTask('group-a', '保存任务')
    await store.saveCurrent(true)
    expect(store.activeTask.value?.name).toBe('保存任务')
    expect(store.hasUnsavedChanges.value).toBe(false)
    expect(store.newTaskGroupId.value).toBeNull()
    expect(deps.showWarning).toHaveBeenCalledExactlyOnceWith(warning)
    expect(deps.showNotice).not.toHaveBeenCalled()
  })

  it('does not replace a newer draft when an earlier group-aware save finishes later', async () => {
    const pending = deferred<{ task: TaskConfig; warning: string }>()
    vi.stubGlobal('window', { collector: { saveNewTask: () => pending.promise } })
    const store = useTaskForm(dependencies())
    store.createNewTask('group-a', '旧草稿')
    const oldTask = structuredClone(JSON.parse(JSON.stringify(store.activeTask.value)) as TaskConfig)
    const saving = store.saveCurrent(true)
    store.createNewTask('group-b', '新草稿')
    const newId = store.activeId.value
    pending.resolve({ task: oldTask, warning: '' })
    await saving
    expect(store.activeId.value).toBe(newId)
    expect(store.activeTask.value?.name).toBe('新草稿')
    expect(store.newTaskGroupId.value).toBe('group-b')
    expect(store.savedTaskFingerprint.value).toBeNull()
  })

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

describe('useTaskForm test file export', () => {
  it('exports plain tested snapshots and treats save-dialog cancellation silently', async () => {
    const task = createTask('test-file-task')
    task.name = '测试导出'
    const field: XmlFieldDefinition = {
      path: 'title',
      name: 'title',
      kind: 'element',
      cdata: false,
      sampleValue: ''
    }
    const mapping = createFieldMapping(field)
    mapping.mode = 'fixed'
    mapping.fixedValue = '测试标题'
    task.xml = {
      fileName: 'sample.xml',
      content: '<root><item><title/></item></root>',
      encoding: 'UTF-8',
      recordPath: '/root/item',
      fields: [field],
      mappings: [mapping],
      importedAt: '2026-09-04T00:00:00.000Z'
    }
    const record: ExtractedRecord = {
      sequence: 0,
      collectedAt: '2026-09-04T00:00:00.000Z',
      page: 1,
      itemIndex: 1,
      listUrl: 'https://example.com/list',
      detailUrl: '',
      externalUrl: '',
      values: {}
    }
    const testResult: TestCollectionResult = {
      records: [record],
      rows: [{ title: '测试标题' }],
      matchCounts: {},
      failures: [],
      listItemCount: 1,
      xmlPreview: '<root><item><title>测试标题</title></item></root>',
      resourcePlans: [],
      messages: ['测试生成 1 条记录']
    }
    const showNotice = vi.fn()
    const exportTestFile = vi.fn(
      async (_task: TaskConfig, _records: ExtractedRecord[]) => ({
        cancelled: false,
        filePath: 'D:/temp/测试导出_测试.xml'
      })
    )
    vi.stubGlobal('window', {
      collector: {
        saveTask: vi.fn(async (value: TaskConfig) => structuredClone(value)),
        saveNewTask: vi.fn(async (value: TaskConfig) => ({ task: structuredClone(value), warning: '' })),
        testTask: vi.fn(async () => testResult),
        exportTestFile
      }
    })
    const store = useTaskForm({
      showError: vi.fn(),
      showNotice,
      showWarning: vi.fn(),
      formatConfigurationIssues: (_intro, issues) => issues.join('\n'),
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
    store.activeTask.value = task

    await store.runTest()
    await store.exportTestFile()

    expect(exportTestFile).toHaveBeenCalledOnce()
    const [exportedTask, exportedRecords] = exportTestFile.mock.calls[0]!
    expect(() => structuredClone(exportedTask)).not.toThrow()
    expect(() => structuredClone(exportedRecords)).not.toThrow()
    expect(exportedTask).not.toBe(store.activeTask.value)
    expect(exportedRecords).toEqual([record])
    expect(showNotice).toHaveBeenNthCalledWith(1, '测试采集完成')
    expect(showNotice).toHaveBeenNthCalledWith(2, '测试文件已导出')

    showNotice.mockClear()
    exportTestFile.mockResolvedValueOnce({ cancelled: true, filePath: '' })
    await store.exportTestFile()

    expect(showNotice).not.toHaveBeenCalled()
    expect(store.exportingTestFile.value).toBe(false)
  })
})
