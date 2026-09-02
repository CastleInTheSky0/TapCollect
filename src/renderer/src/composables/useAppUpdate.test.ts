// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateCheckResult } from '@shared/types'
import { useAppUpdate } from './useAppUpdate'

const availableResult = (): UpdateCheckResult => ({
  status: 'available',
  checkedAt: '2026-09-02T00:00:00.000Z',
  currentVersion: '0.4.3',
  release: {
    id: 1,
    version: '0.5.0',
    tagName: 'v0.5.0',
    title: 'TapCollect 0.5.0',
    summary: '新增启动检查更新。',
    hasSummary: true,
    summaryTruncated: false,
    releaseUrl: 'https://github.com/CastleInTheSky0/TapCollect/releases/tag/v0.5.0',
    publishedAt: '2026-09-02T00:00:00.000Z',
    asset: {
      id: 2,
      name: 'TapCollect-0.5.0-x64.exe',
      size: 1024,
      digest: 'sha256:abc'
    }
  },
  message: '发现新版本 0.5.0'
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAppUpdate', () => {
  it('does not check when the persisted opt-in is off and starts at most once', async () => {
    const checkForUpdates = vi.fn(async () => availableResult())
    Object.defineProperty(window, 'collector', {
      configurable: true,
      value: { checkForUpdates }
    })
    const store = useAppUpdate({
      isAboutDialogVisible: () => false,
      openAboutDialog: vi.fn()
    })

    await store.checkForUpdatesOnStartup(false)
    await store.checkForUpdatesOnStartup(true)

    expect(checkForUpdates).not.toHaveBeenCalled()
    expect(store.updateNoticeVisible.value).toBe(false)
  })

  it('deduplicates concurrent startup and manual checks and reuses the available result', async () => {
    const pending = deferred<UpdateCheckResult>()
    const checkForUpdates = vi.fn(() => pending.promise)
    Object.defineProperty(window, 'collector', {
      configurable: true,
      value: { checkForUpdates }
    })
    const openAboutDialog = vi.fn()
    const store = useAppUpdate({
      isAboutDialogVisible: () => false,
      openAboutDialog
    })

    const startupCheck = store.checkForUpdatesOnStartup(true)
    const manualCheck = store.checkForUpdatesManually()
    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledOnce())
    expect(store.updateChecking.value).toBe(true)

    const result = availableResult()
    pending.resolve(result)
    await Promise.all([startupCheck, manualCheck])

    expect(store.updateCheckResult.value).toEqual(result)
    expect(store.updateChecking.value).toBe(false)
    expect(store.updateNoticeVisible.value).toBe(true)

    store.openUpdateDetails()
    expect(store.updateNoticeVisible.value).toBe(false)
    expect(openAboutDialog).toHaveBeenCalledOnce()
  })

  it('keeps automatic failures silent but exposes a later manual failure', async () => {
    const checkForUpdates = vi
      .fn<() => Promise<UpdateCheckResult>>()
      .mockRejectedValueOnce(new Error('自动检查失败'))
      .mockRejectedValueOnce(new Error('手动检查失败'))
    Object.defineProperty(window, 'collector', {
      configurable: true,
      value: { checkForUpdates }
    })
    const store = useAppUpdate({
      isAboutDialogVisible: () => false,
      openAboutDialog: vi.fn()
    })

    await store.checkForUpdatesOnStartup(true)
    expect(store.updateCheckError.value).toBe('')
    expect(store.updateNoticeVisible.value).toBe(false)

    await store.checkForUpdatesManually()
    expect(store.updateCheckError.value).toBe('手动检查失败')
    store.clearUpdateCheckError()
    expect(store.updateCheckError.value).toBe('')
  })

  it('does not raise a notice when the update dialog is already visible', async () => {
    Object.defineProperty(window, 'collector', {
      configurable: true,
      value: { checkForUpdates: vi.fn(async () => availableResult()) }
    })
    const store = useAppUpdate({
      isAboutDialogVisible: () => true,
      openAboutDialog: vi.fn()
    })

    await store.checkForUpdatesOnStartup(true)

    expect(store.updateCheckResult.value?.status).toBe('available')
    expect(store.updateNoticeVisible.value).toBe(false)
  })
})
