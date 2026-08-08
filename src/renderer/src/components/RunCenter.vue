<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AddIcon, PlayIcon } from 'tdesign-icons-vue-next'
import type { RunSessionItem, RunSessionSnapshot } from '@shared/types'

const props = defineProps<{
  snapshot: RunSessionSnapshot
  selectedTaskId: string
  actionTaskId: string
  batchAction: string
  settingsSaving: boolean
}>()

const emit = defineEmits<{
  select: [taskId: string]
  pause: [taskId: string]
  resume: [taskId: string]
  cancel: [taskId: string]
  pauseAll: []
  resumeAll: []
  cancelAll: []
  changeConcurrency: [value: number]
  create: []
  openOutput: [taskId: string]
  openError: [taskId: string]
}>()

const clock = ref(Date.now())
const logsElement = ref<HTMLElement | null>(null)
let clockTimer: number | null = null

const activeStatuses = new Set<RunSessionItem['status']>([
  'preparing',
  'running',
  'pausing',
  'paused'
])

const activeItems = computed(() =>
  props.snapshot.items.filter((item) => activeStatuses.has(item.status))
)
const queuedItems = computed(() =>
  props.snapshot.items
    .filter((item) => item.status === 'queued')
    .sort((left, right) => left.queuePosition - right.queuePosition)
)
const terminalItems = computed(() =>
  props.snapshot.items
    .filter((item) => ['completed', 'cancelled', 'failed'].includes(item.status))
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt))
)
const pausedCount = computed(() =>
  props.snapshot.items.filter((item) => item.status === 'paused').length
)
const selectedItem = computed(() => {
  const selected = props.snapshot.items.find((item) => item.taskId === props.selectedTaskId)
  return selected ?? activeItems.value[0] ?? queuedItems.value[0] ?? terminalItems.value[0] ?? null
})
const selectedProgress = computed(() => selectedItem.value?.progress ?? null)
const selectedResult = computed(() => selectedItem.value?.result ?? null)
const selectedCounters = computed(
  () => selectedProgress.value?.counters ?? selectedResult.value?.counters ?? null
)
const selectedResources = computed(
  () => selectedProgress.value?.resources ?? selectedResult.value?.resources ?? null
)

const statusLabel = (item: RunSessionItem): string => {
  if (item.status === 'queued') return `排队第 ${item.queuePosition}`
  return {
    preparing: '准备中',
    running: '运行中',
    pausing: '暂停中',
    paused: '已暂停',
    completed: '已完成',
    cancelled: '已取消',
    failed: '失败'
  }[item.status]
}

const statusTheme = (status: RunSessionItem['status']): 'default' | 'primary' | 'success' | 'warning' | 'danger' => {
  if (status === 'running' || status === 'preparing') return 'primary'
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  if (status === 'paused' || status === 'pausing' || status === 'queued') return 'warning'
  return 'default'
}

const progressPercentage = (item: RunSessionItem): number => {
  const progress = item.progress
  if (item.status === 'completed') return 100
  if (!progress || progress.maxPages <= 0) return 0
  return Math.min(99, Math.max(1, Math.round((progress.page / progress.maxPages) * 100)))
}

