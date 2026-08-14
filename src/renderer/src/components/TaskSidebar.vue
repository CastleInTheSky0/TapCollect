<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DropdownOption } from 'tdesign-vue-next/es/dropdown/type'
import {
  AddIcon,
  CopyIcon,
  DataSearchIcon,
  DeleteIcon,
  EllipsisIcon,
  FileIcon,
  FileExportIcon,
  FileImportIcon,
  HelpCircleIcon,
  PlayIcon,
  TaskIcon,
  ViewModuleIcon
} from 'tdesign-icons-vue-next'
import type { RunSessionItem, TaskSummary } from '@shared/types'
import appIconUrl from '../assets/tapcollect-icon.png'

const props = defineProps<{
  tasks: TaskSummary[]
  activeId: string
  view: 'task' | 'run-center'
  runItems: RunSessionItem[]
  testingTaskId: string
  disabled: boolean
  collapsed: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  showRunCenter: []
  create: []
  importConfigs: []
  exportConfigs: []
  duplicate: [id: string]
  remove: [id: string]
  run: [id: string]
  showAbout: []
}>()

const tasksExpanded = ref(true)
const taskConfigToolsOpen = ref(false)
const runItemMap = computed(() =>
  new Map(props.runItems.map((item) => [item.taskId, item] as const))
)
const sessionActivityCount = computed(() =>
  props.runItems.filter((item) =>
    ['queued', 'preparing', 'running', 'pausing', 'paused'].includes(item.status)
  ).length
)
const menuValue = computed(() => {
  if (props.view === 'run-center') return 'run-center'
  return props.activeId ? `task:${props.activeId}` : 'tasks'
})
const expandedMenuValues = computed(() => (tasksExpanded.value ? ['tasks'] : []))

const taskMenuValue = (taskId: string): string => `task:${taskId}`

const emitTaskConfigAction = (key: string): boolean => {
  if (key === 'import-configs') {
    emit('importConfigs')
    return true
  }
  if (key === 'export-configs') {
    emit('exportConfigs')
    return true
  }
  return false
}

const handleMenuChange = (value: string | number): void => {
  const key = String(value)
  if (key === 'create') {
    emit('create')
    return
  }
  if (emitTaskConfigAction(key)) return
  if (key === 'run-center') {
    emit('showRunCenter')
    return
  }
  if (key.startsWith('task:')) emit('select', key.slice(5))
}

const handleTaskConfigToolClick = (option: DropdownOption): void => {
  emitTaskConfigAction(String(option.value ?? ''))
}

const handleTaskConfigToolsVisibleChange = (visible: boolean): void => {
  taskConfigToolsOpen.value = visible
}

const handleMenuExpand = (values: Array<string | number>): void => {
  if (props.collapsed) return
  tasksExpanded.value = values.map(String).includes('tasks')
}

const shortDate = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false })
}

