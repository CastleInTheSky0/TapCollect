import { describe, expect, it } from 'vitest'
import {
  PANE_LAYOUT,
  RUN_LOG_LAYOUT,
  defaultPaneWidths,
  fitRunLogHeight,
  fitPaneWidths,
  maxRunLogHeight,
  resizeRunLogHeight,
  resizePaneWidths,
  workspaceWidthForPaneLayout
} from './pane-layout'

const visible = { sidebar: true, preview: true }

describe('resizable pane layout', () => {
  it('gives the preview more room at the normal desktop width', () => {
    const widths = defaultPaneWidths(1_500)
    expect(widths.preview).toBeGreaterThanOrEqual(540)
    expect(workspaceWidthForPaneLayout(1_500, widths, visible)).toBeGreaterThanOrEqual(
      PANE_LAYOUT.workspaceMin
    )
  })

  it('fits both panes at the Electron minimum window width', () => {
    const widths = fitPaneWidths({ sidebar: 300, preview: 700 }, 1_180, visible)
    expect(widths.sidebar).toBeGreaterThanOrEqual(PANE_LAYOUT.sidebarMin)
    expect(widths.preview).toBeGreaterThanOrEqual(PANE_LAYOUT.previewMin)
    expect(workspaceWidthForPaneLayout(1_180, widths, visible)).toBeGreaterThanOrEqual(
      PANE_LAYOUT.workspaceMin
    )
  })

  it('caps preview dragging before the configuration workspace becomes too narrow', () => {
    const start = { sidebar: 224, preview: 460 }
    const resized = resizePaneWidths('preview', start, -800, 1_280, visible)
    expect(resized.sidebar).toBe(start.sidebar)
    expect(workspaceWidthForPaneLayout(1_280, resized, visible)).toBeGreaterThanOrEqual(
      PANE_LAYOUT.workspaceMin
    )
  })

  it('allows the expanded pane to use space released by a collapsed neighbor', () => {
    const visibility = { sidebar: false, preview: true }
    const resized = resizePaneWidths(
      'preview',
      { sidebar: 246, preview: 500 },
      -500,
      1_180,
      visibility
    )
    expect(resized.preview).toBeGreaterThan(500)
    expect(workspaceWidthForPaneLayout(1_180, resized, visibility)).toBeGreaterThanOrEqual(
      PANE_LAYOUT.workspaceMin
    )
  })

  it('reserves the collapsed TDesign navigation rail while fitting the preview', () => {
    const visibility = { sidebar: false, preview: true }
    const fitted = fitPaneWidths({ sidebar: 246, preview: 900 }, 1_180, visibility)

    expect(fitted.preview).toBe(616)
    expect(workspaceWidthForPaneLayout(1_180, fitted, visibility)).toBe(
      PANE_LAYOUT.workspaceMin
    )
  })

  it('resizes the bottom log upward while keeping it usable at the minimum window height', () => {
    expect(resizeRunLogHeight(176, -120, 720)).toBe(296)
    expect(resizeRunLogHeight(176, 500, 720)).toBe(RUN_LOG_LAYOUT.minHeight)
    expect(maxRunLogHeight(720)).toBe(420)
    expect(fitRunLogHeight(900, 720)).toBe(420)
  })
})