const formatDuration = (item: RunSessionItem): string => {
  if (!item.startedAt) return '—'
  const start = new Date(item.startedAt).getTime()
  const end = item.finishedAt ? new Date(item.finishedAt).getTime() : clock.value
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

const changeConcurrency = (value: string | number | undefined): void => {
  const numeric = Number(value)
  if (Number.isInteger(numeric)) emit('changeConcurrency', numeric)
}

const scrollLogsToEnd = (): void => {
  void nextTick(() => {
    const element = logsElement.value
    if (element) element.scrollTop = element.scrollHeight
  })
}

watch(
  () => [selectedItem.value?.taskId, selectedItem.value?.logs.length],
  scrollLogsToEnd
)

onMounted(() => {
  clockTimer = window.setInterval(() => {
    clock.value = Date.now()
  }, 1_000)
  scrollLogsToEnd()
})

onBeforeUnmount(() => {
  if (clockTimer !== null) window.clearInterval(clockTimer)
})
</script>

<template>
  <section class="run-center">
    <header class="run-center-header">
      <div>
        <span>运行中心</span>
        <h1>运行中心</h1>
        <p>查看并管理正在运行、暂停和等待中的采集任务。</p>
      </div>
      <div class="run-center-settings">
        <label>
          <span>最大并发任务数</span>
          <t-input-number
            :model-value="snapshot.maxConcurrentRuns"
            theme="column"
            :min="1"
            :max="5"
            :step="1"
            :decimal-places="0"
            :disabled="settingsSaving"
            @change="changeConcurrency"
          />
        </label>
        <t-button theme="primary" @click="emit('create')">
          <template #icon><AddIcon /></template>
          新建采集任务
        </t-button>
      </div>
    </header>

    <div class="run-overview">
      <div><span>并发占用</span><strong>{{ snapshot.activeCount }} / {{ snapshot.maxConcurrentRuns }}</strong></div>
      <div><span>运行中</span><strong>{{ activeItems.length - pausedCount }}</strong></div>
      <div><span>已暂停</span><strong>{{ pausedCount }}</strong></div>
      <div><span>等待中</span><strong>{{ snapshot.queuedCount }}</strong></div>
      <div><span>本次完成</span><strong>{{ terminalItems.filter((item) => item.status === 'completed').length }}</strong></div>
      <div class="overview-actions">
        <t-button
          size="small"
          theme="default"
          variant="outline"
          :loading="batchAction === 'pause'"
          :disabled="!activeItems.some((item) => ['preparing', 'running'].includes(item.status))"
          @click="emit('pauseAll')"
        >
          全部暂停
        </t-button>
        <t-button
          size="small"
          theme="primary"
          variant="outline"
          :loading="batchAction === 'resume'"
          :disabled="pausedCount === 0"
          @click="emit('resumeAll')"
        >
          全部继续
        </t-button>
        <t-button
          size="small"
          theme="danger"
          variant="outline"
          :loading="batchAction === 'cancel'"
          :disabled="snapshot.activeCount + snapshot.queuedCount + pausedCount === 0"
          @click="emit('cancelAll')"
        >
          全部取消
        </t-button>
      </div>
    </div>

    <div class="run-center-scroll">
      <section class="run-section">
        <div class="run-section-heading">
          <strong>运行与暂停 {{ activeItems.length }}</strong>
          <span>任务完成后会自动启动等待队列中的下一项</span>
        </div>
        <div v-if="activeItems.length" class="run-table">
          <div class="run-table-head">
            <span>任务名称</span><span>状态</span><span>采集进度</span><span>当前页面</span><span>成功 / 失败</span><span>运行时间</span><span>操作</span>
          </div>
          <button
            v-for="item in activeItems"
            :key="item.taskId"
            type="button"
            class="run-table-row"
            :class="{ selected: selectedItem?.taskId === item.taskId }"
            @click="emit('select', item.taskId)"
          >
            <span class="run-task-name"><strong>{{ item.taskName }}</strong><small>{{ item.progress?.currentUrl || item.message }}</small></span>
            <span><t-tag size="small" :theme="statusTheme(item.status)" variant="light">{{ statusLabel(item) }}</t-tag></span>
            <span class="run-progress"><t-progress :percentage="progressPercentage(item)" size="small" :label="true" /></span>
            <span>{{ item.progress?.page ?? '—' }} / {{ item.progress?.maxPages ?? '—' }}</span>
            <span>{{ item.progress?.counters.succeeded ?? 0 }} / {{ (item.progress?.counters.skipped ?? 0) + (item.progress?.counters.failed ?? 0) }}</span>
            <span>{{ formatDuration(item) }}</span>
            <span class="row-actions" @click.stop>
              <t-button
                v-if="['preparing', 'running'].includes(item.status)"
                size="small"
                theme="default"
                variant="outline"
                :loading="actionTaskId === item.taskId"
                @click="emit('pause', item.taskId)"
              >暂停</t-button>
              <t-button
                v-else-if="item.status === 'paused'"
                size="small"
                theme="primary"
                :loading="actionTaskId === item.taskId"
                @click="emit('resume', item.taskId)"
              ><template #icon><PlayIcon /></template>继续</t-button>
              <t-button
                size="small"
                theme="danger"
                variant="outline"
                :disabled="item.status === 'pausing'"
                :loading="actionTaskId === item.taskId"
                @click="emit('cancel', item.taskId)"
              >取消</t-button>
            </span>
          </button>
        </div>
        <div v-else class="run-empty">当前没有运行或暂停中的任务。</div>
      </section>

      <section v-if="queuedItems.length" class="run-section">
        <div class="run-section-heading">
          <strong>等待队列 {{ queuedItems.length }}</strong>
          <span>按加入顺序自动运行；输出目录冲突的任务会继续等待</span>
        </div>
        <div class="queue-list">
          <button
            v-for="item in queuedItems"
            :key="item.taskId"
            type="button"
            :class="{ selected: selectedItem?.taskId === item.taskId }"
            @click="emit('select', item.taskId)"
          >
            <strong>{{ String(item.queuePosition).padStart(2, '0') }}</strong>
            <span><b>{{ item.taskName }}</b><small>{{ item.message }}</small></span>
            <t-tag size="small" theme="warning" variant="light">{{ statusLabel(item) }}</t-tag>
            <t-button size="small" theme="danger" variant="text" :loading="actionTaskId === item.taskId" @click.stop="emit('cancel', item.taskId)">取消排队</t-button>
          </button>
        </div>
      </section>

      <section v-if="terminalItems.length" class="run-section">
        <div class="run-section-heading">
          <strong>本次会话结果 {{ terminalItems.length }}</strong>
          <span>关闭应用后清空，磁盘上的 XML、日志和检查点不受影响</span>
        </div>
        <div class="session-results">
          <button
            v-for="item in terminalItems"
            :key="item.taskId"
            type="button"
            :class="{ selected: selectedItem?.taskId === item.taskId }"
            @click="emit('select', item.taskId)"
          >
            <span><strong>{{ item.taskName }}</strong><small>{{ item.message }}</small></span>
            <t-tag size="small" :theme="statusTheme(item.status)" variant="light">{{ statusLabel(item) }}</t-tag>
            <time>{{ formatDuration(item) }}</time>
          </button>
        </div>
      </section>

      <section v-if="selectedItem" class="run-detail">
        <header>
          <div>
            <strong>{{ selectedItem.taskName }} · 实时详情</strong>
            <t-tag size="small" :theme="statusTheme(selectedItem.status)" variant="light">{{ statusLabel(selectedItem) }}</t-tag>
          </div>
          <div>
            <t-button size="small" theme="default" variant="outline" @click="emit('openOutput', selectedItem.taskId)">打开输出目录</t-button>
            <t-button size="small" theme="default" variant="text" :disabled="!selectedResult?.errorLogPath" @click="emit('openError', selectedItem.taskId)">错误日志</t-button>
          </div>
        </header>
        <div class="run-detail-body">
          <div class="run-detail-metrics">
            <div><span>当前页</span><strong>{{ selectedProgress?.page ?? '—' }} / {{ selectedProgress?.maxPages ?? '—' }}</strong></div>
            <div><span>发现</span><strong>{{ selectedCounters?.discovered ?? 0 }}</strong></div>
            <div><span>成功</span><strong>{{ selectedCounters?.succeeded ?? 0 }}</strong></div>
            <div><span>失败/跳过</span><strong>{{ (selectedCounters?.failed ?? 0) + (selectedCounters?.skipped ?? 0) }}</strong></div>
            <div><span>资源下载</span><strong>{{ selectedResources?.downloaded ?? 0 }}</strong></div>
            <div><span>已生成 XML</span><strong>{{ selectedResult?.outputFiles.length ?? 0 }}</strong></div>
            <p><span>当前正在处理</span><code>{{ selectedProgress?.currentUrl || selectedItem.message }}</code></p>
          </div>
          <div class="run-detail-logs">
            <div class="log-heading"><strong>运行日志</strong><span>保留最近 500 条</span></div>
            <div ref="logsElement" class="log-content">
              <p v-if="selectedItem.logs.length === 0">等待运行日志…</p>
              <p v-for="(log, index) in selectedItem.logs" :key="`${log.time}-${index}`" :class="log.level">
                <time>{{ new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false }) }}</time>
                <span>{{ log.message }}</span>
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.run-center {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
}