const statusLabel = (taskId: string): string => {
  if (props.testingTaskId === taskId) return '测试中'
  const item = runItemMap.value.get(taskId)
  if (!item) return ''
  if (item.status === 'queued') return `排队 ${item.queuePosition}`
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

const statusTheme = (taskId: string): 'default' | 'primary' | 'success' | 'warning' | 'danger' => {
  if (props.testingTaskId === taskId) return 'primary'
  const status = runItemMap.value.get(taskId)?.status
  if (status === 'running' || status === 'preparing') return 'primary'
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  if (status === 'queued' || status === 'paused' || status === 'pausing') return 'warning'
  return 'default'
}

const taskLocked = (taskId: string): boolean => {
  if (props.testingTaskId === taskId) return true
  const status = runItemMap.value.get(taskId)?.status
  return Boolean(status && ['queued', 'preparing', 'running', 'pausing', 'paused'].includes(status))
}

const runDisabled = (taskId: string): boolean => {
  const status = runItemMap.value.get(taskId)?.status
  return (
    props.disabled ||
    props.testingTaskId === taskId ||
    Boolean(status && status !== 'paused' && taskLocked(taskId))
  )
}
</script>

<template>
  <aside class="task-sidebar" :class="{ collapsed }">
    <t-menu class="task-menu" theme="light" :collapsed="collapsed" :width="['100%', '64px']" :value="menuValue"
      :expanded="expandedMenuValues" expand-type="normal" @change="handleMenuChange" @expand="handleMenuExpand">
      <template #logo>
        <div class="brand-block">
          <div class="brand-mark" aria-hidden="true">
            <img :src="appIconUrl" alt="" />
          </div>
          <div class="brand-copy">
            <strong>TapCollect</strong>
            <span>网页列表采集与模板化输出</span>
          </div>
        </div>
      </template>

      <t-menu-item value="create" class="primary-menu-item" :disabled="disabled">
        <template #icon>
          <AddIcon />
        </template>
        新建采集任务
      </t-menu-item>

      <t-submenu value="tasks" class="tasks-submenu" :popup-props="{ overlayClassName: 'task-sidebar-popup' }">
        <template #icon>
          <TaskIcon />
        </template>
        <template #title>
          <span class="task-management-title">
            <span class="task-management-label">
              <span>任务管理</span>
              <span class="menu-count">{{ tasks.length }}</span>
            </span>
            <span v-if="!collapsed" class="task-config-tools" @click.stop @pointerdown.stop @keydown.stop>
              <t-dropdown trigger="click" placement="right-top" :disabled="disabled" :min-column-width="206"
                :popup-props="{
                  overlayInnerClassName: 'task-config-tools-dropdown',
                  onVisibleChange: handleTaskConfigToolsVisibleChange
                }" @click="handleTaskConfigToolClick">
                <span class="task-config-tools-trigger">
                  <t-tooltip content="任务配置工具" placement="top" :visible="taskConfigToolsOpen ? false : undefined">
                    <t-button aria-label="任务配置工具" theme="default" variant="text" shape="square" size="small"
                      :disabled="disabled">
                      <template #icon>
                        <EllipsisIcon size="17px" />
                      </template>
                    </t-button>
                  </t-tooltip>
                </span>
                <t-dropdown-menu>
                  <t-dropdown-item value="import-configs">
                    <template #prefix-icon>
                      <FileImportIcon size="16px" />
                    </template>
                    导入任务配置
                  </t-dropdown-item>
                  <t-dropdown-item value="export-configs">
                    <template #prefix-icon>
                      <FileExportIcon size="16px" />
                    </template>
                    导出全部任务配置
                  </t-dropdown-item>
                </t-dropdown-menu>
              </t-dropdown>
            </span>
          </span>
        </template>

        <t-menu-item v-if="collapsed" value="import-configs" class="task-config-popup-item" :disabled="disabled">
          <template #icon>
            <FileImportIcon />
          </template>
          导入任务配置
        </t-menu-item>

        <t-menu-item v-if="collapsed" value="export-configs" class="task-config-popup-item task-config-popup-item-last"
          :disabled="disabled">
          <template #icon>
            <FileExportIcon />
          </template>
          导出全部任务配置
        </t-menu-item>

        <t-menu-item v-for="item in tasks" :key="item.id" :value="taskMenuValue(item.id)" class="task-menu-item">
          <template #icon>
            <FileIcon />
          </template>
          <span class="task-entry-shell">
            <button type="button" class="task-row-main" @click.stop="emit('select', item.id)">
              <span class="task-copy">
                <span class="task-title-line">
                  <strong>{{ item.name }}</strong>
                  <t-tag v-if="statusLabel(item.id)" size="small" :theme="statusTheme(item.id)" variant="light">
                    {{ statusLabel(item.id) }}
                  </t-tag>
                  <t-tag v-else-if="item.hasCheckpoint" size="small" theme="warning" variant="light">
                    可续采
                  </t-tag>
                </span>
                <small>{{ item.listUrl || '尚未填写列表地址' }}</small>
                <time>{{ shortDate(item.updatedAt) }}</time>
              </span>
            </button>
            <span class="task-actions">
              <t-tooltip :content="runItemMap.get(item.id)?.status === 'paused' ? '继续任务' : '运行任务'" placement="top">
                <t-button theme="primary" variant="text" shape="square" size="small" :disabled="runDisabled(item.id)"
                  @click.stop="emit('run', item.id)">
                  <template #icon>
                    <PlayIcon size="18px" />
                  </template>
                </t-button>
              </t-tooltip>
              <t-tooltip content="复制任务" placement="top">
                <t-button theme="default" variant="text" shape="square" size="small" :disabled="disabled"
                  @click.stop="emit('duplicate', item.id)">
                  <template #icon>
                    <CopyIcon size="18px" />
                  </template>
                </t-button>
              </t-tooltip>
              <t-tooltip content="删除任务" placement="top">
                <t-button theme="danger" variant="text" shape="square" size="small"
                  :disabled="disabled || taskLocked(item.id)" @click.stop="emit('remove', item.id)">
                  <template #icon>
                    <DeleteIcon size="18px" />
                  </template>
                </t-button>
              </t-tooltip>
            </span>
          </span>
        </t-menu-item>

        <t-menu-item v-if="tasks.length === 0" value="empty" class="task-empty-item" disabled>
          <template #icon>
            <DataSearchIcon />
          </template>
          <span class="task-empty">
            <strong>还没有任务</strong>
            <small>从一个列表页地址开始。</small>
          </span>
        </t-menu-item>
      </t-submenu>

      <t-menu-item value="run-center" class="primary-menu-item">
        <template #icon>
          <ViewModuleIcon />
        </template>
        <span class="menu-label">
          <span>运行中心</span>
          <span v-if="sessionActivityCount" class="menu-count active-count">
            {{ sessionActivityCount }}
          </span>
        </span>
      </t-menu-item>

      <template #operations>
        <div class="sidebar-operations">
          <t-tooltip
            content="关于与更新"
            placement="right"
            :disabled="!collapsed"
            :visible="collapsed ? undefined : false"
          >
            <t-button class="about-entry" theme="default" variant="text" @click="emit('showAbout')">
              <template #icon>
                <HelpCircleIcon />
              </template>
              <span v-if="!collapsed">关于与更新</span>
            </t-button>
          </t-tooltip>
          <t-tooltip
            content="本地多任务运行 · 数据保存在本机"
            placement="right"
            :disabled="!collapsed"
            :visible="collapsed ? undefined : false"
          >
            <div class="sidebar-note">
              <span class="status-dot" />
              <span v-if="!collapsed">本地多任务运行 · 数据保存在本机</span>
            </div>
          </t-tooltip>
        </div>
      </template>
    </t-menu>
  </aside>
