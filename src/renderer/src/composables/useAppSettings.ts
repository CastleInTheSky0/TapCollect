import { ref } from 'vue'
import type { Ref } from 'vue'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AppSettings } from '@shared/types'

export interface AppSettingsDeps {
  showError: (error: unknown) => void
  showNotice: (message: string) => void
  refreshRunSession: () => Promise<void>
  getActiveOutputRoot: () => string
}

export const useAppSettings = (deps: AppSettingsDeps): {
  settings: Ref<AppSettings>
  settingsSaving: Ref<boolean>
  saveDefaultOutputDirectory: () => Promise<void>
  changeMaxConcurrentRuns: (value: number) => Promise<void>
  changeAutoCheckUpdates: (enabled: boolean) => Promise<void>
} => {
  const api = window.collector
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const settingsSaving = ref(false)

  const saveDefaultOutputDirectory = async (): Promise<void> => {
    const path = deps.getActiveOutputRoot()
    if (!path) {
      deps.showError(new Error('请先选择输出根目录'))
      return
    }
    try {
      settings.value = await api.saveSettings({
        ...settings.value,
        defaultOutputDirectory: path
      })
      deps.showNotice('已设为新任务的全局默认输出目录')
    } catch (error) {
      deps.showError(error)
    }
  }

  const changeMaxConcurrentRuns = async (value: number): Promise<void> => {
    if (settingsSaving.value || value === settings.value.maxConcurrentRuns) return
    settingsSaving.value = true
    try {
      settings.value = await api.saveSettings({
        ...settings.value,
        maxConcurrentRuns: value
      })
      await deps.refreshRunSession()
      deps.showNotice(`最大并发任务数已调整为 ${settings.value.maxConcurrentRuns}`)
    } catch (error) {
      deps.showError(error)
    } finally {
      settingsSaving.value = false
    }
  }

  const changeAutoCheckUpdates = async (enabled: boolean): Promise<void> => {
    if (settingsSaving.value || enabled === settings.value.autoCheckUpdates) return
    settingsSaving.value = true
    try {
      settings.value = await api.saveSettings({
        ...settings.value,
        autoCheckUpdates: enabled
      })
      deps.showNotice(enabled ? '已开启启动时自动检查更新' : '已关闭启动时自动检查更新')
    } catch (error) {
      deps.showError(error)
    } finally {
      settingsSaving.value = false
    }
  }

  return {
    settings,
    settingsSaving,
    saveDefaultOutputDirectory,
    changeMaxConcurrentRuns,
    changeAutoCheckUpdates
  }
}
