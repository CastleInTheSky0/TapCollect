export type ResizablePane = 'sidebar' | 'preview'

export interface PaneWidths {
  sidebar: number
  preview: number
}

export interface PaneVisibility {
  sidebar: boolean
  preview: boolean
}

export const PANE_LAYOUT = {
  dividerSize: 10,
  workspaceMin: 480,
  sidebarCollapsedWidth: 64,
  sidebarMin: 188,
  sidebarMax: 340,
  previewMin: 360,
  previewMax: 900
} as const

export const RUN_LOG_LAYOUT = {
  defaultHeight: 176,
  minHeight: 104,
  maxHeight: 480,
  viewportReserve: 300,
  keyboardStep: 24
} as const

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum))

const availableForSidePanes = (viewportWidth: number): number =>
  Math.max(0, viewportWidth - PANE_LAYOUT.dividerSize * 2 - PANE_LAYOUT.workspaceMin)

export const maxRunLogHeight = (viewportHeight: number): number =>
  Math.max(
    RUN_LOG_LAYOUT.minHeight,
    Math.min(RUN_LOG_LAYOUT.maxHeight, viewportHeight - RUN_LOG_LAYOUT.viewportReserve)
  )

export const fitRunLogHeight = (height: number, viewportHeight: number): number =>
  Math.round(clamp(height, RUN_LOG_LAYOUT.minHeight, maxRunLogHeight(viewportHeight)))

export const resizeRunLogHeight = (
  startHeight: number,
  pointerDeltaY: number,
  viewportHeight: number
): number => fitRunLogHeight(startHeight - pointerDeltaY, viewportHeight)

export const defaultPaneWidths = (viewportWidth: number): PaneWidths =>
  fitPaneWidths(
    {
      sidebar: viewportWidth <= 1_280 ? 224 : 246,
      preview: clamp(Math.round(viewportWidth * 0.38), 420, 600)
    },
    viewportWidth,
    { sidebar: true, preview: true }
  )

export const fitPaneWidths = (
  widths: PaneWidths,
  viewportWidth: number,
  visibility: PaneVisibility
): PaneWidths => {
  let sidebar = visibility.sidebar
    ? clamp(widths.sidebar, PANE_LAYOUT.sidebarMin, PANE_LAYOUT.sidebarMax)
    : 0
  let preview = visibility.preview
    ? clamp(widths.preview, PANE_LAYOUT.previewMin, PANE_LAYOUT.previewMax)
    : 0
  const collapsedSidebarWidth = visibility.sidebar ? 0 : PANE_LAYOUT.sidebarCollapsedWidth
  let overflow = Math.max(
    0,
    sidebar + collapsedSidebarWidth + preview - availableForSidePanes(viewportWidth)
  )

  if (visibility.sidebar && overflow) {
    const reduction = Math.min(overflow, Math.max(0, sidebar - PANE_LAYOUT.sidebarMin))
    sidebar -= reduction
    overflow -= reduction
  }
  if (visibility.preview && overflow) {
    const reduction = Math.min(overflow, Math.max(0, preview - PANE_LAYOUT.previewMin))
    preview -= reduction
    overflow -= reduction
  }

  // Electron enforces a 1180px minimum window, but keep the layout safe if the
  // renderer is embedded or inspected at a smaller width.
  if (overflow && visibility.sidebar) {
    const reduction = Math.min(overflow, sidebar)
    sidebar -= reduction
    overflow -= reduction
  }
  if (overflow && visibility.preview) preview = Math.max(0, preview - overflow)

  return { sidebar: Math.round(sidebar), preview: Math.round(preview) }
}

export const resizePaneWidths = (
  pane: ResizablePane,
  widths: PaneWidths,
  pointerDelta: number,
  viewportWidth: number,
  visibility: PaneVisibility
): PaneWidths => {
  const next = { ...widths }
  const otherWidth =
    pane === 'sidebar'
      ? visibility.preview
        ? widths.preview
        : 0
      : visibility.sidebar
        ? widths.sidebar
        : PANE_LAYOUT.sidebarCollapsedWidth
  const available = Math.max(0, availableForSidePanes(viewportWidth) - otherWidth)

  if (pane === 'sidebar') {
    next.sidebar = clamp(
      widths.sidebar + pointerDelta,
      PANE_LAYOUT.sidebarMin,
      Math.min(PANE_LAYOUT.sidebarMax, available)
    )
  } else {
    next.preview = clamp(
      widths.preview - pointerDelta,
      PANE_LAYOUT.previewMin,
      Math.min(PANE_LAYOUT.previewMax, available)
    )
  }
  return next
}

export const workspaceWidthForPaneLayout = (
  viewportWidth: number,
  widths: PaneWidths,
  visibility: PaneVisibility
): number =>
  viewportWidth -
  PANE_LAYOUT.dividerSize * 2 -
  (visibility.sidebar ? widths.sidebar : PANE_LAYOUT.sidebarCollapsedWidth) -
  (visibility.preview ? widths.preview : 0)
