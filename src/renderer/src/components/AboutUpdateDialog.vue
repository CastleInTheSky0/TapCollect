<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  CheckCircleIcon,
  CloudDownloadIcon,
  CpuIcon,
  DesktopIcon,
  LogoGithubIcon,
  RefreshIcon
} from 'tdesign-icons-vue-next'
import type {
  AppRuntimeInfo,
  CollectorApi,
  DownloadedUpdate,
  UpdateCheckResult,
  UpdateDownloadProgress
} from '@shared/types'
import appIconUrl from '../assets/tapcollect-icon.png'

const props = defineProps<{
  visible: boolean
  api: CollectorApi
}>()

const emit = defineEmits<{
  'update:visible': [visible: boolean]
}>()

type UpdateAction = '' | 'runtime' | 'checking' | 'downloading' | 'installing'

const runtimeInfo = ref<AppRuntimeInfo | null>(null)
const checkResult = ref<UpdateCheckResult | null>(null)
const downloadProgress = ref<UpdateDownloadProgress | null>(null)
const downloadedUpdate = ref<DownloadedUpdate | null>(null)
const action = ref<UpdateAction>('')
const errorMessage = ref('')
const infoMessage = ref('')
const openingRelease = ref(false)
let runtimeRequest: Promise<void> | null = null

const platformTarget = computed(() => {
  if (!runtimeInfo.value) return ''
  return `${runtimeInfo.value.platformLabel} ${runtimeInfo.value.architectureLabel}`
})
const updateAvailable = computed(() => checkResult.value?.status === 'available')
const downloadDisabled = computed(() =>
  action.value !== '' ||
  runtimeInfo.value?.developmentPreview ||
  !updateAvailable.value ||
  !checkResult.value?.release.asset
)

const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** unitIndex
  return `${amount >= 100 || unitIndex === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unitIndex]}`
}
const messageFromError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const loadRuntimeInfo = async (): Promise<void> => {
  if (runtimeInfo.value || runtimeRequest) return runtimeRequest ?? Promise.resolve()
  action.value = 'runtime'
  runtimeRequest = props.api.getAppRuntimeInfo()
    .then((info) => {
      runtimeInfo.value = info
    })
    .catch((error) => {
      errorMessage.value = messageFromError(error)
    })
    .finally(() => {
      if (action.value === 'runtime') action.value = ''
      runtimeRequest = null
    })
  return runtimeRequest
}

const checkForUpdates = async (): Promise<void> => {
  if (action.value) return
  action.value = 'checking'
  errorMessage.value = ''
  infoMessage.value = ''
  downloadProgress.value = null
  downloadedUpdate.value = null
  try {
    checkResult.value = await props.api.checkForUpdates()
  } catch (error) {
    errorMessage.value = messageFromError(error)
  } finally {
    action.value = ''
  }
}

const downloadUpdate = async (): Promise<void> => {
  if (downloadDisabled.value) return
  action.value = 'downloading'
  errorMessage.value = ''
  infoMessage.value = ''
  try {
    downloadedUpdate.value = await props.api.downloadUpdate()
  } catch (error) {
    errorMessage.value = messageFromError(error)
  } finally {
    action.value = ''
  }
}

const installUpdate = async (): Promise<void> => {
  if (!downloadedUpdate.value || action.value) return
  action.value = 'installing'
  errorMessage.value = ''
  infoMessage.value = ''
  try {
    const result = await props.api.installUpdate(downloadedUpdate.value.downloadId)
    if (result.cancelled) infoMessage.value = '已取消安装，下载好的安装包仍可再次使用。'
  } catch (error) {
    errorMessage.value = messageFromError(error)
  } finally {
    action.value = ''
  }
}

const openReleasePage = async (): Promise<void> => {
  if (openingRelease.value) return
  openingRelease.value = true
  errorMessage.value = ''
  try {
    await props.api.openUpdateRelease()
  } catch (error) {
    errorMessage.value = messageFromError(error)
  } finally {
    openingRelease.value = false
  }
}

const closeDialog = (): void => emit('update:visible', false)
const removeProgressListener = props.api.onUpdateDownloadProgress((progress) => {
  downloadProgress.value = progress
})

watch(
  () => props.visible,
  (visible) => {
    if (visible) void loadRuntimeInfo()
  },
  { immediate: true }
)
onBeforeUnmount(removeProgressListener)
</script>