.run-center-header {
  display: flex;
  min-height: 92px;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 15px 28px;
  border-bottom: 1px solid var(--line);
  background: #fff;
}

.run-center-header > div:first-child > span {
  color: var(--accent);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.12em;
}

.run-center-header h1 {
  margin: 3px 0 2px;
  font-size: 25px;
  letter-spacing: -0.04em;
}

.run-center-header p {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
}

.run-center-settings,
.run-center-settings label {
  display: flex;
  align-items: center;
  gap: 10px;
}

.run-center-settings label > span {
  color: var(--muted);
  font-size: 10px;
}

.run-center-settings :deep(.t-input-number) {
  width: 82px;
}

.run-overview {
  display: grid;
  grid-template-columns: repeat(5, minmax(90px, 135px)) minmax(260px, 1fr);
  align-items: stretch;
  padding: 0 28px;
  border-bottom: 1px solid var(--line);
  background: #fbfcfc;
}

.run-overview > div:not(.overview-actions) {
  padding: 16px 18px 15px 0;
}

.run-overview > div:not(:first-child):not(.overview-actions) {
  padding-left: 18px;
  border-left: 1px solid var(--line);
}

.run-overview span,
.run-overview strong {
  display: block;
}

.run-overview span {
  color: var(--muted);
  font-size: 9px;
}

.run-overview strong {
  margin-top: 4px;
  font-size: 19px;
}

.run-overview > div:first-child strong {
  color: var(--accent);
}

.overview-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
}

.run-center-scroll {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 20px 28px 30px;
}

.run-section + .run-section,
.run-detail {
  margin-top: 18px;
}

.run-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}

.run-section-heading strong {
  font-size: 12px;
}