</template>

<style scoped>
.task-sidebar {
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: var(--sidebar-surface);
}

.task-menu {
  height: 100%;
  background: var(--sidebar-surface);
  --td-brand-color: var(--accent);
  --td-brand-color-light: #e9f4f4;
}

.task-menu :deep(.t-default-menu__inner),
.task-menu :deep(.t-menu) {
  background: var(--sidebar-surface);
}

.task-menu :deep(.t-menu__logo > *) {
  margin-left: 0;
}

.task-menu :deep(.t-menu) {
  padding: 10px 8px;
}

.task-menu :deep(.t-menu__item) {
  border-radius: 8px;
}

.task-menu :deep(.primary-menu-item.t-menu__item) {
  min-height: 42px;
}

.task-menu :deep(.tasks-submenu > .t-menu__sub .task-menu-item) {
  padding-left: 44px;
}

:deep(.t-menu__content) {
  flex: 1;
}

.brand-block {
  display: flex;
  width: 100%;
  height: 64px;
  align-items: center;
  gap: 11px;
  padding: 0 13px;
  overflow: hidden;
}

.brand-mark {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border-radius: 10px;
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
  color: var(--ink);
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

.collapsed .brand-block {
  justify-content: center;
  padding: 0;
}

.collapsed .brand-copy {
  display: none;
}

.menu-label {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-management-title,
.task-management-label {
  display: flex;
  min-width: 0;
  align-items: center;
}

.task-management-title {
  flex: 1;
  gap: 5px;
}

.task-management-label {
  flex: 1;
  gap: 7px;
}

.task-config-tools,
.task-config-tools-trigger {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
}

.task-config-tools {
  margin-right: 4px;
}

.task-config-tools :deep(.t-button) {
  width: 24px;
  height: 24px;
  min-width: 24px;
  padding: 0;
  border-radius: 6px;
  color: #63767d;
}

.task-config-tools :deep(.t-button:hover) {
  background: #dceced;
  color: var(--accent);
}

.menu-count {
  display: grid;
  width: auto;
  min-width: 20px;
  height: 20px;
  flex: 0 0 auto;
  place-items: center;
  padding: 0 5px;
  border-radius: 10px;
  background: #dde8e9;
  color: #52666b;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.active-count {
  background: var(--accent);
  color: #fff;
}

:global(.task-menu-item.t-menu__item) {
  height: auto;
  min-height: 68px;
  align-items: stretch;
  line-height: normal;
  padding-top: 2px;
  padding-right: 2px;
  padding-bottom: 2px;
}

:global(.task-menu-item.t-menu__item > .t-icon) {
  align-self: flex-start;
  margin-top: 8px;
}

:global(.task-menu-item.t-menu__item > .t-menu__content) {
  display: flex;
  min-width: 0;
  flex: 1;
  line-height: normal;
}

.task-entry-shell {
  position: relative;
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: stretch;
}

.task-row-main {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  padding: 8px 3px 8px 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.task-copy {
  display: block;
  min-width: 0;
  flex: 1;
}

.task-title-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.task-title-line strong {
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-title-line :deep(.t-tag) {
  height: 18px;
  flex: 0 0 auto;
  padding: 0 4px;
  font-size: 8px;
}

.task-copy>small,
.task-copy>time {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-copy>small {
  margin-top: 4px;
  color: var(--muted);
  font-size: 8px;
}

.task-copy>time {
  margin-top: 3px;
  color: #99a3a7;
  font-size: 8px;
}

.task-actions {
  position: absolute;
  top: 50%;
  right: 0;
  z-index: 1;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  padding-left: 8px;
  background: linear-gradient(90deg, rgba(233, 244, 244, 0), #e9f4f4 10px);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-50%);
  transition: opacity 120ms ease;
}

:global(.task-menu-item:hover .task-actions),
:global(.task-menu-item:focus-within .task-actions) {
  opacity: 1;
  pointer-events: auto;
}

.task-actions :deep(.t-button) {
  width: 24px;
  height: 24px;
  min-width: 24px;
  padding: 0;
}

.task-actions :deep(.t-button .t-icon) {
  margin-right: 0;
}

:global(.task-empty-item.t-menu__item) {
  height: auto;
  min-height: 66px;
  align-items: stretch;
  padding-top: 2px;
  padding-bottom: 2px;
  line-height: normal;
}

:global(.task-empty-item.t-menu__item > .t-icon) {
  align-self: flex-start;
  margin-top: 8px;
}

:global(.task-empty-item.t-menu__item > .t-menu__content) {
  display: flex;
  min-width: 0;
  flex: 1;
  line-height: normal;
}

.task-empty {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  padding: 8px 3px 8px 0;
  color: #97a0aa;
  line-height: normal;
}

.task-empty strong {
  min-height: 20px;
  color: #58636c;
  font-size: 10px;
  line-height: 20px;
}

.task-empty small {
  margin-top: 3px;
  font-size: 9px;
}

.sidebar-note {
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 0 16px;
  color: var(--muted);
  font-size: 10px;
}

.collapsed .sidebar-note {
  justify-content: center;
  padding: 0;
}

.task-menu :deep(.t-menu__operations) {
  padding: 8px;
}

.sidebar-operations {
  padding: 7px 0 0;
  border-top: 1px solid var(--line);
}

.about-entry.t-button {
  width: 100%;
  height: 40px;
  justify-content: flex-start;
  padding: 0 16px;
  border-radius: 8px;
  color: var(--ink);
  font-size: 10px;
}

.about-entry.t-button:hover {
  background: #e3eeee;
  color: var(--accent);
}

.about-entry :deep(.t-button__text) {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.about-entry :deep(.t-icon) {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  font-size: 18px;
}

.collapsed .about-entry.t-button {
  justify-content: center;
  padding: 0;
}

.status-dot {
  display: grid;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  place-items: center;
}

.status-dot::after {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px rgba(40, 151, 96, 0.09);
  content: '';
}

:global(.task-sidebar-popup) {
  min-width: 280px !important;
  max-width: 340px;
}

:global(.task-sidebar-popup .task-menu-item.t-menu__item) {
  padding-left: 12px;
}

:global(.task-sidebar-popup .task-config-popup-item.t-menu__item) {
  min-height: 40px;
  padding-left: 12px;
}

:global(.task-sidebar-popup .task-config-popup-item-last.t-menu__item) {
  margin-bottom: 6px;
  box-shadow: 0 7px 0 -6px var(--line);
}

:global(.task-config-tools-dropdown) {
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 9px;
  box-shadow: 0 10px 26px rgba(22, 42, 48, 0.16);
}

:global(.task-config-tools-dropdown .t-dropdown__item) {
  min-height: 38px;
  border-radius: 6px;
}

:global(.task-config-tools-dropdown .t-dropdown__item:hover) {
  background: #e9f4f4;
}
</style>