<template>
  <t-dialog
    :visible="visible"
    class="about-update-dialog"
    dialog-class-name="about-update-dialog-card"
    width="540px"
    :footer="false"
    :header="false"
    :close-on-overlay-click="action !== 'installing'"
    :confirm-on-enter="false"
    @close="closeDialog"
  >
    <div class="about-shell">
      <header class="about-heading">
        <img :src="appIconUrl" alt="" />
        <div>
          <span>TapCollect</span>
          <h2>关于与更新</h2>
          <p>网页信息采集与模板化输出工具</p>
        </div>
      </header>

      <section class="runtime-strip" :aria-busy="action === 'runtime'">
        <div>
          <span>当前版本</span>
          <strong>{{ runtimeInfo ? `v${runtimeInfo.version}` : '正在读取…' }}</strong>
        </div>
        <div class="runtime-tags">
          <span>
            <DesktopIcon />{{ runtimeInfo?.platformLabel || '—' }}
          </span>
          <span>
            <CpuIcon />{{ runtimeInfo?.architectureLabel || '—' }}
          </span>
        </div>
      </section>

      <section class="update-panel" aria-live="polite">
        <t-alert v-if="errorMessage" theme="error" :message="errorMessage" close @close="errorMessage = ''" />
        <t-alert v-if="infoMessage" theme="info" :message="infoMessage" close @close="infoMessage = ''" />

        <div v-if="action === 'checking'" class="update-centered">
          <t-loading size="small" />
          <div><strong>正在检查新版本…</strong><span>正在连接 GitHub Releases</span></div>
        </div>

        <template v-else-if="downloadedUpdate">
          <div class="update-ready">
            <span class="ready-icon">
              <CheckCircleIcon />
            </span>
            <div>
              <strong>更新已下载并校验完成</strong>
              <span>{{ downloadedUpdate.fileName }} · {{ formatBytes(downloadedUpdate.size) }}</span>
            </div>
          </div>
          <t-button block theme="primary" :loading="action === 'installing'" @click="installUpdate">
            立即安装
          </t-button>
          <small class="install-note">安装前会确认；有运行中任务时会先保存安全检查点。</small>
        </template>

        <template v-else-if="action === 'downloading'">
          <div class="download-heading">
            <strong>正在下载安装包</strong>
            <span>{{ downloadProgress?.percentage ?? 0 }}%</span>
          </div>
          <t-progress :percentage="downloadProgress?.percentage ?? 0" :label="false" />
          <div class="download-meta">
            <span>{{ downloadProgress?.fileName || checkResult?.release.asset?.name }}</span>
            <span>{{ formatBytes(downloadProgress?.receivedBytes ?? 0) }} / {{ formatBytes(downloadProgress?.totalBytes
              ?? checkResult?.release.asset?.size ?? 0) }}</span>
          </div>
        </template>

        <template v-else-if="checkResult">
          <div class="release-heading">
            <div>
              <span>{{ checkResult.status === 'up-to-date' ? '版本状态' : '最新版本' }}</span>
              <strong>v{{ checkResult.release.version }}</strong>
            </div>
            <t-tag
              :theme="checkResult.status === 'available' ? 'primary' : checkResult.status === 'up-to-date' ? 'success' : 'warning'"
              variant="light"
            >
              {{ checkResult.status === 'available' ? `适用于 ${platformTarget}` : checkResult.status === 'up-to-date' ?
                '已是最新版本' : '无匹配安装包' }}
            </t-tag>
          </div>

          <div class="release-notes">
            <strong>更新简述</strong>
            <p>{{ checkResult.release.hasSummary ? checkResult.release.summary : '该版本未提供更新简述' }}</p>
            <t-link theme="primary" hover="color" :disabled="openingRelease" @click="openReleasePage">
              查看完整更新说明
            </t-link>
          </div>

          <t-alert
            v-if="runtimeInfo?.developmentPreview && updateAvailable"
            theme="info"
            message="本地开发预览仅用于检查和展示更新；正式安装包中才可下载安装。"
          />
          <t-button v-if="updateAvailable" block theme="primary" :disabled="downloadDisabled" @click="downloadUpdate">
            <template #icon>
              <CloudDownloadIcon />
            </template>
            下载更新<span v-if="checkResult.release.asset"> · {{ formatBytes(checkResult.release.asset.size) }}</span>
          </t-button>
          <t-button v-else block theme="default" variant="outline" @click="checkForUpdates">
            <template #icon>
              <RefreshIcon />
            </template>
            重新检查
          </t-button>
        </template>

        <div v-else class="update-idle">
          <div class="idle-copy">
            <RefreshIcon />
            <div><strong>手动检查更新</strong><span>仅在点击按钮后连接 GitHub Releases</span></div>
          </div>
          <t-button theme="primary" :disabled="action === 'runtime'" @click="checkForUpdates">检查更新</t-button>
        </div>
      </section>

      <footer class="about-footer">
        <t-link theme="primary" hover="color" :disabled="openingRelease" @click="openReleasePage">
          <template #prefix-icon>
            <LogoGithubIcon />
          </template>
          GitHub Releases
        </t-link>
        <span>数据始终保存在本机</span>
      </footer>
    </div>
  </t-dialog>