.run-section-heading span {
  color: var(--muted);
  font-size: 9px;
}

.run-table,
.queue-list,
.session-results,
.run-detail {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}

.run-table {
  overflow-x: auto;
  overflow-y: hidden;
}

.run-table-head,
.run-table-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.25fr) 90px minmax(150px, 1fr) 95px 100px 90px 150px;
  min-width: 930px;
  align-items: center;
  gap: 12px;
}

.run-table-head {
  min-height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  background: #f5f7f7;
  color: #59656a;
  font-size: 9px;
  font-weight: 700;
}

.run-table-row {
  width: 100%;
  min-height: 58px;
  padding: 8px 12px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.run-table-row:last-child {
  border-bottom: 0;
}

.run-table-row:hover,
.run-table-row.selected,
.queue-list > button:hover,
.queue-list > button.selected,
.session-results > button:hover,
.session-results > button.selected {
  background: #f1f8f8;
}

.run-table-row.selected {
  box-shadow: inset 3px 0 0 var(--accent);
}

.run-task-name,
.run-task-name strong,
.run-task-name small {
  display: block;
  min-width: 0;
}

.run-task-name strong {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-task-name small {
  overflow: hidden;
  margin-top: 4px;
  color: var(--muted);
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-progress :deep(.t-progress__info) {
  font-size: 9px;
}

.row-actions {
  display: flex;
  justify-content: flex-end;
  gap: 5px;
}

.run-empty {
  padding: 24px;
  border: 1px dashed #cfd8da;
  border-radius: 8px;
  color: var(--muted);
  font-size: 10px;
  text-align: center;
}

.queue-list > button {
  display: grid;
  width: 100%;
  min-height: 47px;
  grid-template-columns: 42px minmax(0, 1fr) 90px 86px;
  align-items: center;
  gap: 10px;
  padding: 6px 13px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.queue-list > button:last-child,
.session-results > button:last-child {
  border-bottom: 0;
}

.queue-list > button > strong {
  color: #a4b4b8;
  font-size: 17px;
}

.queue-list b,
.queue-list small,
.session-results strong,
.session-results small {
  display: block;
}

.queue-list b,
.session-results strong {
  font-size: 10px;
}

.queue-list small,
.session-results small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 8px;
}

.session-results > button {
  display: grid;
  width: 100%;
  min-height: 45px;
  grid-template-columns: minmax(0, 1fr) 90px 90px;
  align-items: center;
  gap: 12px;
  padding: 7px 13px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.session-results time {
  color: var(--muted);
  font: 9px ui-monospace, monospace;
}

.run-detail > header {
  display: flex;
  min-height: 47px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 0 13px;
  border-bottom: 1px solid var(--line);
}

.run-detail > header > div {
  display: flex;
  align-items: center;
  gap: 8px;
}

.run-detail > header strong {
  font-size: 11px;
}

.run-detail-body {
  display: grid;
  min-height: 210px;
  grid-template-columns: minmax(270px, 38%) minmax(0, 1fr);
}

.run-detail-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  align-content: start;
  gap: 14px 18px;
  padding: 17px;
  border-right: 1px solid var(--line);
}

.run-detail-metrics span,
.run-detail-metrics strong {
  display: block;
}

.run-detail-metrics span {
  color: var(--muted);
  font-size: 8px;
}

.run-detail-metrics strong {
  margin-top: 4px;
  font-size: 16px;
}

.run-detail-metrics p {
  grid-column: 1 / -1;
  margin: 3px 0 0;
  padding-top: 13px;
  border-top: 1px solid var(--line);
}

.run-detail-metrics code {
  display: block;
  overflow-wrap: anywhere;
  margin-top: 6px;
  color: #36545a;
  font-size: 9px;
}

.run-detail-logs {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: #f7f9f9;
}

.log-heading {
  display: flex;
  min-height: 35px;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
}

.log-heading strong {
  font-size: 9px;
}

.log-heading span {
  color: var(--muted);
  font-size: 8px;
}

.log-content {
  min-height: 174px;
  max-height: 280px;
  overflow: auto;
  padding: 10px 12px;
  font: 9px/1.55 ui-monospace, monospace;
}

.log-content p {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: 7px;
  margin: 0 0 3px;
  color: #516166;
}

.log-content time {
  color: #97a5a9;
}

.log-content p > span {
  overflow-wrap: anywhere;
}

.log-content p.success { color: var(--success); }
.log-content p.warning { color: #9b6810; }
.log-content p.error { color: var(--danger); }

@media (max-width: 1280px) {
  .run-overview {
    grid-template-columns: repeat(5, minmax(78px, 1fr));
  }

  .overview-actions {
    grid-column: 1 / -1;
    justify-content: flex-start;
    padding: 0 0 12px;
  }
}
</style>
