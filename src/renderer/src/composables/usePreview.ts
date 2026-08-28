import { computed, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import type {
  FieldMapping,
  PageExtractionConfig,
  PreviewBounds,
  TaskConfig
} from '@shared/types'
import { firstTaskListPageUrl } from '@shared/list-page-rules'
import { runPreviewOpenGuard } from '@renderer/utils/preview-open-guard'
import type { PreviewOpenAction } from '@renderer/utils/preview-open-guard'
import { snapshotTaskForIpc } from '@renderer/utils/task-ipc'

export interface PreviewDeps {
  showError: (error: unknown) => void
  showNotice: (message: string) => void
  showWarning: (message: string) => void
  previewVisible: Ref<boolean>
  layout: {
    expandPreviewPane: () => Promise<void>
    previewBounds: () => PreviewBounds | null
    schedulePreviewBoundsUpdate: () => void
  }
  getActiveTask: () => TaskConfig | null
  getActiveOutputTemplate: () => { mappings: FieldMapping[] } | null
  isActiveTaskLocked: () => boolean
  isClickDetail: () => boolean
}

type BaseSelectorTarget = 'list-item' | 'next-button' | 'detail-link'

export const usePreview = (deps: PreviewDeps) => {
  const api = window.collector
  const previewUrl = ref('')
  const previewStatus = ref('尚未打开预览')
  const previewOpenAction = ref<PreviewOpenAction | null>(null)
  const pickingLabel = ref('')
  const detailSamples = ref<string[]>([])
  const detailSampleIndex = ref(-1)

  const previewOpening = computed(() => previewOpenAction.value !== null)

  const setPreviewUrl = (url: string): void => {
    previewUrl.value = url
  }

  const navigate = async (url: string): Promise<void> => {
    await api.previewNavigate(url)
  }

  const resetDetailSamples = (): void => {
    detailSamples.value = []
    detailSampleIndex.value = -1
  }

  const runPreviewOpenAction = async (
    action: PreviewOpenAction,
    status: string,
    operation: () => Promise<void>
  ): Promise<boolean> => {
    if (previewOpenAction.value) {
      previewStatus.value = '网页正在打开，请稍候…'
      return false
    }
    previewStatus.value = status
    return runPreviewOpenGuard(previewOpenAction, action, operation)
  }

  const loadPreviewUrl = async (value: string): Promise<void> => {
    try {
      await deps.layout.expandPreviewPane()
      deps.previewVisible.value = true
      await nextTick()
      const bounds = deps.layout.previewBounds()
      if (!bounds) throw new Error('无法确定网页预览区域，请调整窗口后重试')
      await api.previewOpen(value, bounds)
      previewUrl.value = value
    } catch (error) {
      deps.previewVisible.value = false
      throw error
    }
  }

  const openPreview = async (): Promise<void> => {
    const value =
      previewUrl.value.trim() || (deps.getActiveTask() ? firstTaskListPageUrl(deps.getActiveTask()!) : '')
    if (!value) {
      deps.showError(new Error('请先填写要预览的网页地址'))
      return
    }
    try {
      await runPreviewOpenAction('address', '正在打开网页预览，请稍候…', async () => {
        await loadPreviewUrl(value)
        previewStatus.value = '预览已加载，可点选或验证选择器'
      })
    } catch (error) {
      previewStatus.value = '预览打开失败，可修改地址后重试'
      deps.showError(error)
    }
  }

  const openConfiguredListPreview = async (
    action: Extract<PreviewOpenAction, 'step-list' | 'placeholder-list'>
  ): Promise<void> => {
    const value = deps.getActiveTask() ? firstTaskListPageUrl(deps.getActiveTask()!) : ''
    if (!value) {
      deps.showError(new Error('请先填写列表页面 URL'))
      return
    }
    previewUrl.value = value
    try {
      await runPreviewOpenAction(action, '正在打开列表页预览，请稍候…', async () => {
        await loadPreviewUrl(value)
        previewStatus.value = '预览已加载，可点选或验证选择器'
      })
    } catch (error) {
      previewStatus.value = '列表页预览打开失败，请检查地址或网络后重试'
      deps.showError(error)
    }
  }

  const closePreview = async (): Promise<void> => {
    if (previewOpening.value) return
    await api.previewClose()
    deps.previewVisible.value = false
    previewStatus.value = '预览已关闭'
  }

  const ensurePreview = async (): Promise<boolean> => {
    if (previewOpening.value) {
      previewStatus.value = '网页正在打开，请稍候…'
      return false
    }
    if (!deps.previewVisible.value) await openPreview()
    return deps.previewVisible.value
  }

  const selectorResultStatus = (
    target: BaseSelectorTarget,
    selector: string,
    matchCount: number,
    sample = ''
  ): string => {
    if (target === 'detail-link' && !deps.isClickDetail() && selector.trim() === ':scope') {
      return `已选中列表项自身链接，共匹配 ${matchCount} 条`
    }
    return `匹配 ${matchCount} 个元素${sample ? ` · ${sample}` : ''}`
  }

  const previewScopeForMapping = (mapping: PageExtractionConfig): string =>
    mapping.pageSource === 'list' ? deps.getActiveTask()?.listItem.selector || '' : ':root'

  const ensureListItemSelector = (): boolean => {
    if (deps.getActiveTask()?.listItem.selector.trim()) return true
    deps.showNotice('请先在第 2 步点选或填写列表项容器')
    return false
  }

  const pickBaseSelector = async (target: BaseSelectorTarget): Promise<void> => {
    const task = deps.getActiveTask()
    if (!task) return
    if (target === 'detail-link' && !ensureListItemSelector()) return
    if (!(await ensurePreview())) return
    pickingLabel.value =
      target === 'list-item'
        ? '正在点选列表项，按 Esc 取消'
        : target === 'next-button'
          ? '正在点选下一页按钮，按 Esc 取消'
          : deps.isClickDetail()
            ? '正在点选详情点击元素，按 Esc 取消'
            : '正在点选详情链接，按 Esc 取消'
    try {
      const result = await api.previewPick({
        selectorType: 'css',
        scopeSelector:
          target === 'detail-link'
            ? task.listItem.selector
            : target === 'next-button'
              ? ':root'
              : '',
        ancestorAttribute:
          target === 'detail-link' && !deps.isClickDetail() ? task.detail.linkAttribute : ''
      })
      if (result.cancelled) return
      if (target === 'list-item') {
        task.listItem.selectorType = 'css'
        task.listItem.selector = result.selector
      } else if (target === 'next-button') {
        task.pagination.nextButton.selectorType = 'css'
        task.pagination.nextButton.selector = result.selector
      } else {
        task.detail.link.selectorType = 'css'
        task.detail.link.selector = result.selector
      }
      previewStatus.value =
        target === 'list-item' && result.matchCount <= 1
          ? `仅匹配 ${result.matchCount} 个元素，未识别到重复列表结构；请点选一整条记录或手动调整选择器`
          : selectorResultStatus(target, result.selector, result.matchCount, result.sample)
    } catch (error) {
      deps.showError(error)
    } finally {
      pickingLabel.value = ''
    }
  }

  const evaluateBaseSelector = async (target: BaseSelectorTarget): Promise<void> => {
    const task = deps.getActiveTask()
    if (!task) return
    if (target === 'detail-link' && !ensureListItemSelector()) return
    if (!(await ensurePreview())) return
    const config =
      target === 'list-item'
        ? task.listItem
        : target === 'next-button'
          ? task.pagination.nextButton
          : task.detail.link
    const scope =
      target === 'detail-link'
        ? task.listItem.selector
        : target === 'next-button'
          ? ':root'
          : ''
    try {
      const result = await api.previewEvaluate({
        selectorType: config.selectorType,
        selector: config.selector,
        scopeSelector: scope,
        ancestorAttribute:
          target === 'detail-link' && !deps.isClickDetail() ? task.detail.linkAttribute : ''
      })
      previewStatus.value = result.error
        ? `选择器错误：${result.error}`
        : selectorResultStatus(target, config.selector, result.matchCount, result.sample)
    } catch (error) {
      deps.showError(error)
    }
  }

  const openDetailSample = async (next: boolean): Promise<void> => {
    const task = deps.getActiveTask()
    if (!task) return
    if (deps.isActiveTaskLocked()) {
      deps.showWarning('当前任务正在运行、暂停、排队或测试，不能读取详情样例')
      return
    }
    const action: PreviewOpenAction = next ? 'detail-next' : 'detail-first'
    try {
      await runPreviewOpenAction(
        action,
        next ? '正在打开下一条详情样例，请稍候…' : '正在获取并打开第一条有效详情，请稍候…',
        async () => {
          if (!next || !detailSamples.value.length) {
            detailSamples.value = await api.getDetailSamples(snapshotTaskForIpc(task))
            detailSampleIndex.value = -1
          }
          if (!detailSamples.value.length) {
            previewStatus.value = '当前列表页没有找到可访问的站内详情样例'
            deps.showNotice('当前列表页没有找到可访问的站内详情样例')
            return
          }
          detailSampleIndex.value = next
            ? (detailSampleIndex.value + 1) % detailSamples.value.length
            : 0
          const value =
            detailSamples.value[detailSampleIndex.value] ?? detailSamples.value[0] ?? ''
          previewUrl.value = value
          await loadPreviewUrl(value)
          previewStatus.value = `详情样例 ${detailSampleIndex.value + 1} / ${detailSamples.value.length}`
        }
      )
    } catch (error) {
      previewStatus.value = '详情样例打开失败，请检查地址或网络后重试'
      deps.showError(error)
    }
  }

  const mappingByPath = (path: string): FieldMapping | undefined =>
    deps.getActiveOutputTemplate()?.mappings.find((mapping) => mapping.fieldPath === path)

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
    if (!pageMapping || !deps.getActiveTask()) return
    if (pageMapping.selectorType === 'markers') {
      deps.showNotice('前后标记定位不支持点选，请直接填写标记并使用测试采集验证')
      return
    }
    if (pageMapping.pageSource === 'list' && !ensureListItemSelector()) return
    if (!(await ensurePreview())) return
    pickingLabel.value = `正在点选字段 ${path}${mergeValueId ? ' 的合并项' : ''}，按 Esc 取消`
    try {
      const result = await api.previewPick({
        selectorType: 'css',
        scopeSelector: previewScopeForMapping(pageMapping),
        ancestorAttribute: '',
        detectTextPrefix: pageMapping.extraction === 'text'
      })
      if (!result.cancelled) {
        pageMapping.selectorType = 'css'
        pageMapping.selector = result.selector
        pageMapping.textPrefix =
          pageMapping.extraction === 'text' ? result.textPrefix : ''
        previewStatus.value = `字段 ${path} 匹配 ${result.matchCount} 个元素${
          result.textPrefix ? ` · 已按标签“${result.textPrefix}”定位` : ''
        }`
      }
    } catch (error) {
      deps.showError(error)
    } finally {
      pickingLabel.value = ''
    }
  }

  const evaluateMapping = async (path: string, mergeValueId?: string): Promise<void> => {
    const pageMapping = pageMappingByPath(path, mergeValueId)
    if (!pageMapping || !deps.getActiveTask()) return
    const selectorType = pageMapping.selectorType
    if (selectorType === 'markers') {
      deps.showNotice('前后标记定位请使用测试采集验证')
      return
    }
    if (pageMapping.pageSource === 'list' && !ensureListItemSelector()) return
    if (!(await ensurePreview())) return
    try {
      const result = await api.previewEvaluate({
        selectorType,
        selector: pageMapping.selector,
        scopeSelector: previewScopeForMapping(pageMapping),
        ancestorAttribute: '',
        textPrefix: pageMapping.extraction === 'text' ? pageMapping.textPrefix : ''
      })
      if (result.error) {
        previewStatus.value = `字段 ${path}：${result.error}`
        deps.showWarning(previewStatus.value)
      } else {
        previewStatus.value = `字段 ${path} 匹配 ${result.matchCount} 个元素`
        if (result.matchCount === 0) {
          deps.showWarning(`字段 ${path} 未匹配到内容，请检查页面来源和选择器`)
        }
      }
    } catch (error) {
      deps.showError(error)
    }
  }

  return {
    previewUrl,
    previewStatus,
    previewOpenAction,
    pickingLabel,
    detailSamples,
    detailSampleIndex,
    previewOpening,
    setPreviewUrl,
    navigate,
    resetDetailSamples,
    loadPreviewUrl,
    openPreview,
    openConfiguredListPreview,
    closePreview,
    ensurePreview,
    pickBaseSelector,
    evaluateBaseSelector,
    openDetailSample,
    pickMapping,
    evaluateMapping
  }
}
