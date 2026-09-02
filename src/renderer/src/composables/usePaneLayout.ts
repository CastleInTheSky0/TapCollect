import { computed, nextTick, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { PreviewBounds } from '@shared/types'
import {
  defaultPaneWidths,
  clipPaneBoundsAboveBottomOverlay,
  fitRunLogHeight,
  fitPaneWidths,
  maxRunLogHeight,
  PANE_LAYOUT,
  resizePaneWidths,
  RUN_LOG_LAYOUT
} from '@renderer/utils/pane-layout'
import type { PaneVisibility, PaneWidths, ResizablePane } from '@renderer/utils/pane-layout'
import type { AppView } from '@renderer/router'

interface PaneResizeStart {
  pane: ResizablePane
  startX: number
  widths: PaneWidths
}

export interface PaneLayoutDeps {
  appView: Readonly<Ref<AppView>>
  previewBlocked: Readonly<Ref<boolean>>
  previewVisible: Ref<boolean>
  previewSurface: Ref<HTMLElement | null>
  runDrawerSurface: Readonly<Ref<HTMLElement | null>>
}

// 分栏宽度、折叠状态与预览边界调度；运行日志面板的拖拽已迁移到 RunDrawer 组件
export const usePaneLayout = (deps: PaneLayoutDeps) => {
  const api = window.collector
  const paneWidths = ref<PaneWidths>(defaultPaneWidths(window.innerWidth))
  const sidebarCollapsed = ref(false)
  const previewCollapsed = ref(false)
  const resizingPane = ref<ResizablePane | null>(null)
  const runLogHeight = ref(fitRunLogHeight(RUN_LOG_LAYOUT.defaultHeight, window.innerHeight))
  const runLogMaxHeight = ref(maxRunLogHeight(window.innerHeight))

  let previewBoundsFrame: number | null = null
  let paneResizeStart: PaneResizeStart | null = null

  const paneVisibility = computed<PaneVisibility>(() => ({
    sidebar: !sidebarCollapsed.value,
    preview: deps.appView.value === 'task' && !previewCollapsed.value
  }))

  const appShellStyle = computed<Record<string, string>>(() => ({
    '--sidebar-width': `${sidebarCollapsed.value ? PANE_LAYOUT.sidebarCollapsedWidth : paneWidths.value.sidebar}px`,
    '--preview-width': `${deps.appView.value === 'run-center' || previewCollapsed.value ? 0 : paneWidths.value.preview}px`
  }))

  const fitCurrentPaneWidths = (): void => {
    const fitted = fitPaneWidths(paneWidths.value, window.innerWidth, paneVisibility.value)
    paneWidths.value = {
      sidebar: paneVisibility.value.sidebar ? fitted.sidebar : paneWidths.value.sidebar,
      preview: paneVisibility.value.preview ? fitted.preview : paneWidths.value.preview
    }
  }

  const hiddenPreviewBounds = (): PreviewBounds => ({
    x: window.innerWidth + 2,
    y: 0,
    width: 1,
    height: 1
  })

  const previewBounds = (): PreviewBounds | null => {
    const element = deps.previewSurface.value
    if (!element) return null
    if (
      deps.previewBlocked.value ||
      deps.appView.value === 'run-center' ||
      previewCollapsed.value
    ) {
      return hiddenPreviewBounds()
    }
    const rect = element.getBoundingClientRect()
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    const drawer = deps.runDrawerSurface.value
    if (!drawer) return bounds

    const drawerRect = drawer.getBoundingClientRect()
    // RunDrawer 从底部进入时带有 translateY 动画；用最终布局高度计算上沿，
    // 避免动画期间原生预览短暂盖住抽屉顶部。
    const drawerTop = Math.min(drawerRect.top, window.innerHeight - drawer.offsetHeight)
    return (
      clipPaneBoundsAboveBottomOverlay(bounds, {
        left: drawerRect.left,
        right: drawerRect.right,
        top: drawerTop
      }) ?? hiddenPreviewBounds()
    )
  }

  const updatePreviewBounds = (): void => {
    if (!deps.previewVisible.value) return
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

  const cancelScheduledPreviewBoundsUpdate = (): void => {
    if (previewBoundsFrame === null) return
    window.cancelAnimationFrame(previewBoundsFrame)
    previewBoundsFrame = null
  }

  watch([deps.previewBlocked, deps.runDrawerSurface], () => {
    void nextTick(schedulePreviewBoundsUpdate)
  })

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

  const resizePaneWithKeyboard = (pane: ResizablePane, event: KeyboardEvent): void => {
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
    runLogMaxHeight.value = maxRunLogHeight(window.innerHeight)
    runLogHeight.value = fitRunLogHeight(runLogHeight.value, window.innerHeight)
    schedulePreviewBoundsUpdate()
  }

  return {
    paneWidths,
    sidebarCollapsed,
    previewCollapsed,
    resizingPane,
    runLogHeight,
    runLogMaxHeight,
    paneVisibility,
    appShellStyle,
    fitCurrentPaneWidths,
    previewBounds,
    schedulePreviewBoundsUpdate,
    cancelScheduledPreviewBoundsUpdate,
    toggleSidebarPane,
    togglePreviewPane,
    expandPreviewPane,
    startPaneResize,
    handlePaneResize,
    stopPaneResize,
    resizePaneWithKeyboard,
    handleWindowResize
  }
}
