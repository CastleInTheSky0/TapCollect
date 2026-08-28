// @vitest-environment jsdom

import { createApp, defineComponent, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewNavigationState } from '@shared/types'
import { createTask } from '@shared/defaults'
import { usePreview } from './usePreview'
import type { PreviewDeps } from './usePreview'

afterEach(() => {
  vi.restoreAllMocks()
})

const mountPreview = (deps: PreviewDeps) => {
  let store!: ReturnType<typeof usePreview>
  const app = createApp(
    defineComponent({
      setup() {
        store = usePreview(deps)
        return () => null
      }
    })
  )
  const container = document.createElement('div')
  app.mount(container)
  return { app, store }
}

describe('usePreview navigation history', () => {
  it('follows main-process navigation state and cleans up its subscription', async () => {
    const navigationListeners: Array<(state: PreviewNavigationState) => void> = []
    const removeNavigationListener = vi.fn()
    const previewGoBack = vi.fn(async () => true)
    const previewGoForward = vi.fn(async () => true)
    const previewClose = vi.fn(async () => true)
    const onPreviewNavigation = vi.fn((listener: (state: PreviewNavigationState) => void) => {
      navigationListeners.push(listener)
      return removeNavigationListener
    })
    Object.defineProperty(window, 'collector', {
      configurable: true,
      value: {
        onPreviewNavigation,
        previewGoBack,
        previewGoForward,
        previewClose
      }
    })

    const previewVisible = ref(true)
    const { app, store } = mountPreview({
      showError: vi.fn(),
      showNotice: vi.fn(),
      showWarning: vi.fn(),
      previewVisible,
      layout: {
        expandPreviewPane: vi.fn(async () => {}),
        previewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        schedulePreviewBoundsUpdate: vi.fn()
      },
      getActiveTask: () => null,
      getActiveOutputTemplate: () => null,
      isActiveTaskLocked: () => false,
      isClickDetail: () => false
    })

    expect(onPreviewNavigation).toHaveBeenCalledOnce()
    await store.goBackPreview()
    await store.goForwardPreview()
    expect(previewGoBack).not.toHaveBeenCalled()
    expect(previewGoForward).not.toHaveBeenCalled()

    store.setPreviewUrl('https://example.com/detail')
    navigationListeners[0]?.({
      url: '',
      canGoBack: false,
      canGoForward: false,
      isLoading: true
    })
    expect(store.previewUrl.value).toBe('https://example.com/detail')
    expect(previewVisible.value).toBe(true)
    expect(store.previewLoading.value).toBe(true)

    navigationListeners[0]?.({
      url: 'https://example.com/detail',
      canGoBack: true,
      canGoForward: false,
      isLoading: true
    })
    expect(store.previewUrl.value).toBe('https://example.com/detail')
    expect(store.previewLoading.value).toBe(true)
    expect(store.previewCanGoBack.value).toBe(false)
    expect(store.previewCanGoForward.value).toBe(false)
    navigationListeners[0]?.({
      url: 'https://example.com/detail',
      canGoBack: true,
      canGoForward: false,
      isLoading: false
    })
    expect(store.previewLoading.value).toBe(false)
    expect(store.previewCanGoBack.value).toBe(true)

    await store.goBackPreview()
    expect(previewGoBack).toHaveBeenCalledOnce()

    navigationListeners[0]?.({
      url: 'https://example.com/list',
      canGoBack: false,
      canGoForward: true,
      isLoading: false
    })
    expect(store.previewUrl.value).toBe('https://example.com/list')
    expect(store.previewCanGoBack.value).toBe(false)
    expect(store.previewCanGoForward.value).toBe(true)

    await store.goForwardPreview()
    expect(previewGoForward).toHaveBeenCalledOnce()

    navigationListeners[0]?.({
      url: 'https://example.com/list',
      canGoBack: false,
      canGoForward: true,
      isLoading: true
    })
    expect(store.previewLoading.value).toBe(true)

    await store.closePreview()
    expect(previewClose).toHaveBeenCalledOnce()
    expect(previewVisible.value).toBe(false)
    expect(store.previewUrl.value).toBe('')
    expect(store.previewLoading.value).toBe(false)
    expect(store.previewCanGoBack.value).toBe(false)
    expect(store.previewCanGoForward.value).toBe(false)

    app.unmount()
    expect(removeNavigationListener).toHaveBeenCalledOnce()
  })

  it('keeps the native preview hidden while resolving and opening a detail sample', async () => {
    const calls: string[] = []
    let resolveDetailSamples!: (urls: string[]) => void
    const detailSamplesPromise = new Promise<string[]>((resolve) => {
      resolveDetailSamples = resolve
    })
    const previewSetOpening = vi.fn(async (opening: boolean) => {
      calls.push(`opening:${opening}`)
      return true
    })
    const getDetailSamples = vi.fn(() => {
      calls.push('samples')
      return detailSamplesPromise
    })
    const previewOpen = vi.fn(async (url: string) => {
      calls.push(`open:${url}`)
      return true
    })
    const removeNavigationListener = vi.fn()
    Object.defineProperty(window, 'collector', {
      configurable: true,
      value: {
        getDetailSamples,
        previewOpen,
        previewSetOpening,
        onPreviewNavigation: vi.fn(() => removeNavigationListener)
      }
    })

    const detailUrl = 'https://example.com/detail/1'
    const task = createTask('detail-loading-test')
    const previewVisible = ref(true)
    const { app, store } = mountPreview({
      showError: vi.fn(),
      showNotice: vi.fn(),
      showWarning: vi.fn(),
      previewVisible,
      layout: {
        expandPreviewPane: vi.fn(async () => {}),
        previewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        schedulePreviewBoundsUpdate: vi.fn()
      },
      getActiveTask: () => task,
      getActiveOutputTemplate: () => null,
      isActiveTaskLocked: () => false,
      isClickDetail: () => false
    })

    const opening = store.openDetailSample(false)
    await vi.waitFor(() => expect(getDetailSamples).toHaveBeenCalledOnce())
    expect(previewSetOpening).toHaveBeenCalledWith(true)
    expect(store.previewLoading.value).toBe(true)
    expect(previewOpen).not.toHaveBeenCalled()

    resolveDetailSamples([detailUrl])
    await opening

    expect(calls).toEqual([
      'opening:true',
      'samples',
      `open:${detailUrl}`,
      'opening:false'
    ])
    expect(store.previewUrl.value).toBe(detailUrl)
    expect(store.previewLoading.value).toBe(false)
    expect(previewVisible.value).toBe(true)

    app.unmount()
    expect(removeNavigationListener).toHaveBeenCalledOnce()
  })
})
