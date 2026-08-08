<script setup lang="ts">
import {
  AddIcon,
  CheckCircleFilledIcon,
  CopyIcon,
  DataSearchIcon,
  DeleteIcon,
  PlayIcon
} from 'tdesign-icons-vue-next'
import type { TaskSummary } from '@shared/types'
import appIconUrl from '../assets/tapcollect-icon.png'

defineProps<{
  tasks: TaskSummary[]
  activeId: string
  disabled: boolean
}>()

defineEmits<{
  select: [id: string]
  create: []
  duplicate: [id: string]
  remove: [id: string]
  run: [id: string]
}>()

const shortDate = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <aside class="task-sidebar">
    <div class="brand-block">
      <div class="brand-mark" aria-hidden="true">
        <img :src="appIconUrl" alt="" />
      </div>
      <div class="brand-copy">
        <strong>TapCollect</strong>
        <span>网页列表采集与 XML 输出</span>
      </div>
    </div>

    <t-button
      class="new-task"
      theme="default"
      variant="outline"
      block
      :disabled="disabled"
      @click="$emit('create')"
    >
      <template #icon><AddIcon /></template>
      新建采集任务
    </t-button>

    <div class="task-list-heading">
      <span>采集任务</span>
      <span>{{ tasks.length }}</span>
    </div>

    <div v-if="tasks.length" class="task-list">
      <article
        v-for="item in tasks"
        :key="item.id"
        class="task-row"
        :class="{ active: item.id === activeId }"
        tabindex="0"
        @click="$emit('select', item.id)"
        @keydown.enter="$emit('select', item.id)"
      >
        <div class="task-row-main">
          <div class="task-title-line">
            <strong>{{ item.name }}</strong>
            <t-tag v-if="item.hasCheckpoint" size="small" theme="warning" variant="light">
              可续采
            </t-tag>
          </div>
          <p>{{ item.listUrl || '尚未填写列表地址' }}</p>
          <time>{{ shortDate(item.updatedAt) }}</time>
        </div>
        <div class="task-actions">
          <t-tooltip content="运行任务" placement="top">
            <t-button
              theme="primary"
              variant="text"
              shape="square"
              size="small"
              :disabled="disabled || !item.runnable"
              @click.stop="$emit('run', item.id)"
            >
              <PlayIcon />
            </t-button>
          </t-tooltip>
          <t-tooltip content="复制任务" placement="top">
            <t-button
              theme="default"
              variant="text"
              shape="square"
              size="small"
              :disabled="disabled"
              @click.stop="$emit('duplicate', item.id)"
            >
              <CopyIcon />
            </t-button>
          </t-tooltip>
          <t-tooltip content="删除任务" placement="top">
            <t-button
              theme="danger"
              variant="text"
              shape="square"
              size="small"
              :disabled="disabled"
              @click.stop="$emit('remove', item.id)"
            >
              <DeleteIcon />
            </t-button>
          </t-tooltip>
        </div>
      </article>
    </div>
    <div v-else class="task-empty">
      <DataSearchIcon size="24px" />
      <strong>还没有任务</strong>
      <p>从一个列表页地址开始。</p>
    </div>

    <div class="sidebar-note">
      <CheckCircleFilledIcon size="13px" />
      <span>本地单任务运行 · 数据保存在本机</span>
    </div>
  </aside>
</template>

<style scoped>
.task-sidebar {
  display: flex;
  min-height: 0;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: var(--sidebar-surface);
}

.brand-block {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 20px 16px 17px;
}

.brand-mark {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border-radius: 10px;
  background: transparent;
  box-shadow: 0 7px 18px rgba(24, 34, 42, 0.14);
}

.brand-mark img {
  display: block;
  width: 100%;
  height: 100%;
}

.brand-copy {
  min-width: 0;
}

.brand-copy strong,
.brand-copy span {
  display: block;
}

.brand-copy strong {
  overflow: hidden;
  font-size: 14px;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brand-copy span {
  margin-top: 3px;
  color: var(--muted);
  font-size: 10px;
}

.new-task {
  width: calc(100% - 28px);
  margin: 3px 14px 20px;
}

.task-list-heading {
  display: flex;
  justify-content: space-between;
  padding: 0 17px 8px;
  color: #7a8490;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.task-list {
  min-height: 0;
  overflow: auto;
  padding: 0 8px 14px;
}

.task-row {
  position: relative;
  display: flex;
  min-width: 0;
  gap: 7px;
  margin-bottom: 3px;
  padding: 11px 9px 11px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  outline: none;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
}

.task-row:hover,
.task-row:focus-visible {
  border-color: #d7dde0;
  background: rgba(255, 255, 255, 0.66);
}

.task-row.active {
  border-color: #cbdcdf;
  background: #fff;
  box-shadow: inset 3px 0 0 var(--accent), 0 4px 14px rgba(25, 42, 50, 0.06);
  transform: translateX(1px);
}

.task-row-main {
  min-width: 0;
  flex: 1;
}

.task-title-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.task-title-line strong {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-title-line :deep(.t-tag) {
  height: 18px;
  flex: 0 0 auto;
  padding: 0 5px;
  font-size: 9px;
}

.task-row p {
  overflow: hidden;
  margin: 5px 0 4px;
  color: var(--muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-row time {
  color: #9aa2aa;
  font-size: 9px;
}

.task-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  opacity: 0;
  transition: opacity 120ms ease;
}

.task-row:hover .task-actions,
.task-row:focus-within .task-actions,
.task-row.active .task-actions {
  opacity: 1;
}

.task-actions :deep(.t-button) {
  width: 24px;
  height: 24px;
  min-width: 24px;
  padding: 0;
}

.task-empty {
  display: flex;
  margin: 22px 18px;
  align-items: flex-start;
  flex-direction: column;
  color: #97a0aa;
}

.task-empty strong {
  margin-top: 10px;
  color: #58636c;
  font-size: 12px;
}

.task-empty p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 10px;
}

.sidebar-note {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: auto;
  padding: 14px 17px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 9px;
}

.sidebar-note :deep(svg) {
  color: var(--success);
}
</style>
