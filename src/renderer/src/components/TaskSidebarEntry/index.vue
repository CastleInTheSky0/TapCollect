<script setup lang="ts">
import { computed, ref } from 'vue'
import { CopyIcon, DeleteIcon, EllipsisIcon, FolderMoveIcon, PlayIcon } from 'tdesign-icons-vue-next'
import type { RunSessionItem, TaskSummary } from '@shared/types'
import { isRunItemLocked } from '@renderer/utils/collector-runtime'

const props = defineProps<{
  task: TaskSummary
  runItem: RunSessionItem | null
  testing: boolean
  disabled: boolean
  groupDisabled: boolean
  batchMode: boolean
  checked: boolean
}>()
const emit = defineEmits<{
  select: [id: string]; run: [id: string]; duplicate: [id: string]; remove: [id: string]
  move: [id: string]; toggleSelection: [id: string]
}>()
const menuOpen = ref(false)
const locked = computed(() => props.testing || isRunItemLocked(props.runItem))
const runDisabled = computed(() => props.disabled || props.testing || (props.runItem?.status !== 'paused' && locked.value))
const statusLabel = computed(() => {
  if (props.testing) return '测试中'
  const item = props.runItem
  if (!item) return props.task.hasCheckpoint ? '可续采' : ''
  if (item.protection) return item.protection.kind === 'cooling' ? '冷却中' : '需要人工处理'
  if (item.status === 'queued') return `排队 ${item.queuePosition}`
  return { preparing: '准备中', running: '运行中', pausing: '暂停中', paused: '已暂停',
    completed: '已完成', cancelled: '已取消', failed: '失败' }[item.status]
})
const statusTheme = computed(() => {
  if (props.testing || ['running', 'preparing'].includes(props.runItem?.status ?? '')) return 'primary'
  if (props.runItem?.status === 'completed') return 'success'
  if (['failed', 'cancelled'].includes(props.runItem?.status ?? '')) return 'danger'
  return 'warning'
})
const shortDate = computed(() => {
  const date = new Date(props.task.updatedAt)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false })
})
</script>

<template>
  <t-menu-item :value="`task:${task.id}`" :data-task-id="task.id" class="task-menu-item" :class="{ 'task-menu-open': menuOpen }">
    <span class="task-entry-shell">
      <span v-if="batchMode" class="task-check" @click.stop @keydown.stop>
        <t-checkbox :checked="checked" :aria-label="`选择 ${task.name}`" @change="emit('toggleSelection', task.id)" />
      </span>
      <button
        type="button" class="task-row-main" :disabled="disabled" :title="`${task.name}\n更新时间：${shortDate}`"
        @click.stop="batchMode ? emit('toggleSelection', task.id) : emit('select', task.id)"
      >
        <span class="task-copy">
          <span class="task-title-line">
            <strong :title="task.name">{{ task.name }}</strong>
            <t-tag v-if="statusLabel" size="small" :theme="statusTheme" variant="light">{{ statusLabel }}</t-tag>
          </span>
          <small :title="task.listUrl">{{ task.listUrl || '尚未填写列表地址' }}</small>
        </span>
      </button>
      <span v-if="!batchMode" class="task-actions" @click.stop @pointerdown.stop @keydown.stop>
        <t-dropdown
          trigger="click" placement="right-top" :min-column-width="176"
          :popup-props="{ overlayInnerClassName: 'task-actions-dropdown', onVisibleChange: (visible: boolean) => menuOpen = visible }"
        >
          <t-tooltip content="任务操作" :visible="menuOpen ? false : undefined">
            <t-button theme="default" variant="text" shape="square" size="small" :aria-label="`${task.name}的任务菜单`">
              <EllipsisIcon size="18px" />
            </t-button>
          </t-tooltip>
          <t-dropdown-menu>
            <t-dropdown-item :disabled="groupDisabled || disabled" @click="emit('move', task.id)">
              <template #prefix-icon><FolderMoveIcon /></template>移动到分组
            </t-dropdown-item>
            <t-dropdown-item :disabled="runDisabled" @click="emit('run', task.id)">
              <template #prefix-icon><PlayIcon /></template>{{ runItem?.status === 'paused' ? '继续任务' : '运行任务' }}
            </t-dropdown-item>
            <t-dropdown-item :divider="true" :disabled="disabled" @click="emit('duplicate', task.id)">
              <template #prefix-icon><CopyIcon /></template>复制任务
            </t-dropdown-item>
            <t-dropdown-item theme="error" :disabled="disabled || locked" @click="emit('remove', task.id)">
              <template #prefix-icon><DeleteIcon /></template>删除任务
            </t-dropdown-item>
          </t-dropdown-menu>
        </t-dropdown>
      </span>
    </span>
  </t-menu-item>
</template>

<style scoped src="./style.css"></style>
