import { ref } from 'vue'
import type { UpdateCheckResult } from '@shared/types'
import { messageFromError } from '@renderer/utils/error-message'

export interface AppUpdateDeps {
  isAboutDialogVisible: () => boolean
  openAboutDialog: () => void
}

export const useAppUpdate = (deps: AppUpdateDeps) => {
  const api = window.collector
  const updateCheckResult = ref<UpdateCheckResult | null>(null)
  const updateChecking = ref(false)
  const updateCheckError = ref('')
  const updateNoticeVisible = ref(false)
  let activeCheck: Promise<UpdateCheckResult> | null = null
  let startupCheckStarted = false

  const requestUpdateCheck = (): Promise<UpdateCheckResult> => {
    if (activeCheck) return activeCheck

    updateChecking.value = true
    const request = Promise.resolve()
      .then(() => api.checkForUpdates())
      .then((result) => {
        updateCheckResult.value = result
        if (result.status !== 'available') updateNoticeVisible.value = false
        return result
      })
      .finally(() => {
        if (activeCheck !== request) return
        activeCheck = null
        updateChecking.value = false
      })
    activeCheck = request
    return request
  }

  const checkForUpdatesManually = async (): Promise<void> => {
    updateCheckError.value = ''
    try {
      await requestUpdateCheck()
    } catch (error) {
      updateCheckError.value = messageFromError(error)
    }
  }

  const checkForUpdatesOnStartup = async (enabled: boolean): Promise<void> => {
    if (startupCheckStarted) return
    startupCheckStarted = true
    if (!enabled) return

    try {
      const result = await requestUpdateCheck()
      if (result.status === 'available' && !deps.isAboutDialogVisible()) {
        updateNoticeVisible.value = true
      }
    } catch {
      // 自动检查不得打断启动或离线使用；用户仍可在弹窗内手动检查并查看错误。
    }
  }

  const clearUpdateCheckError = (): void => {
    updateCheckError.value = ''
  }

  const dismissUpdateNotice = (): void => {
    updateNoticeVisible.value = false
  }

  const openUpdateDetails = (): void => {
    dismissUpdateNotice()
    deps.openAboutDialog()
  }

  return {
    updateCheckResult,
    updateChecking,
    updateCheckError,
    updateNoticeVisible,
    checkForUpdatesManually,
    checkForUpdatesOnStartup,
    clearUpdateCheckError,
    dismissUpdateNotice,
    openUpdateDetails
  }
}
