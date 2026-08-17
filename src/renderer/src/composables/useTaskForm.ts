import { computed, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import type {
  AppSettings,
  OutputFieldDefinition,
  PaginationParameter,
  TaskConfig,
  TestCollectionResult,
  XmlTreeNode
} from '@shared/types'
import { createTask, taskConfigurationIssues } from '@shared/defaults'
import { analyzeTaskListPageRules, firstTaskListPageUrl } from '@shared/list-page-rules'
import { isFieldMappingConfigured } from '@shared/field-mapping'
import { taskOutputTemplate } from '@shared/output-template'
import { snapshotTaskForIpc, taskDraftFingerprint } from '../task-ipc'
import type { AppView } from './useAppView'

export const steps = ['基本信息', '列表与分页', '详情页', '模板映射', '输出与测试']

export const resourceKindLabels = {
  image: '图片',
  audio: '音频',
  video: '视频',
  attachment: '附件',
  other: '其他资源'
} as const

export interface TaskFormNavigation {
  setAppView: (view: AppView) => void
  selectRunTask: (id: string) => void
  setPreviewUrl: (url: string) => void
  getPreviewVisible: () => boolean
  navigatePreview: (url: string) => Promise<boolean>
  schedulePreviewBounds: () => void
  resetDetailSamples: () => void
}

export interface TaskFormDeps {
  showError: (error: unknown) => void
  showNotice: (message: string) => void
  showWarning: (message: string) => void
  formatConfigurationIssues: (intro: string, issues: string[]) => string
  settings: Ref<AppSettings>
  refreshTasks: () => Promise<void>
  isActiveTaskLocked: () => boolean
  navigation: TaskFormNavigation
}

export const useTaskForm = (deps: TaskFormDeps) => {
  const api = window.collector
  const activeTask = ref<TaskConfig | null>(null)
  const savedTaskFingerprint = ref<string | null>(null)
  const currentStep = ref(1)
  const busy = ref(false)
  const saving = ref(false)
  const xmlTree = ref<XmlTreeNode[]>([])
  const paginationSuggestions = ref<PaginationParameter[]>([])
  const paginationDetectionLineIndex = ref(-1)
  const testResult = ref<TestCollectionResult | null>(null)
  const testing = ref(false)

  const activeId = computed(() => activeTask.value?.id ?? '')
  const configurationIssues = computed(() =>
    activeTask.value ? taskConfigurationIssues(activeTask.value) : []
  )
  const runnable = computed(() => Boolean(activeTask.value && configurationIssues.value.length === 0))
  const hasUnsavedChanges = computed(() => {
    if (!activeTask.value) return false
    return (
      savedTaskFingerprint.value === null ||
      taskDraftFingerprint(activeTask.value) !== savedTaskFingerprint.value
    )
  })

  const synchronizeListPageMetadata = (task: TaskConfig): void => {
    const analysis = analyzeTaskListPageRules(task)
    task.listUrl = analysis.firstUrl
    task.pagination.urlTemplate = analysis.templateRule?.template ?? ''
  }

  const listPageRulesText = computed({
    get: () => activeTask.value?.listPageRules.join('\n') ?? '',
    set: (value: string) => {
      if (!activeTask.value) return
      activeTask.value.listPageRules = value.split(/\r?\n/)
      synchronizeListPageMetadata(activeTask.value)
      paginationSuggestions.value = []
      paginationDetectionLineIndex.value = -1
    }
  })

  const listPageRuleAnalysis = computed(() =>
    activeTask.value ? analyzeTaskListPageRules(activeTask.value) : null
  )
  const isClickPagination = computed(() => activeTask.value?.pagination.mode === 'click')
  const isClickDetail = computed(() => activeTask.value?.detail.navigationMode === 'click')
  const hasPaginationTemplate = computed(() => Boolean(listPageRuleAnalysis.value?.templateRule))
  const fixedListPageCount = computed(
    () => listPageRuleAnalysis.value?.rules.filter((rule) => rule.kind === 'fixed').length ?? 0
  )

  const activeOutputTemplate = computed(() =>
    activeTask.value ? taskOutputTemplate(activeTask.value) : null
  )
  const unresolvedMappings = computed(
    () =>
      activeOutputTemplate.value?.mappings.filter(
        (mapping) => !isFieldMappingConfigured(mapping)
      ).length ?? 0
  )

  const testMatchSummaries = computed(() =>
    Object.entries(testResult.value?.matchCounts ?? {}).map(([path, counts]) => ({
      path,
      counts: counts.join(' / ')
    }))
  )
  const testTableData = computed(() =>
    (testResult.value?.rows ?? []).map((row, index) => ({
      __rowKey: index,
      __index: index + 1,
      ...row
    }))
  )
  const outputFieldLabel = (field: OutputFieldDefinition): string =>
    'column' in field ? `${field.name}（${String(field.column)} 列）` : field.path
  const testTableColumns = computed(() => [
    { colKey: '__index', title: '#', width: 54, fixed: 'left' as const },
    ...(activeOutputTemplate.value?.fields ?? []).map((field) => ({
      colKey: field.path,
      title: outputFieldLabel(field),
      width: 210,
      ellipsis: true
    }))
  ])
  const testResourceTableData = computed(() =>
    (testResult.value?.resourcePlans ?? []).map((plan, index) => ({
      __rowKey: `${plan.normalizedUrl}-${index}`,
      __index: index + 1,
      kind: resourceKindLabels[plan.kind],
      sourceUrl: plan.sourceUrl,
      localPath: plan.localPath,
      xmlUrl: plan.xmlUrl
    }))
  )
  const testResourceTableColumns = [
    { colKey: '__index', title: '#', width: 54, fixed: 'left' as const },
    { colKey: 'kind', title: '类型', width: 82 },
    { colKey: 'sourceUrl', title: '原始地址', width: 280, ellipsis: true },
    { colKey: 'localPath', title: '本地目标', width: 280, ellipsis: true },
    { colKey: 'xmlUrl', title: '写入地址', width: 240, ellipsis: true }
  ]

  const listHostname = computed(() => {
    return listPageRuleAnalysis.value?.hostname || 'URL 尚未有效'
  })
  const flatXmlTree = computed(() => {
    const result: Array<{ node: XmlTreeNode; depth: number }> = []
    const visit = (nodes: XmlTreeNode[], depth: number): void => {
      for (const node of nodes) {
        result.push({ node, depth })
        visit(node.children, depth + 1)
      }
    }
    visit(xmlTree.value, 0)
    return result
  })

  const selectStep = (value: string | number): void => {
    const next = Number(value)
    if (Number.isInteger(next) && next >= 1 && next <= steps.length) currentStep.value = next
  }

  const loadTask = async (id: string): Promise<void> => {
    deps.navigation.setAppView('task')
    deps.navigation.selectRunTask(id)
    if (id === activeTask.value?.id) {
      void nextTick(deps.navigation.schedulePreviewBounds)
      return
    }
    busy.value = true
    try {
      const task = await api.loadTask(id)
      if (!task) throw new Error('找不到任务配置')
      activeTask.value = task
      savedTaskFingerprint.value = taskDraftFingerprint(task)
      const previewUrl = firstTaskListPageUrl(task)
      deps.navigation.setPreviewUrl(previewUrl)
      paginationSuggestions.value = []
      deps.navigation.resetDetailSamples()
      testResult.value = null
      currentStep.value = 1
      xmlTree.value = task.xml ? await api.inspectXmlTemplate(task.xml.content) : []
      if (deps.navigation.getPreviewVisible() && previewUrl) {
        await deps.navigation.navigatePreview(previewUrl)
      }
      void nextTick(deps.navigation.schedulePreviewBounds)
    } catch (error) {
      deps.showError(error)
    } finally {
      busy.value = false
    }
  }

  const createNewTask = (): void => {
    const task = createTask(crypto.randomUUID())
    task.output.rootDirectory = deps.settings.value.defaultOutputDirectory
    activeTask.value = task
    deps.navigation.setAppView('task')
    deps.navigation.selectRunTask(task.id)
    savedTaskFingerprint.value = null
    currentStep.value = 1
    xmlTree.value = []
    paginationSuggestions.value = []
    deps.navigation.resetDetailSamples()
    testResult.value = null
    deps.navigation.setPreviewUrl('')
    paginationDetectionLineIndex.value = -1
    void nextTick(deps.navigation.schedulePreviewBounds)
  }

  const clearActiveTask = (id: string): void => {
    if (activeTask.value?.id === id) {
      activeTask.value = null
      savedTaskFingerprint.value = null
    }
  }

  const saveCurrent = async (silent = false): Promise<TaskConfig | null> => {
    if (!activeTask.value) return null
    if (deps.isActiveTaskLocked()) {
      if (!silent) deps.showWarning('当前任务正在运行、暂停、排队或测试，暂时不能保存配置')
      return null
    }
    saving.value = true
    try {
      synchronizeListPageMetadata(activeTask.value)
      if (!activeTask.value.output.rootDirectory && deps.settings.value.defaultOutputDirectory) {
        activeTask.value.output.rootDirectory = deps.settings.value.defaultOutputDirectory
      }
      const saved = await api.saveTask(snapshotTaskForIpc(activeTask.value))
      activeTask.value = saved
      savedTaskFingerprint.value = taskDraftFingerprint(saved)
      await deps.refreshTasks()
      if (!silent) {
        const issues = taskConfigurationIssues(saved)
        if (issues.length > 0) {
          deps.showWarning(deps.formatConfigurationIssues('草稿已保存，但还有配置未完成', issues))
        } else {
          deps.showNotice('任务已保存')
        }
      }
      return saved
    } catch (error) {
      deps.showError(error)
      return null
    } finally {
      saving.value = false
    }
  }

  const detectPagination = async (): Promise<void> => {
    if (!activeTask.value) return
    const lineIndex = activeTask.value.listPageRules.findIndex((line) => {
      const value = line.trim()
      return Boolean(value) && !value.includes('{page}')
    })
    const source = lineIndex >= 0 ? activeTask.value.listPageRules[lineIndex]!.trim() : ''
    if (!source) {
      deps.showNotice('请先填写一条不含 {page} 的列表 URL，再扫描其中的数值参数')
      return
    }
    try {
      paginationDetectionLineIndex.value = lineIndex
      paginationSuggestions.value = await api.detectPaginationParameters(source)
      if (!paginationSuggestions.value.length) {
        deps.showNotice('URL 中没有检测到整数查询参数，可手动填写模板')
      }
    } catch (error) {
      deps.showError(error)
    }
  }

  const applyPaginationSuggestion = (suggestion: PaginationParameter): void => {
    if (!activeTask.value) return
    const lineIndex = paginationDetectionLineIndex.value
    if (lineIndex < 0 || lineIndex >= activeTask.value.listPageRules.length) return
    activeTask.value.listPageRules.splice(lineIndex, 1, suggestion.template)
    activeTask.value.pagination.startPage = Number(suggestion.value)
    activeTask.value.pagination.step = 1
    synchronizeListPageMetadata(activeTask.value)
    paginationSuggestions.value = []
  }

  const changePaginationMode = (): void => {
    if (!activeTask.value) return
    synchronizeListPageMetadata(activeTask.value)
    paginationSuggestions.value = []
    paginationDetectionLineIndex.value = -1
  }

  const importXml = async (): Promise<void> => {
    if (!activeTask.value) return
    try {
      const result = await api.importXmlTemplate()
      if (result.cancelled || !result.template) return
      activeTask.value.xml = result.template
      xmlTree.value = result.tree
      testResult.value = null
      deps.showNotice('模板已导入，请在 XML 树中选择单条记录节点')
    } catch (error) {
      deps.showError(error)
    }
  }

  const importSpreadsheet = async (): Promise<void> => {
    if (!activeTask.value) return
    try {
      const result = await api.importSpreadsheetTemplate()
      if (result.cancelled || !result.template) return
      activeTask.value.spreadsheet = result.template
      activeTask.value.output.format = 'spreadsheet'
      testResult.value = null
      deps.showNotice(`表格模板已导入，共识别 ${result.template.fields.length} 列`)
    } catch (error) {
      deps.showError(error)
    }
  }

  const changeOutputFormat = (): void => {
    testResult.value = null
  }

  const selectRecordNode = async (node: XmlTreeNode): Promise<void> => {
    if (!activeTask.value?.xml || node.kind !== 'element') return
    try {
      activeTask.value.xml = await api.selectXmlRecord(
        activeTask.value.xml.content,
        activeTask.value.xml.fileName,
        node.path
      )
      deps.showNotice(`记录节点已设为 ${node.path}`)
    } catch (error) {
      deps.showError(error)
    }
  }

  const addResourceReplacement = (): void => {
    activeTask.value?.resourceReplacements.push({ id: crypto.randomUUID(), from: '', to: '' })
  }

  const addHeader = (): void => {
    activeTask.value?.request.headers.push({ id: crypto.randomUUID(), key: '', value: '' })
  }

  const setCustomAttributes = (value: string | number): void => {
    if (!activeTask.value) return
    activeTask.value.html.customResourceAttributes = String(value)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  const chooseOutputDirectory = async (): Promise<void> => {
    if (!activeTask.value) return
    const path = await api.chooseOutputDirectory()
    if (path) activeTask.value.output.rootDirectory = path
  }

  const chooseResourceDirectory = async (): Promise<void> => {
    if (!activeTask.value) return
    const path = await api.chooseResourceDirectory()
    if (path) activeTask.value.resources.download.rootDirectory = path
  }

  const runTest = async (): Promise<void> => {
    if (!activeTask.value || testing.value) return
    if (deps.isActiveTaskLocked()) {
      deps.showWarning('当前任务正在运行、暂停、排队或测试，不能执行测试采集')
      return
    }
    testing.value = true
    testResult.value = null
    try {
      const saved = await saveCurrent(true)
      if (!saved) return
      testResult.value = await api.testTask(saved)
      deps.showNotice('测试采集完成')
    } catch (error) {
      deps.showError(error)
    } finally {
      testing.value = false
    }
  }

  return {
    activeTask,
    savedTaskFingerprint,
    currentStep,
    busy,
    saving,
    xmlTree,
    paginationSuggestions,
    paginationDetectionLineIndex,
    testResult,
    testing,
    activeId,
    configurationIssues,
    runnable,
    hasUnsavedChanges,
    listPageRulesText,
    listPageRuleAnalysis,
    isClickPagination,
    isClickDetail,
    hasPaginationTemplate,
    fixedListPageCount,
    activeOutputTemplate,
    unresolvedMappings,
    testMatchSummaries,
    testTableData,
    testTableColumns,
    testResourceTableData,
    testResourceTableColumns,
    listHostname,
    flatXmlTree,
    outputFieldLabel,
    selectStep,
    synchronizeListPageMetadata,
    loadTask,
    createNewTask,
    clearActiveTask,
    saveCurrent,
    detectPagination,
    applyPaginationSuggestion,
    changePaginationMode,
    importXml,
    importSpreadsheet,
    changeOutputFormat,
    selectRecordNode,
    addResourceReplacement,
    addHeader,
    setCustomAttributes,
    chooseOutputDirectory,
    chooseResourceDirectory,
    runTest
  }
}
