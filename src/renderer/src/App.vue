<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref
} from 'vue'
import {
  AddIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CursorIcon,
  DeleteIcon,
  FileCodeIcon,
  FolderOpenIcon,
  InternetIcon,
  LinkIcon,
  PlayIcon,
  RefreshIcon,
  SaveIcon,
  SearchIcon
} from 'tdesign-icons-vue-next'
import { createTask, isTaskRunnable } from '@shared/defaults'
import {
  analyzeTaskListPageRules,
  firstTaskListPageUrl
} from '@shared/list-page-rules'
import { isFieldMappingConfigured } from '@shared/field-mapping'
import type {
  AppSettings,
  FieldMapping,
  PageExtractionConfig,
  PaginationParameter,
  PreviewBounds,
  RunLog,
  RunProgress,
  RunResult,
  TaskConfig,
  TaskSummary,
  TestCollectionResult,
  XmlTreeNode
} from '@shared/types'
import FieldMappingEditor from './components/FieldMappingEditor.vue'
import TaskSidebar from './components/TaskSidebar.vue'
import {
  defaultPaneWidths,
  fitPaneWidths,
  resizePaneWidths,
  type PaneVisibility,
  type PaneWidths,
  type ResizablePane
} from './pane-layout'
import { snapshotTaskForIpc } from './task-ipc'

const api = window.collector
const steps = ['基本信息', '列表与分页', '详情页', 'XML 映射', '输出与测试']

const tasks = ref<TaskSummary[]>([])
const activeTask = ref<TaskConfig | null>(null)
const settings = ref<AppSettings>({ defaultOutputDirectory: '' })
const currentStep = ref(1)
const busy = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const noticeMessage = ref('')
const xmlTree = ref<XmlTreeNode[]>([])
const paginationSuggestions = ref<PaginationParameter[]>([])
const paginationDetectionLineIndex = ref(-1)
const detailSamples = ref<string[]>([])
const detailSampleIndex = ref(-1)
const testResult = ref<TestCollectionResult | null>(null)
const testing = ref(false)

const previewSurface = ref<HTMLElement | null>(null)
const previewUrl = ref('')
const previewVisible = ref(false)
const previewStatus = ref('尚未打开预览')
const pickingLabel = ref('')
const paneWidths = ref<PaneWidths>(defaultPaneWidths(window.innerWidth))
const sidebarCollapsed = ref(false)
const previewCollapsed = ref(false)
const resizingPane = ref<ResizablePane | null>(null)

const running = ref(false)
const runProgress = ref<RunProgress | null>(null)
const runLogs = ref<RunLog[]>([])
const runResult = ref<RunResult | null>(null)
const resumePrompt = ref(false)
const pendingDeleteTaskId = ref('')
const cancelPrompt = ref(false)

