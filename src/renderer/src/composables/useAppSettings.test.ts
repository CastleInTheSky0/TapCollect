// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { useAppSettings } from './useAppSettings'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAppSettings automatic update preference', () => {
  it('persists the switch and retains the previous value when saving fails', async () => {
    const saveSettings = vi
      .fn()
      .mockImplementationOnce(async (settings) => settings)
      .mockRejectedValueOnce(new Error('保存设置失败'))
    Object.defineProperty(window, 'collector', {
      configurable: true,
      value: { saveSettings }
    })
    const showError = vi.fn()
    const showNotice = vi.fn()
    const store = useAppSettings({
      showError,
      showNotice,
      refreshRunSession: vi.fn(async () => {}),
      getActiveOutputRoot: () => ''
    })

    expect(store.settings.value).toEqual(DEFAULT_SETTINGS)
    await store.changeAutoCheckUpdates(true)
    expect(saveSettings).toHaveBeenLastCalledWith({
      ...DEFAULT_SETTINGS,
      autoCheckUpdates: true
    })
    expect(store.settings.value.autoCheckUpdates).toBe(true)
    expect(showNotice).toHaveBeenCalledWith('已开启启动时自动检查更新')

    await store.changeAutoCheckUpdates(false)
    expect(store.settings.value.autoCheckUpdates).toBe(true)
    expect(showError).toHaveBeenCalledOnce()
    expect(store.settingsSaving.value).toBe(false)
  })
})