</template>

<style scoped>
:global(.about-update-dialog-card.t-dialog--default) {
  padding: 24px;
}

:global(.about-update-dialog-card .t-dialog__header) {
  position: absolute;
  top: 24px;
  right: 24px;
  z-index: 1;
}

:global(.about-update-dialog-card .t-dialog__header-content) {
  display: none;
}

:global(.about-update-dialog-card .t-dialog__body) {
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0;
  scrollbar-width: none;
}

:global(.about-update-dialog-card .t-dialog__body::-webkit-scrollbar) {
  display: none;
  width: 0;
  height: 0;
}

.about-shell {
  margin: 0;
  overflow: hidden;
  border-radius: var(--td-radius-large);
}

.about-heading {
  display: flex;
  align-items: center;
  gap: 15px;
  padding: 0 36px 16px 0;
}

.about-heading img {
  width: 54px;
  height: 54px;
  flex: 0 0 auto;
  border-radius: 14px;
  box-shadow: 0 9px 22px rgba(24, 74, 80, 0.2);
}

.about-heading span {
  color: var(--muted);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.about-heading h2 {
  margin: 3px 0 2px;
  font-size: 21px;
  font-weight: 650;
  letter-spacing: -0.025em;
}

.about-heading p {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
}

.runtime-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin: 0;
  padding: 13px 15px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #f6f9f9;
}

.runtime-strip>div:first-child span,
.runtime-strip>div:first-child strong {
  display: block;
}

.runtime-strip>div:first-child span {
  color: var(--muted);
  font-size: 9px;
}

.runtime-strip>div:first-child strong {
  margin-top: 3px;
  font-size: 16px;
}

.runtime-tags {
  display: flex;
  align-items: center;
  gap: 13px;
}

.runtime-tags span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #53686d;
  font-size: 10px;
}

.runtime-tags svg {
  color: var(--accent);
}

.update-panel {
  display: flex;
  margin: 16px 0 20px;
  padding: 14px 15px;
  border: 1px solid var(--line);
  border-radius: 9px;
  flex-direction: column;
  gap: 12px;
}

.update-idle,
.update-centered,
.idle-copy,
.update-ready {
  display: flex;
  align-items: center;
}

.update-idle {
  min-height: 50px;
  justify-content: space-between;
  gap: 16px;
}

.idle-copy,
.update-ready {
  min-width: 0;
  gap: 11px;
}

.idle-copy>svg {
  flex: 0 0 auto;
  color: var(--accent);
  font-size: 22px;
}

.idle-copy strong,
.idle-copy span,
.update-centered strong,
.update-centered span,
.update-ready>div>strong,
.update-ready>div>span {
  display: block;
}

.idle-copy strong,
.update-centered strong,
.update-ready>div>strong {
  font-size: 11px;
}

.idle-copy span,
.update-centered span,
.update-ready>div>span {
  margin-top: 4px;
  color: var(--muted);
  font-size: 9px;
}

.update-centered {
  min-height: 50px;
  justify-content: center;
  gap: 12px;
}

.release-heading,
.download-heading,
.download-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.release-heading>div span,
.release-heading>div strong {
  display: block;
}

.release-heading>div span {
  color: var(--muted);
  font-size: 9px;
}

.release-heading>div strong {
  margin-top: 3px;
  font-size: 17px;
}

.release-notes {
  padding: 9px 11px;
  border-left: 3px solid var(--accent);
  background: #f4f8f8;
}

.release-notes>strong {
  font-size: 10px;
}

.release-notes p {
  margin: 5px 0 4px;
  color: #5e7075;
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.release-notes :deep(.t-link) {
  font-size: 9px;
}

.download-heading strong {
  font-size: 11px;
}

.download-heading span {
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}

.download-meta {
  color: var(--muted);
  font-size: 9px;
}

.download-meta span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-meta span:last-child {
  flex: 0 0 auto;
}

.ready-icon {
  display: inline-flex;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #dff1e8;
  color: var(--success);
  font-size: 24px;
  line-height: 1;
}

.ready-icon>svg {
  display: block;
  width: 1em;
  height: 1em;
}

.install-note {
  color: var(--muted);
  font-size: 9px;
  text-align: center;
}

.about-footer {
  display: flex;
  min-height: 47px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 12px;
  border-top: 1px solid var(--line);
  background: #f8fafa;
  color: var(--muted);
  font-size: 9px;
}

.about-footer :deep(.t-link) {
  font-size: 9px;
}
</style>