const activeId = computed(() => activeTask.value?.id ?? '')
const runnable = computed(() => Boolean(activeTask.value && isTaskRunnable(activeTask.value)))
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
const hasPaginationTemplate = computed(() => Boolean(listPageRuleAnalysis.value?.templateRule))
const fixedListPageCount = computed(
  () => listPageRuleAnalysis.value?.rules.filter((rule) => rule.kind === 'fixed').length ?? 0
)
const paneVisibility = computed<PaneVisibility>(() => ({
  sidebar: !sidebarCollapsed.value,
  preview: !previewCollapsed.value
}))
const appShellStyle = computed<Record<string, string>>(() => ({
  '--sidebar-width': `${sidebarCollapsed.value ? 0 : paneWidths.value.sidebar}px`,
  '--preview-width': `${previewCollapsed.value ? 0 : paneWidths.value.preview}px`
}))
const unresolvedMappings = computed(
  () =>
    activeTask.value?.xml?.mappings.filter((mapping) => !isFieldMappingConfigured(mapping)).length ??
    0
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
const testTableColumns = computed(() => [
  { colKey: '__index', title: '#', width: 54, fixed: 'left' as const },
  ...(activeTask.value?.xml?.fields ?? []).map((field) => ({
    colKey: field.path,
    title: field.path,
    width: 210,
    ellipsis: true
  }))
])
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

const messageFromError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const showError = (error: unknown): void => {
  errorMessage.value = messageFromError(error)
  noticeMessage.value = ''
}

const showNotice = (message: string): void => {
  noticeMessage.value = message
  errorMessage.value = ''
  window.setTimeout(() => {
    if (noticeMessage.value === message) noticeMessage.value = ''
  }, 2_600)
}

const selectStep = (value: string | number): void => {
  const next = Number(value)
  if (Number.isInteger(next) && next >= 1 && next <= steps.length) currentStep.value = next
}

const refreshTasks = async (): Promise<void> => {
  tasks.value = await api.listTasks()
}

const loadTask = async (id: string): Promise<void> => {
  if (running.value || id === activeTask.value?.id) return
  busy.value = true
  try {
    const task = await api.loadTask(id)
    if (!task) throw new Error('找不到任务配置')
    activeTask.value = task
    previewUrl.value = firstTaskListPageUrl(task)
    paginationSuggestions.value = []
    detailSamples.value = []
    detailSampleIndex.value = -1
    testResult.value = null
    currentStep.value = 1
    xmlTree.value = task.xml ? await api.inspectXmlTemplate(task.xml.content) : []
    if (previewVisible.value && previewUrl.value) await api.previewNavigate(previewUrl.value)
  } catch (error) {
    showError(error)
  } finally {
    busy.value = false
  }
}

const createNewTask = (): void => {
  if (running.value) return
  const task = createTask(crypto.randomUUID())
  task.output.rootDirectory = settings.value.defaultOutputDirectory
  activeTask.value = task
  currentStep.value = 1
  xmlTree.value = []
  paginationSuggestions.value = []
  detailSamples.value = []
  detailSampleIndex.value = -1
  testResult.value = null
  previewUrl.value = ''
  paginationDetectionLineIndex.value = -1
}

const saveCurrent = async (silent = false): Promise<TaskConfig | null> => {
  if (!activeTask.value) return null
  saving.value = true
  try {
    synchronizeListPageMetadata(activeTask.value)
    if (!activeTask.value.output.rootDirectory && settings.value.defaultOutputDirectory) {
      activeTask.value.output.rootDirectory = settings.value.defaultOutputDirectory
    }
    const saved = await api.saveTask(snapshotTaskForIpc(activeTask.value))
    activeTask.value = saved
    await refreshTasks()
    if (!silent) showNotice('任务已保存')
    return saved
  } catch (error) {
    showError(error)
    return null
  } finally {
    saving.value = false
  }
}

const duplicateTask = async (id: string): Promise<void> => {
  if (running.value) return
  try {
    const copy = await api.duplicateTask(id)
    await refreshTasks()
    await loadTask(copy.id)
    showNotice('已创建任务副本')
  } catch (error) {
    showError(error)
  }
}

const removeTask = (id: string): void => {
  if (running.value) return
  pendingDeleteTaskId.value = id
}

const confirmRemoveTask = async (): Promise<void> => {
  const id = pendingDeleteTaskId.value
  if (!id) return
  try {
    await api.deleteTask(id)
    if (activeTask.value?.id === id) activeTask.value = null
    await refreshTasks()
    pendingDeleteTaskId.value = ''
    showNotice('任务配置已删除')
  } catch (error) {
    showError(error)
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
    showNotice('请先填写一条不含 {page} 的列表 URL，再扫描其中的数值参数')
    return
  }
  try {
    paginationDetectionLineIndex.value = lineIndex
    paginationSuggestions.value = await api.detectPaginationParameters(source)
    if (!paginationSuggestions.value.length) showNotice('URL 中没有检测到整数查询参数，可手动填写模板')
  } catch (error) {
    showError(error)
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

const importXml = async (): Promise<void> => {
  if (!activeTask.value) return
  try {
    const result = await api.importXmlTemplate()
    if (result.cancelled || !result.template) return
    activeTask.value.xml = result.template
    xmlTree.value = result.tree
    testResult.value = null
    showNotice('模板已导入，请在 XML 树中选择单条记录节点')
  } catch (error) {
    showError(error)
  }
}

const selectRecordNode = async (node: XmlTreeNode): Promise<void> => {
  if (!activeTask.value?.xml || node.kind !== 'element') return
  try {
    activeTask.value.xml = await api.selectXmlRecord(
      activeTask.value.xml.content,
      activeTask.value.xml.fileName,
      node.path
    )
    showNotice(`记录节点已设为 ${node.path}`)
  } catch (error) {
    showError(error)
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

const saveDefaultOutputDirectory = async (): Promise<void> => {
  const path = activeTask.value?.output.rootDirectory.trim()
  if (!path) {
    showError(new Error('请先选择输出根目录'))
    return
  }
  try {
    settings.value = await api.saveSettings({ defaultOutputDirectory: path })
    showNotice('已设为新任务的全局默认输出目录')
  } catch (error) {
    showError(error)
  }
}

let previewBoundsFrame: number | null = null
let paneResizeStart: {
  pane: ResizablePane
  startX: number
  widths: PaneWidths
} | null = null

const fitCurrentPaneWidths = (): void => {
  const fitted = fitPaneWidths(paneWidths.value, window.innerWidth, paneVisibility.value)
  paneWidths.value = {
    sidebar: paneVisibility.value.sidebar ? fitted.sidebar : paneWidths.value.sidebar,
    preview: paneVisibility.value.preview ? fitted.preview : paneWidths.value.preview
  }
}

const previewBounds = (): PreviewBounds | null => {
  const element = previewSurface.value
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

const updatePreviewBounds = (): void => {
  if (!previewVisible.value) return
  if (previewCollapsed.value) {
    void api.previewSetBounds({ x: window.innerWidth + 2, y: 0, width: 1, height: 1 })
    return
  }
  const bounds = previewBounds()
  if (bounds) void api.previewSetBounds(bounds)
}

const schedulePreviewBoundsUpdate = (): void => {
  if (previewBoundsFrame !== null) return
  previewBoundsFrame = window.requestAnimationFrame(() => {
    previewBoundsFrame = null
    updatePreviewBounds()
  })
}

const toggleSidebarPane = (): void => {
  sidebarCollapsed.value = !sidebarCollapsed.value
  if (!sidebarCollapsed.value) fitCurrentPaneWidths()
  void nextTick(schedulePreviewBoundsUpdate)
}

const togglePreviewPane = (): void => {
  previewCollapsed.value = !previewCollapsed.value
  if (!previewCollapsed.value) fitCurrentPaneWidths()
  void nextTick(schedulePreviewBoundsUpdate)
}

const expandPreviewPane = async (): Promise<void> => {
  if (!previewCollapsed.value) return
  previewCollapsed.value = false
  fitCurrentPaneWidths()
  await nextTick()
  schedulePreviewBoundsUpdate()
}

const startPaneResize = (pane: ResizablePane, event: PointerEvent): void => {
  if ((pane === 'sidebar' && sidebarCollapsed.value) || (pane === 'preview' && previewCollapsed.value)) {
    return
  }
  event.preventDefault()
  paneResizeStart = {
    pane,
    startX: event.clientX,
    widths: { ...paneWidths.value }
  }
  resizingPane.value = pane
  document.body.classList.add('pane-resizing')
}

const handlePaneResize = (event: PointerEvent): void => {
  if (!paneResizeStart) return
  paneWidths.value = resizePaneWidths(
    paneResizeStart.pane,
    paneResizeStart.widths,
    event.clientX - paneResizeStart.startX,
    window.innerWidth,
    paneVisibility.value
  )
  schedulePreviewBoundsUpdate()
}

const stopPaneResize = (): void => {
  if (!paneResizeStart) return
  paneResizeStart = null
  resizingPane.value = null
  document.body.classList.remove('pane-resizing')
  schedulePreviewBoundsUpdate()
}

const resizePaneWithKeyboard = (
  pane: ResizablePane,
  event: KeyboardEvent
): void => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  if ((pane === 'sidebar' && sidebarCollapsed.value) || (pane === 'preview' && previewCollapsed.value)) {
    return
  }
  event.preventDefault()
  paneWidths.value = resizePaneWidths(
    pane,
    paneWidths.value,
    event.key === 'ArrowLeft' ? -24 : 24,
    window.innerWidth,
    paneVisibility.value
  )
  schedulePreviewBoundsUpdate()
}

const handleWindowResize = (): void => {
  fitCurrentPaneWidths()
  schedulePreviewBoundsUpdate()
}

const openPreview = async (): Promise<void> => {
  const value =
    previewUrl.value.trim() || (activeTask.value ? firstTaskListPageUrl(activeTask.value) : '')
  if (!value) {
    showError(new Error('请先填写要预览的网页地址'))
    return
  }
  try {
    await expandPreviewPane()
    previewVisible.value = true
    await nextTick()
    const bounds = previewBounds()
    if (!bounds) return
    await api.previewOpen(value, bounds)
    previewUrl.value = value
    previewStatus.value = '预览已加载，可点选或验证选择器'
  } catch (error) {
    previewVisible.value = false
    showError(error)
  }
}

const closePreview = async (): Promise<void> => {
  await api.previewClose()
  previewVisible.value = false
  previewStatus.value = '预览已关闭'
}

const ensurePreview = async (): Promise<boolean> => {
  if (!previewVisible.value) await openPreview()
  return previewVisible.value
}

const previewScopeForMapping = (mapping: PageExtractionConfig): string =>
  mapping.pageSource === 'list' ? activeTask.value?.listItem.selector || '' : ':root'

const ensureListItemSelector = (): boolean => {
  if (activeTask.value?.listItem.selector.trim()) return true
  showNotice('请先在第 2 步点选或填写列表项容器')
  return false
}

const pickBaseSelector = async (target: 'list-item' | 'detail-link'): Promise<void> => {
  if (!activeTask.value) return
  if (target === 'detail-link' && !ensureListItemSelector()) return
  if (!(await ensurePreview())) return
  pickingLabel.value = target === 'list-item' ? '正在点选列表项，按 Esc 取消' : '正在点选详情链接，按 Esc 取消'
  try {
    const result = await api.previewPick({
      selectorType: 'css',
      scopeSelector: target === 'detail-link' ? activeTask.value.listItem.selector : ''
    })
    if (result.cancelled) return
    if (target === 'list-item') {
      activeTask.value.listItem.selectorType = 'css'
      activeTask.value.listItem.selector = result.selector
    } else {
      activeTask.value.detail.link.selectorType = 'css'
      activeTask.value.detail.link.selector = result.selector
    }
    previewStatus.value =
      target === 'list-item' && result.matchCount <= 1
        ? `仅匹配 ${result.matchCount} 个元素，未识别到重复列表结构；请点选一整条记录或手动调整选择器`
        : `匹配 ${result.matchCount} 个元素${result.sample ? ` · ${result.sample}` : ''}`
  } catch (error) {
    showError(error)
  } finally {
    pickingLabel.value = ''
  }
}

const evaluateBaseSelector = async (target: 'list-item' | 'detail-link'): Promise<void> => {
  if (!activeTask.value) return
  if (target === 'detail-link' && !ensureListItemSelector()) return
  if (!(await ensurePreview())) return
  const config = target === 'list-item' ? activeTask.value.listItem : activeTask.value.detail.link
  const scope = target === 'detail-link' ? activeTask.value.listItem.selector : ''
  try {
    const result = await api.previewEvaluate({
      selectorType: config.selectorType,
      selector: config.selector,
      scopeSelector: scope
    })
    previewStatus.value = result.error
      ? `选择器错误：${result.error}`
      : `匹配 ${result.matchCount} 个元素${result.sample ? ` · ${result.sample}` : ''}`
  } catch (error) {
    showError(error)
  }
}

const openDetailSample = async (next: boolean): Promise<void> => {
  if (!activeTask.value) return
  try {
    if (!next || !detailSamples.value.length) {
      detailSamples.value = await api.getDetailSamples(snapshotTaskForIpc(activeTask.value))
      detailSampleIndex.value = -1
    }
    if (!detailSamples.value.length) {
      showNotice('当前列表页没有找到可访问的站内详情样例')
      return
    }
    detailSampleIndex.value = next
      ? (detailSampleIndex.value + 1) % detailSamples.value.length
      : 0
    previewUrl.value = detailSamples.value[detailSampleIndex.value] ?? detailSamples.value[0] ?? ''
    await openPreview()
    previewStatus.value = `详情样例 ${detailSampleIndex.value + 1} / ${detailSamples.value.length}`
  } catch (error) {
    showError(error)
  }
}

const mappingByPath = (path: string): FieldMapping | undefined =>
  activeTask.value?.xml?.mappings.find((mapping) => mapping.fieldPath === path)

const pageMappingByPath = (
  path: string,
  mergeValueId?: string
): PageExtractionConfig | undefined => {
  const mapping = mappingByPath(path)
  if (!mapping) return undefined
  if (!mergeValueId) return mapping.mode === 'page' ? mapping : undefined
  if (mapping.mode !== 'merge') return undefined
  const value = mapping.mergeValues.find((candidate) => candidate.id === mergeValueId)
  return value?.mode === 'page' ? value : undefined
}

const pickMapping = async (path: string, mergeValueId?: string): Promise<void> => {
  const pageMapping = pageMappingByPath(path, mergeValueId)
  if (!pageMapping || !activeTask.value) return
  if (pageMapping.pageSource === 'list' && !ensureListItemSelector()) return
  if (!(await ensurePreview())) return
  pickingLabel.value = `正在点选字段 ${path}${mergeValueId ? ' 的合并项' : ''}，按 Esc 取消`
  try {
    const result = await api.previewPick({
      selectorType: 'css',
      scopeSelector: previewScopeForMapping(pageMapping)
    })
    if (!result.cancelled) {
      pageMapping.selectorType = 'css'
      pageMapping.selector = result.selector
      previewStatus.value = `字段 ${path} 匹配 ${result.matchCount} 个元素`
    }
  } catch (error) {
    showError(error)
  } finally {
    pickingLabel.value = ''
  }
}

const evaluateMapping = async (path: string, mergeValueId?: string): Promise<void> => {
  const pageMapping = pageMappingByPath(path, mergeValueId)
  if (!pageMapping || !activeTask.value) return
  if (pageMapping.pageSource === 'list' && !ensureListItemSelector()) return
  if (!(await ensurePreview())) return
  try {
    const result = await api.previewEvaluate({
      selectorType: pageMapping.selectorType,
      selector: pageMapping.selector,
      scopeSelector: previewScopeForMapping(pageMapping)
    })
    previewStatus.value = result.error
      ? `字段 ${path}：${result.error}`
      : `字段 ${path} 匹配 ${result.matchCount} 个元素`
  } catch (error) {
    showError(error)
  }
}

const runTest = async (): Promise<void> => {
  if (!activeTask.value || testing.value) return
  testing.value = true
  testResult.value = null
  try {
    const saved = await saveCurrent(true)
    if (!saved) return
    testResult.value = await api.testTask(saved)
    showNotice('测试采集完成')
  } catch (error) {
    showError(error)
  } finally {
    testing.value = false
  }
}

const requestRun = async (id?: string): Promise<void> => {
  if (running.value) return
  if (id && id !== activeTask.value?.id) await loadTask(id)
  const saved = await saveCurrent(true)
  if (!saved) return
  if (!isTaskRunnable(saved)) {
    showError(new Error('任务尚未配置完整，请处理所有 XML 字段并检查必填设置'))
    return
  }
  const checkpoint = await api.getCheckpoint(saved.id)
  if (checkpoint) resumePrompt.value = true
  else await launchRun(false)
}

const launchRun = async (resume: boolean): Promise<void> => {
  if (!activeTask.value) return
  resumePrompt.value = false
  await closePreview()
  runLogs.value = []
  runResult.value = null
  runProgress.value = null
  running.value = true
  void api
    .startRun(activeTask.value.id, resume)
    .then((result) => {
      runResult.value = result
    })
    .catch(showError)
    .finally(async () => {
      running.value = false
      await refreshTasks()
    })
}

const pauseRun = async (): Promise<void> => {
  if (runProgress.value) await api.pauseRun(runProgress.value.runId)
}

const resumeRun = async (): Promise<void> => {
  if (runProgress.value) await api.resumeRun(runProgress.value.runId)
}

const cancelRun = (): void => {
  if (!runProgress.value) return
  cancelPrompt.value = true
}

const confirmCancelRun = async (): Promise<void> => {
  if (!runProgress.value) return
  await api.cancelRun(runProgress.value.runId)
  cancelPrompt.value = false
}

const openOutput = async (): Promise<void> => {
  if (activeTask.value) await api.openOutputDirectory(activeTask.value.id)
}

const openErrorLog = async (): Promise<void> => {
  if (activeTask.value && runResult.value?.errorLogPath) {
    await api.openErrorLog(activeTask.value.id, runResult.value.errorLogPath)
  }
}

let resizeObserver: ResizeObserver | null = null
let removeProgressListener = (): void => undefined
let removeLogListener = (): void => undefined
let removeFinishedListener = (): void => undefined

onMounted(async () => {
  try {
    settings.value = await api.getSettings()
    await refreshTasks()
    if (tasks.value[0]) await loadTask(tasks.value[0].id)
  } catch (error) {
    showError(error)
  }
  fitCurrentPaneWidths()
  resizeObserver = new ResizeObserver(schedulePreviewBoundsUpdate)
  if (previewSurface.value) resizeObserver.observe(previewSurface.value)
  window.addEventListener('resize', handleWindowResize)
  window.addEventListener('pointermove', handlePaneResize)
  window.addEventListener('pointerup', stopPaneResize)
  window.addEventListener('pointercancel', stopPaneResize)
  removeProgressListener = api.onRunProgress((progress) => {
    runProgress.value = progress
  })
  removeLogListener = api.onRunLog((log) => {
    runLogs.value.push(log)
    if (runLogs.value.length > 500) runLogs.value.splice(0, runLogs.value.length - 500)
  })
  removeFinishedListener = api.onRunFinished((result) => {
    runResult.value = result
    running.value = false
  })
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (previewBoundsFrame !== null) window.cancelAnimationFrame(previewBoundsFrame)
  window.removeEventListener('resize', handleWindowResize)
  window.removeEventListener('pointermove', handlePaneResize)
  window.removeEventListener('pointerup', stopPaneResize)
  window.removeEventListener('pointercancel', stopPaneResize)
  document.body.classList.remove('pane-resizing')
  removeProgressListener()
  removeLogListener()
  removeFinishedListener()
  void api.previewClose()
})
</script>

<template>
  <main class="app-shell" :class="{
    'sidebar-collapsed': sidebarCollapsed,
    'preview-collapsed': previewCollapsed,
    'pane-is-resizing': resizingPane
  }" :style="appShellStyle">
    <TaskSidebar :aria-hidden="sidebarCollapsed" :inert="sidebarCollapsed" :tasks="tasks" :active-id="activeId"
      :disabled="busy || running" @select="loadTask" @create="createNewTask" @duplicate="duplicateTask"
      @remove="removeTask" @run="requestRun" />

    <div class="pane-divider sidebar-divider" role="separator" aria-label="调整任务栏宽度" aria-orientation="vertical"
      tabindex="0" @pointerdown="startPaneResize('sidebar', $event)"
      @keydown="resizePaneWithKeyboard('sidebar', $event)">
      <t-tooltip :content="sidebarCollapsed ? '展开任务栏' : '折叠任务栏'" placement="right">
        <t-button class="pane-toggle" theme="default" variant="outline" shape="square" size="small" @pointerdown.stop
          @click.stop="toggleSidebarPane">
          <ChevronRightIcon v-if="sidebarCollapsed" />
          <ChevronLeftIcon v-else />
        </t-button>
      </t-tooltip>
    </div>

    <section class="workspace">
      <header class="workspace-header">
        <div class="workspace-title">
          <span class="context-label">任务配置</span>
          <strong>{{ activeTask?.name || '尚未选择任务' }}</strong>
        </div>
        <div class="header-actions">
          <t-tag v-if="activeTask" :theme="runnable ? 'success' : 'warning'" variant="light">
            {{ runnable ? '配置完整' : '配置未完成' }}
          </t-tag>
          <t-button theme="default" variant="outline" :loading="saving" :disabled="!activeTask || running"
            @click="saveCurrent(false)">
            <template #icon>
              <SaveIcon />
            </template>
            保存草稿
          </t-button>
          <t-button theme="primary" :disabled="!runnable || running" @click="requestRun()">
            <template #icon>
              <PlayIcon />
            </template>
            运行任务
          </t-button>
        </div>
      </header>

      <div class="message-stack">
        <Transition name="toast">
          <t-alert v-if="errorMessage" theme="error" :message="errorMessage" close @close="errorMessage = ''" />
        </Transition>
        <Transition name="toast">
          <t-alert v-if="noticeMessage" theme="success" :message="noticeMessage" />
        </Transition>
      </div>

      <template v-if="activeTask">
        <t-steps :current="currentStep" class="wizard-nav" :readonly="false" separator="line" @change="selectStep">
          <t-step-item v-for="(label, index) in steps" :key="label" :value="index + 1" :title="label" />
        </t-steps>

        <div class="step-scroll">
          <Transition name="step" mode="out-in">
            <section :key="currentStep" class="step-content">
              <template v-if="currentStep === 1">
                <div class="step-heading">
                  <span>01 / 05</span>
                  <h1>定义采集入口</h1>
                  <p>任务名称决定输出目录；列表 URL 用于预览、站内判断和分页建议。</p>
                </div>
                <div class="form-grid">
                  <div class="field full">
                    <span>任务名称</span>
                    <t-input v-model="activeTask.name" :maxlength="120" placeholder="例如：图片新闻" />
                    <small>最终输出到“输出根目录 / {{ activeTask.name || '任务名称' }}”。</small>
                  </div>
                  <div class="field full">
                    <span>列表页面 URL（每行一条）</span>
                    <div class="inline-control list-url-control">
                      <t-textarea v-model="listPageRulesText" :autosize="{ minRows: 3, maxRows: 8 }"
                        :spell-check="false" placeholder="固定地址或包含 {page} 的模板，每行一条" />
                      <t-button theme="default" variant="outline"
                        @click="previewUrl = firstTaskListPageUrl(activeTask); openPreview()">
                        <template #icon>
                          <InternetIcon />
                        </template>
                        打开预览
                      </t-button>
                    </div>
                    <div class="list-rule-summary">
                      <t-tag variant="light">固定地址 {{ fixedListPageCount }} 条</t-tag>
                      <t-tag v-if="hasPaginationTemplate" theme="primary" variant="light">
                        分页模板 1 条
                      </t-tag>
                      <span v-if="listPageRuleAnalysis?.hostname">
                        hostname：{{ listPageRuleAnalysis.hostname }}
                      </span>
                    </div>
                    <t-alert v-if="listPageRuleAnalysis?.errors.length" theme="error"
                      :message="listPageRuleAnalysis.errors.join('；')" />
                    <small>
                      按行顺序采集；固定 URL 各请求一次，最多一行可包含 {page}。正式采集不执行页面 JavaScript。
                    </small>
                  </div>
                </div>
                <!-- <div class="scope-note">
                  <strong>首版边界</strong>
                  <span>公开静态页面 · 无登录/验证码 · 不下载图片与附件 · 单任务运行</span>
                </div> -->
              </template>

              <template v-else-if="currentStep === 2">
                <div class="step-heading">
                  <span>02 / 05</span>
                  <h1>列表结构与分页</h1>
                  <p>先选一条完整列表记录，再用相对选择器采集每条记录中的字段。</p>
                </div>
                <div class="section-line">
                  <div class="section-title"><strong>列表项容器</strong><span>重复出现的一整条记录</span></div>
                  <div class="selector-grid">
                    <t-select v-model="activeTask.listItem.selectorType">
                      <t-option value="css" label="CSS" />
                      <t-option value="xpath" label="XPath 1.0" />
                    </t-select>
                    <t-input v-model="activeTask.listItem.selector" class="code-input" :spell-check="false"
                      placeholder="例如 .ListItem" />
                    <t-button theme="default" variant="outline" @click="evaluateBaseSelector('list-item')">
                      <SearchIcon />
                    </t-button>
                    <t-button theme="primary" variant="outline" @click="pickBaseSelector('list-item')">
                      <CursorIcon />
                    </t-button>
                  </div>
                </div>
                <div class="section-line">
                  <div class="section-title">
                    <strong>数字页码规则</strong><span>支持路径、文件名或查询参数中的 {page}</span>
                  </div>
                  <t-button size="small" theme="default" variant="outline" @click="detectPagination">
                    <template #icon>
                      <SearchIcon />
                    </template>
                    扫描 URL 数值参数
                  </t-button>
                  <div v-if="paginationSuggestions.length" class="suggestion-list">
                    <t-button v-for="suggestion in paginationSuggestions" :key="suggestion.name" class="suggestion-item"
                      theme="default" variant="text" block @click="applyPaginationSuggestion(suggestion)">
                      <span class="suggestion-copy">
                        <strong>{{ suggestion.name }} = {{ suggestion.value }}</strong>
                        <code>{{ suggestion.template }}</code>
                      </span>
                      <ChevronRightIcon />
                    </t-button>
                  </div>
                  <div v-if="hasPaginationTemplate" class="pagination-template">
                    <span>当前分页模板</span>
                    <code>{{ listPageRuleAnalysis?.templateRule?.template }}</code>
                  </div>
                  <div v-if="hasPaginationTemplate" class="form-grid compact thirds">
                    <div class="field">
                      <span>起始值</span>
                      <t-input-number v-model="activeTask.pagination.startPage" theme="column" :step="1"
                        :decimal-places="0" @change="synchronizeListPageMetadata(activeTask)" />
                    </div>
                    <div class="field">
                      <span>变化步长</span>
                      <t-input-number v-model="activeTask.pagination.step" theme="column" :step="1"
                        :decimal-places="0" />
                      <small>正数递增，负数递减，不能为 0。</small>
                    </div>
                    <div class="field">
                      <span>模板最大采集页数</span>
                      <t-input-number v-model="activeTask.pagination.maxPages" theme="column" :min="1" :max="500"
                        :step="1" :decimal-places="0" />
                      <small>只限制模板生成页数，不限制固定 URL。</small>
                    </div>
                  </div>
                  <p v-else class="inline-note">
                    当前只配置了固定 URL，不需要填写起始值、步长和模板最大页数。
                  </p>
                  <p class="inline-note">
                    模板遇到无列表项、URL 重复、404/410 或整页记录重复时会结束，并继续后面的固定 URL。
                  </p>
                </div>
              </template>

              <template v-else-if="currentStep === 3">
                <div class="step-heading">
                  <span>03 / 05</span>
                  <h1>详情链接与详情字段</h1>
                  <p>站内链接会请求详情；不同完整 hostname 的链接保留为外链，不访问目标页面。</p>
                </div>
                <div class="switch-line">
                  <span><strong>启用详情页采集</strong><small>关闭后只采列表字段，并选择一个 XML 字段作为去重键。</small></span>
                  <t-switch v-model="activeTask.detail.enabled" />
                </div>
                <div v-if="activeTask.detail.enabled" class="section-line">
                  <div class="section-title"><strong>详情链接</strong><span>相对于列表项容器选择</span></div>
                  <div class="selector-grid link-grid">
                    <t-select v-model="activeTask.detail.link.selectorType">
                      <t-option value="css" label="CSS" />
                      <t-option value="xpath" label="XPath 1.0" />
                    </t-select>
                    <t-input v-model="activeTask.detail.link.selector" class="code-input" :spell-check="false"
                      placeholder="例如 a.title" />
                    <t-input v-model="activeTask.detail.linkAttribute" class="code-input" placeholder="href" />
                    <t-button theme="default" variant="outline" @click="evaluateBaseSelector('detail-link')">
                      <SearchIcon />
                    </t-button>
                    <t-button theme="primary" variant="outline" @click="pickBaseSelector('detail-link')">
                      <CursorIcon />
                    </t-button>
                  </div>
                  <div class="host-rule">
                    <LinkIcon />
                    <span>站内判断</span>
                    <strong>只比较完整 hostname</strong>
                    <t-tag theme="primary" variant="light">{{ listHostname }}</t-tag>
                  </div>
                  <div class="sample-actions">
                    <t-button size="small" theme="default" variant="outline" @click="openDetailSample(false)">
                      <template #icon>
                        <InternetIcon />
                      </template>
                      打开第一条有效详情
                    </t-button>
                    <t-button size="small" theme="default" variant="outline" :disabled="!detailSamples.length"
                      @click="openDetailSample(true)">
                      下一条样例
                      <template #suffix>
                        <ChevronRightIcon />
                      </template>
                    </t-button>
                    <span v-if="detailSamples.length">
                      {{ detailSampleIndex + 1 }} / {{ detailSamples.length }}
                    </span>
                  </div>
                </div>
                <div v-else class="section-line">
                  <div class="field">
                    <span>本次运行去重字段</span>
                    <t-select v-model="activeTask.dedupeFieldPath" placeholder="请选择 XML 字段">
                      <t-option v-for="field in activeTask.xml?.fields || []" :key="field.path" :value="field.path"
                        :label="field.path" />
                    </t-select>
                  </div>
                </div>
                <div class="scope-note">
                  <strong>外链记录仍会输出</strong>
                  <span>详情页字段为空；可把“外链 URL”来源映射到模板中的任意一个字段。</span>
                </div>
              </template>

              <template v-else-if="currentStep === 4">
                <div class="step-heading mapping-heading">
                  <span>04 / 05</span>
                  <h1>XML 模板与字段映射</h1>
                  <p>字段清单完全来自模板。工具不会根据字段名猜测 title、text 或日期含义。</p>
                </div>
                <div class="template-toolbar">
                  <div>
                    <strong>{{ activeTask.xml?.fileName || '尚未导入模板' }}</strong>
                    <span v-if="activeTask.xml?.recordPath">
                      记录节点 {{ activeTask.xml.recordPath }} · {{ activeTask.xml.encoding }}
                    </span>
                    <span v-else>导入完整合法 XML 后选择一条示例记录节点</span>
                  </div>
                  <t-button theme="default" variant="outline" @click="importXml">
                    <template #icon>
                      <FileCodeIcon />
                    </template>
                    {{ activeTask.xml ? '重新导入' : '导入 XML 模板' }}
                  </t-button>
                </div>

                <div v-if="activeTask.xml" class="xml-workbench">
                  <aside class="xml-tree">
                    <div class="pane-label">XML 树</div>
                    <t-button v-for="entry in flatXmlTree" :key="entry.node.path" theme="default" variant="text" block
                      :class="{ selected: activeTask.xml.recordPath === entry.node.path }"
                      :style="{ paddingLeft: `${10 + entry.depth * 14}px` }" @click="selectRecordNode(entry.node)">
                      <span>{{ entry.node.kind === 'attribute' ? '@' : '‹›' }}</span>
                      {{ entry.node.name }}
                    </t-button>
                  </aside>
                  <div class="mapping-pane">
                    <div class="mapping-pane-head">
                      <div><strong>字段处理</strong><span>每个字段必须明确选择一种处理方式</span></div>
                      <t-tag :theme="unresolvedMappings === 0 ? 'success' : 'warning'" variant="light">
                        {{ unresolvedMappings ? `${unresolvedMappings} 项待配置` : '全部已配置' }}
                      </t-tag>
                    </div>
                    <FieldMappingEditor v-if="activeTask.xml.recordPath" v-model="activeTask.xml" @pick="pickMapping"
                      @evaluate="evaluateMapping" />
                    <div v-else class="mapping-empty">请先从左侧 XML 树中选择单条记录节点。</div>
                  </div>
                </div>
                <div v-else class="large-empty">
                  <FileCodeIcon size="34px" />
                  <strong>导入你的 XML 模板</strong>
                  <p>模板固定节点、注释、命名空间和 CDATA 规则会保留。</p>
                  <t-button theme="primary" @click="importXml">
                    <template #icon>
                      <FolderOpenIcon />
                    </template>
                    选择 XML 文件
                  </t-button>
                </div>
              </template>

              <template v-else>
                <div class="step-heading">
                  <span>05 / 05</span>
                  <h1>输出、请求与测试</h1>
                  <p>最后确认路径替换、批次上限和网络参数，然后先执行一次小范围测试。</p>
                </div>

                <div class="section-line">
                  <div class="section-title"><strong>资源路径处理</strong><span>先绝对化，再按顺序做字面替换；不会下载资源</span></div>
                  <div class="check-row">
                    <t-checkbox v-model="activeTask.html.absolutizeResources">资源地址绝对化</t-checkbox>
                    <t-checkbox v-model="activeTask.html.cleanHtml">清理脚本、事件和 DocView 预览</t-checkbox>
                  </div>
                  <div class="field full">
                    <span>补充资源属性（逗号分隔）</span>
                    <t-input :value="activeTask.html.customResourceAttributes.join(', ')"
                      placeholder="例如 data-file, data-url" @change="setCustomAttributes" />
                  </div>
                  <div class="subheading">
                    <span>有序路径替换</span>
                    <t-button size="small" theme="default" variant="text" @click="addResourceReplacement">
                      <template #icon>
                        <AddIcon />
                      </template>
                      添加规则
                    </t-button>
                  </div>
                  <div v-for="rule in activeTask.resourceReplacements" :key="rule.id" class="replacement-line">
                    <t-input v-model="rule.from" placeholder="原字符串" />
                    <span>→</span>
                    <t-input v-model="rule.to" placeholder="新字符串" />
                    <t-tooltip content="删除替换规则" placement="top">
                      <t-button theme="danger" variant="text" shape="square"
                        @click="activeTask.resourceReplacements.splice(activeTask.resourceReplacements.indexOf(rule), 1)">
                        <DeleteIcon />
                      </t-button>
                    </t-tooltip>
                  </div>
                </div>

                <div class="section-line">
                  <div class="section-title"><strong>XML 输出</strong><span>采集结果会按设置的条数自动拆分成多个文件</span></div>
                  <div class="field full">
                    <span>输出根目录</span>
                    <div class="inline-control">
                      <t-input v-model="activeTask.output.rootDirectory" readonly placeholder="请选择目录" />
                      <t-button theme="default" variant="outline" @click="chooseOutputDirectory">
                        <template #icon>
                          <FolderOpenIcon />
                        </template>
                        选择目录
                      </t-button>
                      <t-button theme="default" variant="text" @click="saveDefaultOutputDirectory">
                        设为全局默认
                      </t-button>
                    </div>
                  </div>
                  <div class="form-grid compact">
                    <div class="field">
                      <span>每个 XML 文件最多保存多少条</span>
                      <t-input-number v-model="activeTask.output.recordsPerFile" theme="column" :min="1" :max="200"
                        :step="1" :decimal-places="0" />
                    </div>
                    <div class="switch-line compact-switch">
                      <span><strong>覆盖旧结果</strong><small>默认开启</small></span>
                      <t-switch v-model="activeTask.output.overwrite" />
                    </div>
                  </div>
                </div>

                <div class="section-line">
                  <div class="section-title"><strong>请求与并发</strong><span>列表页顺序请求，详情并发后仍按列表顺序输出</span></div>
                  <div class="form-grid thirds">
                    <div class="field">
                      <span>超时（秒）</span>
                      <t-input-number v-model="activeTask.request.timeoutSeconds" theme="column" :min="5" :max="120"
                        :step="1" :decimal-places="0" />
                    </div>
                    <div class="field">
                      <span>详情并发</span>
                      <t-input-number v-model="activeTask.request.detailConcurrency" theme="column" :min="1" :max="5"
                        :step="1" :decimal-places="0" />
                    </div>
                    <div class="field">
                      <span>请求延迟（毫秒）</span>
                      <t-input-number v-model="activeTask.request.delayMs" theme="column" :min="0" :step="100"
                        :decimal-places="0" />
                    </div>
                    <div class="field">
                      <span>编码覆盖</span>
                      <t-select v-model="activeTask.request.manualEncoding">
                        <t-option value="" label="自动识别" />
                        <t-option value="utf-8" label="UTF-8" />
                        <t-option value="gbk" label="GBK" />
                        <t-option value="gb2312" label="GB2312" />
                        <t-option value="gb18030" label="GB18030" />
                      </t-select>
                    </div>
                    <div class="field full">
                      <span>User-Agent</span>
                      <t-input v-model="activeTask.request.userAgent" />
                    </div>
                  </div>
                  <div class="subheading">
                    <span>自定义请求头</span>
                    <t-button size="small" theme="default" variant="text" @click="addHeader">
                      <template #icon>
                        <AddIcon />
                      </template>
                      添加
                    </t-button>
                  </div>
                  <div v-for="header in activeTask.request.headers" :key="header.id"
                    class="replacement-line header-line">
                    <t-input v-model="header.key" placeholder="Referer" />
                    <span>:</span>
                    <t-input v-model="header.value" placeholder="值" />
                    <t-tooltip content="删除请求头" placement="top">
                      <t-button theme="danger" variant="text" shape="square"
                        @click="activeTask.request.headers.splice(activeTask.request.headers.indexOf(header), 1)">
                        <DeleteIcon />
                      </t-button>
                    </t-tooltip>
                  </div>
                </div>

                <div class="test-actions">
                  <div><strong>测试采集</strong><span>读取当前列表页，并处理前 3 条记录。</span></div>
                  <t-button theme="default" variant="outline" :loading="testing" :disabled="!activeTask.xml"
                    @click="runTest">
                    <template #icon>
                      <RefreshIcon />
                    </template>
                    执行测试
                  </t-button>
                  <t-button theme="primary" :disabled="!runnable || running" @click="requestRun()">
                    <template #icon>
                      <PlayIcon />
                    </template>
                    开始正式采集
                  </t-button>
                </div>

                <div v-if="testResult" class="test-result">
                  <div class="test-summary">
                    <strong>测试结果</strong>
                    <t-tag v-for="message in testResult.messages" :key="message" theme="success" variant="light">
                      {{ message }}
                    </t-tag>
                  </div>
                  <div v-if="testMatchSummaries.length" class="match-counts">
                    <t-tag v-for="item in testMatchSummaries" :key="item.path" theme="default" variant="light">
                      <strong>{{ item.path }}</strong> 匹配 {{ item.counts }}
                    </t-tag>
                  </div>
                  <div v-if="testResult.rows.length" class="table-scroll">
                    <t-table :data="testTableData" :columns="testTableColumns" row-key="__rowKey" size="small"
                      table-layout="fixed" :bordered="true" :hover="true" :max-height="280" />
                  </div>
                  <t-collapse v-if="testResult.xmlPreview" class="result-collapse" borderless>
                    <t-collapse-panel value="xml-preview" header="XML 预览">
                      <pre>{{ testResult.xmlPreview }}</pre>
                    </t-collapse-panel>
                  </t-collapse>
                  <div v-if="testResult.failures.length" class="failure-list">
                    <strong>发现问题</strong>
                    <p v-for="(failure, index) in testResult.failures" :key="index">
                      第 {{ failure.itemIndex }} 条 · {{ failure.stage }}{{ failure.fieldPath ? ` / ${failure.fieldPath}`
                      : '' }} · {{
                      failure.reason }}
                    </p>
                  </div>
                </div>
              </template>
            </section>
          </Transition>
        </div>

        <footer class="wizard-footer">
          <t-button theme="default" variant="text" :disabled="currentStep === 1" @click="currentStep -= 1">
            <template #icon>
              <ChevronLeftIcon />
            </template>
            上一步
          </t-button>
          <span>第 {{ currentStep }} 步，共 5 步</span>
          <t-button
            class="wizard-next-button"
            theme="default"
            variant="outline"
            :disabled="currentStep === 5"
            @click="currentStep += 1"
          >
            下一步
            <ChevronRightIcon />
          </t-button>
        </footer>
      </template>

      <div v-else class="welcome-empty">
        <FileCodeIcon size="42px" />
        <span>网页 → XML</span>
        <h1>创建第一个采集任务</h1>
        <p>配置列表、可选详情、分页和 XML 字段映射。</p>
        <t-button theme="primary" @click="createNewTask">
          <template #icon>
            <AddIcon />
          </template>
          新建任务
        </t-button>
      </div>
    </section>

    <div class="pane-divider preview-divider" role="separator" aria-label="调整网页预览宽度" aria-orientation="vertical"
      tabindex="0" @pointerdown="startPaneResize('preview', $event)"
      @keydown="resizePaneWithKeyboard('preview', $event)">
      <t-tooltip :content="previewCollapsed ? '展开网页预览' : '折叠网页预览'" placement="left">
        <t-button class="pane-toggle" theme="default" variant="outline" shape="square" size="small" @pointerdown.stop
          @click.stop="togglePreviewPane">
          <ChevronLeftIcon v-if="previewCollapsed" />
          <ChevronRightIcon v-else />
        </t-button>
      </t-tooltip>
    </div>

    <aside class="preview-pane" :aria-hidden="previewCollapsed" :inert="previewCollapsed">
      <header class="preview-header">
        <div><span>网页预览</span><strong>{{ pickingLabel || previewStatus }}</strong></div>
        <t-tooltip v-if="previewVisible" content="关闭预览" placement="left">
          <t-button theme="default" variant="text" shape="square" @click="closePreview">
            <CloseIcon />
          </t-button>
        </t-tooltip>
      </header>
      <div class="preview-address">
        <t-input v-model="previewUrl" :spell-check="false" placeholder="输入 HTTP/HTTPS 地址" @enter="openPreview">
          <template #prefix-icon>
            <InternetIcon />
          </template>
        </t-input>
        <t-button theme="primary" @click="openPreview">前往</t-button>
      </div>
      <div ref="previewSurface" class="preview-surface" :class="{ active: previewVisible }">
        <div class="preview-placeholder">
          <div class="browser-glyph"><span /><span /><span /></div>
          <strong>{{ previewVisible ? '正在加载网页预览…' : '隔离网页预览' }}</strong>
          <p>远程网页无法访问 Node.js 或本地文件。<br />打开列表页后可直接点选元素。</p>
          <t-button v-if="!previewVisible && activeTask && firstTaskListPageUrl(activeTask)" theme="default"
            variant="outline" @click="previewUrl = firstTaskListPageUrl(activeTask); openPreview()">
            <template #icon>
              <InternetIcon />
            </template>
            打开列表页
          </t-button>
        </div>
      </div>
      <footer class="preview-footer"><span class="status-light" />正式采集使用原始静态 HTML，而非预览渲染结果</footer>
    </aside>

    <section v-if="running || runProgress || runResult" class="run-drawer">
      <header>
        <div>
          <span>采集运行</span>
          <strong>{{ runProgress?.message || runResult?.message || '正在准备…' }}</strong>
        </div>
        <t-button v-if="!running && runResult" theme="default" variant="text" shape="square"
          @click="runProgress = null; runResult = null; runLogs = []">
          <CloseIcon />
        </t-button>
      </header>
      <div class="run-body">
        <div class="run-metrics">
          <div><span>当前页</span><strong>{{ runProgress?.page ?? '—' }}</strong></div>
          <div><span>发现</span><strong>{{ runProgress?.counters.discovered ?? runResult?.counters.discovered ?? 0
              }}</strong>
          </div>
          <div><span>成功</span><strong>{{ runProgress?.counters.succeeded ?? runResult?.counters.succeeded ?? 0
              }}</strong>
          </div>
          <div><span>重复</span><strong>{{ runProgress?.counters.duplicated ?? runResult?.counters.duplicated ?? 0
              }}</strong>
          </div>
          <div><span>跳过/失败</span><strong>{{ (runProgress?.counters.skipped ?? runResult?.counters.skipped ?? 0) +
            (runProgress?.counters.failed ?? runResult?.counters.failed ?? 0) }}</strong></div>
        </div>
        <div class="run-current"><span>{{ runProgress?.currentUrl || runResult?.outputFiles.at(-1) || '等待任务开始' }}</span>
        </div>
        <div class="run-logs">
          <p v-for="(log, index) in runLogs.slice(-8)" :key="`${log.time}-${index}`" :class="log.level"><time>{{ new
            Date(log.time).toLocaleTimeString('zh-CN', { hour12: false }) }}</time>{{ log.message }}</p>
        </div>
        <div class="run-controls">
          <template v-if="running">
            <t-button v-if="runProgress?.status !== 'paused'" theme="default" variant="outline" @click="pauseRun">
              暂停
            </t-button>
            <t-button v-else theme="primary" @click="resumeRun">继续</t-button>
            <t-button theme="danger" variant="outline" @click="cancelRun">取消</t-button>
          </template>
          <template v-else>
            <t-button theme="primary" @click="openOutput">
              <template #icon>
                <FolderOpenIcon />
              </template>
              打开输出目录
            </t-button>
            <t-button theme="default" variant="outline" :disabled="!runResult?.errorLogPath" @click="openErrorLog">
              打开错误日志
            </t-button>
          </template>
        </div>
      </div>
    </section>

    <t-dialog v-model:visible="resumePrompt" header="发现未完成检查点" theme="warning" :footer="false"
      :close-on-overlay-click="false" width="480px">
      <p class="dialog-copy">继续会从上次页码和未满批次恢复；重新开始会放弃检查点，并按当前覆盖设置处理旧 XML。</p>
      <div class="dialog-actions">
        <t-button theme="default" variant="text" @click="resumePrompt = false">取消</t-button>
        <t-button theme="default" variant="outline" @click="launchRun(false)">放弃并重新开始</t-button>
        <t-button theme="primary" @click="launchRun(true)">继续上次任务</t-button>
      </div>
    </t-dialog>

    <t-dialog :visible="Boolean(pendingDeleteTaskId)" header="删除任务配置？" theme="danger" :footer="false" width="440px"
      @close="pendingDeleteTaskId = ''">
      <p class="dialog-copy">任务配置会从本机删除，已经生成的 XML 文件不会被删除。</p>
      <div class="dialog-actions">
        <t-button theme="default" variant="text" @click="pendingDeleteTaskId = ''">取消</t-button>
        <t-button theme="danger" @click="confirmRemoveTask">删除任务</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="cancelPrompt" header="取消当前采集？" theme="warning" :footer="false" width="440px">
      <p class="dialog-copy">取消后会把当前有效记录写成最后一个 XML，并清除本次检查点。</p>
      <div class="dialog-actions">
        <t-button theme="default" variant="text" @click="cancelPrompt = false">继续采集</t-button>
        <t-button theme="danger" variant="outline" @click="confirmCancelRun">确认取消</t-button>
      </div>
    </t-dialog>
  </main>
</template>
