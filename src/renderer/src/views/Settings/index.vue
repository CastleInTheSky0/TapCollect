<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ControlPlatformIcon, TimeIcon, SecuredIcon, InternetIcon, SettingIcon, HelpCircleIcon, FolderOpenIcon } from 'tdesign-icons-vue-next'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { useAppStore } from '@renderer/store'
import SettingsPolicy from './policy.vue'
import SettingsProfiles from './profiles.vue'

const { settingsStore, openAboutDialog } = useAppStore()
const { settings, settingsSaving, saveSettings } = settingsStore
const route = useRoute()
const router = useRouter()
const clone = (value: AppSettings): AppSettings => JSON.parse(JSON.stringify(value)) as AppSettings
const baseline = ref(clone(settings.value))
const draft = ref(clone(settings.value))
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(baseline.value))
const profileDirty = ref(false)
const sections = [
  { id: 'general', title: '常规', icon: SettingIcon, description: '设置新任务的输出目录和应用更新偏好。' },
  { id: 'concurrency', title: '运行与并发', icon: ControlPlatformIcon, description: '统一限制任务与网络并发，控制多个任务访问同一站点时的总量。' },
  { id: 'pacing', title: '访问节奏', icon: TimeIcon, description: '让同一站点的请求保持间隔，列表、详情和资源共同遵守。' },
  { id: 'protection', title: '退避与保护', icon: SecuredIcon, description: '遇到临时故障时退避重试，遇到访问限制时保留进度并暂停。' },
  { id: 'network', title: '网络与隐私', icon: InternetIcon, description: '统一浏览器身份与请求语言，保护诊断信息中的敏感内容。' },
  { id: 'profiles', title: '访问配置', icon: SecuredIcon, description: '管理本机访问身份、Cookie 与会话，在任务的基本信息中选择绑定。' }
]
const selected = computed(() => sections.find(item => item.id === route.params.section) ?? sections[0]!)
const leaveVisible = ref(false)
let leaveDecision: ((value: boolean) => void) | null = null
const decideLeave = (value: boolean): void => {
  leaveVisible.value = false
  leaveDecision?.(value)
  leaveDecision = null
}
onBeforeRouteLeave(() => {
  if (!dirty.value && !profileDirty.value) return true
  return new Promise<boolean>(resolve => { leaveDecision = resolve; leaveVisible.value = true })
})
const resetDraft = (): void => { baseline.value = clone(settings.value); draft.value = clone(settings.value) }
watch(settings, () => { if (!dirty.value) resetDraft() }, { deep: true })
const save = async (): Promise<void> => {
  const value = clone(settings.value)
  for (const key of ['defaultOutputDirectory', 'maxConcurrentRuns', 'autoCheckUpdates'] as const) {
    if (draft.value[key] !== baseline.value[key]) Object.assign(value, { [key]: draft.value[key] })
  }
  for (const key of Object.keys(draft.value.access) as Array<keyof AppSettings['access']>) {
    if (draft.value.access[key] !== baseline.value.access[key]) Object.assign(value.access, { [key]: draft.value.access[key] })
  }
  if (await saveSettings(value)) resetDraft()
}
const chooseDirectory = async (): Promise<void> => {
  const path = await window.collector.chooseOutputDirectory()
  if (path) draft.value.defaultOutputDirectory = path
}
</script>

<template>
  <div class="settings-page">
    <header class="settings-header">
      <div><span>应用设置</span><h1>全局配置</h1></div>
      <t-button v-if="selected.id !== 'profiles'" theme="default" variant="outline" :disabled="settingsSaving" @click="draft = clone(DEFAULT_SETTINGS)">恢复默认设置</t-button>
    </header>
    <div class="settings-layout">
      <nav class="settings-navigation" aria-label="设置分类">
        <span class="navigation-caption">设置分类</span>
        <t-button
          v-for="section in sections" :key="section.id" theme="default" variant="text"
          :class="{ selected: selected.id === section.id }" :aria-current="selected.id === section.id ? 'page' : undefined"
          @click="router.replace({ name: 'settings', params: { section: section.id } })"
        >
          <template #icon><component :is="section.icon" /></template>{{ section.title }}
        </t-button>
        <div class="settings-nav-divider" />
        <t-button theme="default" variant="text" @click="openAboutDialog"><template #icon><HelpCircleIcon /></template>关于与更新</t-button>
      </nav>
      <div class="settings-main">
        <div class="settings-scroll">
          <div class="settings-content">
            <h2>{{ selected.title }}</h2><p class="settings-description">{{ selected.description }}</p>
            <template v-if="selected.id === 'general'">
              <section class="settings-section">
                <h3>默认输出</h3>
                <div class="setting-row">
                  <div class="setting-copy"><strong>默认输出目录</strong><p>新建任务自动使用此目录，已有任务保持各自配置。</p></div>
                  <div class="directory-control">
                    <t-input v-model="draft.defaultOutputDirectory" aria-label="默认输出目录" placeholder="尚未设置" clearable />
                    <t-button theme="default" variant="outline" aria-label="选择默认输出目录" @click="chooseDirectory"><template #icon><FolderOpenIcon /></template></t-button>
                  </div>
                </div>
              </section>
              <section class="settings-section">
                <h3>应用更新</h3>
                <div class="setting-row"><div class="setting-copy"><strong>启动时自动检查更新</strong><p>启动后检查 GitHub Releases，有新版本时在顶部提示。</p></div><t-switch v-model="draft.autoCheckUpdates" aria-label="启动时自动检查更新" /></div>
                <div class="setting-row"><div class="setting-copy"><strong>关于与更新</strong><p>查看版本信息、手动检查更新和下载安装包。</p></div><t-button theme="primary" variant="text" @click="openAboutDialog">打开关于与更新</t-button></div>
              </section>
            </template>
            <SettingsPolicy v-else-if="selected.id !== 'profiles'" v-model="draft" :section="selected.id" />
            <SettingsProfiles v-show="selected.id === 'profiles'" v-model:dirty="profileDirty" />
          </div>
        </div>
        <footer class="settings-footer">
          <span :class="{ 'has-changes': dirty || profileDirty }">{{ dirty || profileDirty ? '有未保存的更改' : selected.id === 'profiles' ? '访问配置使用独立保存按钮；Cookie 不随任务导出' : '设置保存在本机，不随任务配置导出' }}</span>
          <div v-if="selected.id !== 'profiles'">
            <t-button theme="default" variant="outline" :disabled="!dirty || settingsSaving" @click="resetDraft">取消更改</t-button>
            <t-button theme="primary" :disabled="!dirty" :loading="settingsSaving" @click="save">保存设置</t-button>
          </div>
        </footer>
      </div>
    </div>
    <t-dialog
      :visible="leaveVisible" header="设置尚未保存" body="离开设置页会丢弃未保存的更改。" confirm-btn="丢弃并离开" cancel-btn="继续编辑"
      @confirm="decideLeave(true)" @cancel="decideLeave(false)" @close="decideLeave(false)"
    />
  </div>
</template>

<style src="./style.css"></style>
