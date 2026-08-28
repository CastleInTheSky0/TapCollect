// @vitest-environment jsdom

import { createApp, defineComponent, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewNavigationState } from '@shared/types'
import { usePreview } from './usePreview'

afterEach(() => {
  vi.restoreAllMocks()
})

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
    let store!: ReturnType<typeof usePreview>
    const app = createApp(
      defineComponent({
        setup() {
          store = usePreview({
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
          return () => null
        }
      })
    )
    const container = document.createElement('div')
    app.mount(container)

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
})
