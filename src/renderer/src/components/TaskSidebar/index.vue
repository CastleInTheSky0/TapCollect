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
import type { AppView } from '@renderer/router'
import appIconUrl from '@renderer/assets/images/tapcollect-icon.png'

const props = defineProps<{
  tasks: TaskSummary[]
  activeId: string
  view: AppView
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
    <t-menu
      class="task-menu" theme="light" :collapsed="collapsed" :width="['100%', '64px']" :value="menuValue"
      :expanded="expandedMenuValues" expand-type="normal" @change="handleMenuChange" @expand="handleMenuExpand"
    >
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
              <t-dropdown
                trigger="click" placement="right-top" :disabled="disabled" :min-column-width="206"
                :popup-props="{
                  overlayInnerClassName: 'task-config-tools-dropdown',
                  onVisibleChange: handleTaskConfigToolsVisibleChange
                }" @click="handleTaskConfigToolClick"
              >
                <span class="task-config-tools-trigger">
                  <t-tooltip content="任务配置工具" placement="top" :visible="taskConfigToolsOpen ? false : undefined">
                    <t-button
                      aria-label="任务配置工具" theme="default" variant="text" shape="square" size="small"
                      :disabled="disabled"
                    >
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

        <t-menu-item
          v-if="collapsed" value="export-configs" class="task-config-popup-item task-config-popup-item-last"
          :disabled="disabled"
        >
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
                <t-button
                  theme="primary" variant="text" shape="square" size="small" :disabled="runDisabled(item.id)"
                  @click.stop="emit('run', item.id)"
                >
                  <template #icon>
                    <PlayIcon size="18px" />
                  </template>
                </t-button>
              </t-tooltip>
              <t-tooltip content="复制任务" placement="top">
                <t-button
                  theme="default" variant="text" shape="square" size="small" :disabled="disabled"
                  @click.stop="emit('duplicate', item.id)"
                >
                  <template #icon>
                    <CopyIcon size="18px" />
                  </template>
                </t-button>
              </t-tooltip>
              <t-tooltip content="删除任务" placement="top">
                <t-button
                  theme="danger" variant="text" shape="square" size="small"
                  :disabled="disabled || taskLocked(item.id)" @click.stop="emit('remove', item.id)"
                >
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

<style scoped src="./shell.css"></style>
<style scoped src="./content.css"></style>
