<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { VNodeRef } from 'vue'
import { CloseIcon, FolderOpenIcon } from 'tdesign-icons-vue-next'
import type { RunLog, RunProgress, RunResult, RunSessionItem } from '@shared/types'
import { isRunItemLocked } from '@renderer/utils/collector-runtime'
import { resizeRunLogHeight, RUN_LOG_LAYOUT } from '@renderer/utils/pane-layout'

interface RunLogResizeStart {
  pointerId: number
  startY: number
  startHeight: number
  handle: HTMLElement
}

const props = defineProps<{
  item: RunSessionItem | null
  runActionTaskId: string
  runLogHeight: number
  runLogMaxHeight: number
  surfaceRef: VNodeRef
}>()

const emit = defineEmits<{
  dismiss: []
  pause: []
  resume: []
  cancel: []
  'open-output': []
  'open-error': []
  'resize-log': [value: number]
}>()

const runLogsElement = ref<HTMLElement | null>(null)
let runLogResizeStart: RunLogResizeStart | null = null

const selectedRunLocked = computed(() => isRunItemLocked(props.item ?? undefined))
const runProgress = computed<RunProgress | null>(() => props.item?.progress ?? null)
const runResult = computed<RunResult | null>(() => props.item?.result ?? null)
const runLogs = computed<RunLog[]>(() => props.item?.logs ?? [])

const scrollLogsToEnd = (): void => {
  void nextTick(() => {
    const element = runLogsElement.value
    if (element) element.scrollTop = element.scrollHeight
  })
}

// 日志条目变化时自动滚动到底部（与 RunCenter 的做法一致）
watch(
  () => [props.item?.taskId, props.item?.logs.length],
  scrollLogsToEnd
)

onMounted(scrollLogsToEnd)

const startRunLogResize = (event: PointerEvent): void => {
  if (event.button !== 0) return
  const handle = event.currentTarget
  if (!(handle instanceof HTMLElement)) return
  event.preventDefault()
  handle.setPointerCapture(event.pointerId)
  runLogResizeStart = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight: props.runLogHeight,
    handle
  }
  document.body.classList.add('run-log-resizing')
}

const handleRunLogResize = (event: PointerEvent): void => {
  if (!runLogResizeStart || event.pointerId !== runLogResizeStart.pointerId) return
  emit('resize-log', resizeRunLogHeight(
    runLogResizeStart.startHeight,
    event.clientY - runLogResizeStart.startY,
    window.innerHeight
  ))
}

const stopRunLogResize = (event: PointerEvent): void => {
  if (!runLogResizeStart || event.pointerId !== runLogResizeStart.pointerId) return
  if (runLogResizeStart.handle.hasPointerCapture(event.pointerId)) {
    runLogResizeStart.handle.releasePointerCapture(event.pointerId)
  }
  runLogResizeStart = null
  document.body.classList.remove('run-log-resizing')
}

const resizeRunLogWithKeyboard = (event: KeyboardEvent): void => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') {
    emit('resize-log', RUN_LOG_LAYOUT.minHeight)
    return
  }
  if (event.key === 'End') {
    emit('resize-log', props.runLogMaxHeight)
    return
  }
  emit('resize-log', resizeRunLogHeight(
    props.runLogHeight,
    event.key === 'ArrowUp' ? -RUN_LOG_LAYOUT.keyboardStep : RUN_LOG_LAYOUT.keyboardStep,
    window.innerHeight
  ))
}
</script>

<template>
  <section :ref="surfaceRef" class="run-drawer">
    <header>
      <div>
        <span>{{ item?.taskName || '采集运行' }}</span>
        <strong>{{ runProgress?.message || runResult?.message || item?.message || '正在准备…' }}</strong>
      </div>
      <t-button theme="default" variant="text" shape="square" @click="emit('dismiss')">
        <CloseIcon />
      </t-button>
    </header>
    <div class="run-body">
      <div class="run-metrics">
        <div><span>当前页</span><strong>{{ runProgress?.page ?? '—' }}</strong></div>
        <div><span>发现</span><strong>{{ runProgress?.counters.discovered ?? runResult?.counters.discovered ?? 0 }}</strong></div>
        <div><span>成功</span><strong>{{ runProgress?.counters.succeeded ?? runResult?.counters.succeeded ?? 0 }}</strong></div>
        <div><span>重复</span><strong>{{ runProgress?.counters.duplicated ?? runResult?.counters.duplicated ?? 0 }}</strong></div>
        <div>
          <span>跳过/失败</span>
          <strong>{{ (runProgress?.counters.skipped ?? runResult?.counters.skipped ?? 0) +
            (runProgress?.counters.failed ?? runResult?.counters.failed ?? 0) }}</strong>
        </div>
        <div><span>资源下载</span><strong>{{ runProgress?.resources.downloaded ?? runResult?.resources.downloaded ?? 0 }}</strong></div>
        <div><span>资源已存在</span><strong>{{ runProgress?.resources.skipped ?? runResult?.resources.skipped ?? 0 }}</strong></div>
        <div><span>资源失败</span><strong>{{ runProgress?.resources.failed ?? runResult?.resources.failed ?? 0 }}</strong></div>
      </div>
      <div class="run-current"><span>{{ runProgress?.currentUrl || runResult?.outputFiles.at(-1) || item?.message || '等待任务开始' }}</span></div>
      <div class="run-log-panel" :style="{ height: `${runLogHeight}px` }">
        <div
          class="run-log-resizer"
          role="separator"
          aria-label="调整运行日志高度"
          aria-orientation="horizontal"
          :aria-valuemin="RUN_LOG_LAYOUT.minHeight"
          :aria-valuemax="runLogMaxHeight"
          :aria-valuenow="runLogHeight"
          tabindex="0"
          title="向上拖动可增大日志区域，也可使用上下方向键"
          @pointerdown="startRunLogResize"
          @pointermove="handleRunLogResize"
          @pointerup="stopRunLogResize"
          @pointercancel="stopRunLogResize"
          @keydown="resizeRunLogWithKeyboard"
        >
          <span>拖动调整日志高度</span>
        </div>
        <div ref="runLogsElement" class="run-logs">
          <p v-if="runLogs.length === 0" class="empty">
            <span>等待运行日志…</span>
          </p>
          <p v-for="(log, index) in runLogs" :key="`${log.time}-${index}`" :class="log.level">
            <time>{{ new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false }) }}</time>
            <span>{{ log.message }}</span>
          </p>
        </div>
      </div>
      <div class="run-controls">
        <template v-if="selectedRunLocked">
          <t-button
            v-if="item && ['preparing', 'running'].includes(item.status)"
            theme="default"
            variant="outline"
            :loading="runActionTaskId === item.taskId"
            @click="emit('pause')"
          >
            暂停
          </t-button>
          <t-button
            v-else-if="item?.status === 'paused'"
            theme="primary"
            :loading="runActionTaskId === item.taskId"
            @click="emit('resume')"
          >
            继续
          </t-button>
          <t-button
            theme="danger"
            variant="outline"
            :disabled="item?.status === 'pausing'"
            :loading="runActionTaskId === item?.taskId"
            @click="emit('cancel')"
          >
            取消
          </t-button>
        </template>
        <template v-else>
          <t-button theme="primary" @click="emit('open-output')">
            <template #icon>
              <FolderOpenIcon />
            </template>
            打开输出目录
          </t-button>
          <t-button theme="default" variant="outline" :disabled="!runResult?.errorLogPath" @click="emit('open-error')">
            打开错误日志
          </t-button>
        </template>
      </div>
    </div>
  </section>
</template>

<style src="./style.css"></style>
