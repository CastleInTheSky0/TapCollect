import { ref } from 'vue'
import type { AccessProfile, AccessProfileInput } from '@shared/access-profile'

export const useAccessProfiles = (feedback: { showError(error: unknown): void; showNotice(message: string): void }) => {
  const profiles = ref<AccessProfile[]>([])
  const busy = ref(false)
  const error = ref('')
  const refresh = async (): Promise<void> => {
    try { profiles.value = await window.collector.listAccessProfiles(); error.value = '' }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  }
  const mutate = async (operation: () => Promise<unknown>, message: string): Promise<boolean> => {
    if (busy.value) return false
    busy.value = true
    try { await operation(); await refresh(); feedback.showNotice(message); return true }
    catch (cause) { feedback.showError(cause); return false }
    finally { busy.value = false }
  }
  return {
    profiles, busy, error, refresh,
    save: (profile: AccessProfileInput) => mutate(() => window.collector.saveAccessProfile(JSON.parse(JSON.stringify(profile)) as AccessProfileInput), '访问配置已保存'),
    remove: (id: string) => mutate(() => window.collector.deleteAccessProfile(id), '访问配置已删除'),
    importCookies: (id: string, json: string) => mutate(() => window.collector.importAccessCookies(id, json), 'Cookie 已导入'),
    clear: (id: string) => mutate(() => window.collector.clearAccessSession(id), '登录状态已清除')
  }
}
