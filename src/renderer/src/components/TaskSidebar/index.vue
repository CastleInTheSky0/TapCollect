<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DropdownOption } from 'tdesign-vue-next/es/dropdown/type'
import {
  AddIcon,
  ChevronRightIcon,
  DataSearchIcon,
  DeleteIcon,
  EditIcon,
  EllipsisIcon,
  FileExportIcon,
  FileImportIcon,
  FolderAddIcon,
  FolderIcon,
  FolderOpenIcon,
  SettingIcon,
  TaskIcon,
  ViewModuleIcon
} from 'tdesign-icons-vue-next'
import type { RunSessionItem, TaskGroupRegistry, TaskSummary } from '@shared/types'
import { taskGroupFor } from '@shared/task-groups'
import type { AppView } from '@renderer/router'
import TaskSidebarEntry from '@renderer/components/TaskSidebarEntry/index.vue'
import appIconUrl from '@renderer/assets/images/tapcollect-icon.png'
import sidebarToggleIconUrl from './sidebar-toggle.svg'

const props = defineProps<{
  tasks: TaskSummary[]
  activeId: string
  view: AppView
  runItems: RunSessionItem[]
  testingTaskId: string
  disabled: boolean
  collapsed: boolean
  registry: TaskGroupRegistry
  groupDisabled: boolean
  groupLoadError: string
  batchMode: boolean
  selectedIds: string[]
}>()

const emit = defineEmits<{
  select: [id: string]
  showRunCenter: []
  create: [groupId?: string]
  createGroup: []
  renameGroup: [id: string]
  deleteGroup: [id: string]
  move: [ids: string[]]
  startBatch: []
  finishBatch: []
  toggleSelection: [id: string]
  importConfigs: []
  exportConfigs: []
  duplicate: [id: string]
  remove: [id: string]
  run: [id: string]
  showAbout: []
  showSettings: []
  toggleSidebar: []
}>()

const tasksExpanded = ref(true)
const expandedGroups = ref<string[]>([])
const groupedTasks = computed(() => props.registry.groups.map(group => ({
  ...group, tasks: props.tasks.filter(task => taskGroupFor(props.registry, task.id)?.id === group.id)
})))
const rootTasks = computed(() => props.tasks.filter(task => !taskGroupFor(props.registry, task.id)))
watch(() => props.registry.groups.map(group => group.id), (ids, previous = []) => {
  expandedGroups.value = [...new Set([...expandedGroups.value.filter(id => ids.includes(id)),
    ...ids.filter(id => !previous.includes(id))])]
}, { immediate: true })
watch(() => taskGroupFor(props.registry, props.activeId)?.id, (id) => {
  if (id && !expandedGroups.value.includes(id)) expandedGroups.value.push(id)
})
watch(() => props.batchMode, (enabled) => {
  if (enabled) {
    tasksExpanded.value = true
    expandedGroups.value = props.registry.groups.map(group => group.id)
  }
})
const taskConfigToolsOpen = ref(false)
const sidebarToggleTooltipVisible = ref(false)
watch(() => props.collapsed, () => { sidebarToggleTooltipVisible.value = false })
const runItemMap = computed(() =>
  new Map(props.runItems.map((item) => [item.taskId, item] as const))
)
const sessionActivityCount = computed(() =>
  props.runItems.filter((item) =>
    ['queued', 'preparing', 'running', 'pausing', 'paused'].includes(item.status)
  ).length
)
const menuValue = computed(() => {
  if (props.view === 'settings') return 'settings'
  if (props.view === 'run-center') return 'run-center'
  return props.activeId ? `task:${props.activeId}` : 'tasks'
})
const expandedMenuValues = computed(() => [
  ...(tasksExpanded.value ? ['tasks'] : []), ...expandedGroups.value.map(id => `group:${id}`)
])

const emitTaskConfigAction = (key: string): boolean => {
  if (key === 'create-group') {
    emit('createGroup')
    return true
  }
  if (key === 'batch') {
    emit('startBatch')
    return true
  }
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
  if (key.startsWith('task:')) {
    if (props.batchMode) emit('toggleSelection', key.slice(5))
    else emit('select', key.slice(5))
  }
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
  expandedGroups.value = values.map(String).filter(key => key.startsWith('group:')).map(key => key.slice(6))
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
          <div v-if="!collapsed" class="brand-mark" aria-hidden="true">
            <img :src="appIconUrl" alt="" />
          </div>
          <div v-if="!collapsed" class="brand-copy">
            <strong>TapCollect</strong>
            <span>网页列表采集与模板化输出</span>
          </div>
          <t-tooltip
            :content="collapsed ? '打开侧边栏' : '收起侧边栏'" placement="right"
            :visible="sidebarToggleTooltipVisible" @visible-change="sidebarToggleTooltipVisible = $event"
          >
            <t-button
              class="sidebar-toggle" theme="default" variant="text" shape="square"
              :aria-label="collapsed ? '打开侧边栏' : '收起侧边栏'" :aria-expanded="!collapsed"
              @click="emit('toggleSidebar')"
            >
              <img v-if="collapsed" class="sidebar-toggle-logo" :src="appIconUrl" alt="" aria-hidden="true" />
              <img class="sidebar-toggle-icon" :src="sidebarToggleIconUrl" alt="" aria-hidden="true" />
            </t-button>
          </t-tooltip>
        </div>
      </template>

      <t-menu-item value="create" class="primary-menu-item" :disabled="disabled">
        <template #icon>
          <AddIcon />
        </template>
        新建采集任务
      </t-menu-item>

      <t-submenu value="tasks" class="tasks-submenu" :popup-props="{ overlayClassName: 'task-sidebar-popup' }">
        <template v-if="collapsed" #icon>
          <TaskIcon />
        </template>
        <template #title>
          <span class="task-management-title">
            <span class="task-management-label">
              <span>任务管理</span>
              <span class="task-total">{{ tasks.length }}</span>
            </span>
            <span v-if="!collapsed" class="task-config-tools" @click.stop @pointerdown.stop @keydown.stop>
              <span class="new-group-shortcut"><t-tooltip content="新建分组" placement="top">
                <t-button
                  aria-label="新建分组" theme="default" variant="text" shape="square" size="small"
                  :disabled="groupDisabled || disabled" @click="emit('createGroup')"
                ><FolderAddIcon size="17px" /></t-button>
              </t-tooltip></span>
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
                  <t-dropdown-item value="create-group" :disabled="groupDisabled">
                    <template #prefix-icon><FolderAddIcon size="16px" /></template>新建分组
                  </t-dropdown-item>
                  <t-dropdown-item value="batch" :disabled="groupDisabled || !tasks.length || batchMode">
                    <template #prefix-icon><FolderIcon size="16px" /></template>批量整理
                  </t-dropdown-item>
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

        <t-menu-item v-if="collapsed" value="create-group" class="task-config-popup-item" :disabled="groupDisabled || disabled">
          <template #icon><FolderAddIcon /></template>新建分组
        </t-menu-item>
        <t-menu-item v-if="collapsed" value="batch" class="task-config-popup-item" :disabled="groupDisabled || disabled || !tasks.length || batchMode">
          <template #icon><FolderIcon /></template>批量整理
        </t-menu-item>
        <p v-if="groupLoadError" class="group-load-error" role="alert">分组读取失败，任务仍可使用。请检查分组文件后重试。</p>
        <div v-if="batchMode" class="task-batch-toolbar" @click.stop @keydown.stop>
          <span>已选 {{ selectedIds.length }} 项</span>
          <t-button
            size="small" variant="text" :disabled="!selectedIds.length || groupDisabled || disabled"
            @click="emit('move', selectedIds)"
          >
            移动到分组
          </t-button>
          <t-button size="small" variant="text" :disabled="groupDisabled" @click="emit('finishBatch')">完成</t-button>
        </div>

        <TaskSidebarEntry
          v-for="item in rootTasks" :key="item.id" :task="item"
          :run-item="runItemMap.get(item.id) ?? null" :testing="testingTaskId === item.id"
          :disabled="disabled" :group-disabled="groupDisabled" :batch-mode="batchMode" :checked="selectedIds.includes(item.id)"
          @select="emit('select', $event)" @run="emit('run', $event)" @duplicate="emit('duplicate', $event)"
          @remove="emit('remove', $event)" @move="emit('move', [$event])" @toggle-selection="emit('toggleSelection', $event)"
        />

        <t-submenu
          v-for="group in groupedTasks" :key="group.id" :value="`group:${group.id}`" class="task-group-submenu"
          :popup-props="{ overlayClassName: 'task-sidebar-popup task-group-popup' }"
        >
          <template #icon>
            <span class="group-leading">
              <ChevronRightIcon v-if="!collapsed" class="group-chevron" :class="{ 'is-open': expandedGroups.includes(group.id) }" />
              <FolderOpenIcon v-if="expandedGroups.includes(group.id) && !collapsed" />
              <FolderIcon v-else />
            </span>
          </template>
          <template #title>
            <span class="group-title" :data-group-id="group.id">
              <span class="group-name" :title="group.name">{{ group.name }}</span>
              <span class="group-count">{{ group.tasks.length }}</span>
              <span class="group-actions" @click.stop @pointerdown.stop @keydown.stop>
                <t-dropdown trigger="click" placement="right-top" :min-column-width="180">
                  <t-button
                    theme="default" variant="text" shape="square" size="small" :aria-label="`${group.name}的分组菜单`"
                    :disabled="groupDisabled || disabled"
                  ><EllipsisIcon size="17px" /></t-button>
                  <t-dropdown-menu>
                    <t-dropdown-item @click="emit('create', group.id)">
                      <template #prefix-icon><AddIcon /></template>在此组新建任务
                    </t-dropdown-item>
                    <t-dropdown-item :divider="true" @click="emit('renameGroup', group.id)">
                      <template #prefix-icon><EditIcon /></template>重命名分组
                    </t-dropdown-item>
                    <t-dropdown-item theme="error" @click="emit('deleteGroup', group.id)">
                      <template #prefix-icon><DeleteIcon /></template>删除分组
                    </t-dropdown-item>
                  </t-dropdown-menu>
                </t-dropdown>
              </span>
            </span>
          </template>
          <TaskSidebarEntry
            v-for="item in group.tasks" :key="item.id" :task="item"
            :run-item="runItemMap.get(item.id) ?? null" :testing="testingTaskId === item.id"
            :disabled="disabled" :group-disabled="groupDisabled" :batch-mode="batchMode" :checked="selectedIds.includes(item.id)"
            @select="emit('select', $event)" @run="emit('run', $event)" @duplicate="emit('duplicate', $event)"
            @remove="emit('remove', $event)" @move="emit('move', [$event])" @toggle-selection="emit('toggleSelection', $event)"
          />
          <t-menu-item v-if="!group.tasks.length" :value="`empty-group:${group.id}`" disabled class="group-empty-item">暂无任务</t-menu-item>
        </t-submenu>

        <t-menu-item v-if="tasks.length === 0 && registry.groups.length === 0" value="empty" class="task-empty-item" disabled>
          <template #icon>
            <DataSearchIcon />
          </template>
          <span class="task-empty">
            <strong>还没有任务</strong>
            <small>从一个列表页地址开始。</small>
          </span>
        </t-menu-item>
      </t-submenu>

      <template #operations>
        <div class="sidebar-operations">
          <t-tooltip content="运行中心" placement="right" :disabled="!collapsed">
            <t-button
              class="about-entry" :class="{ 'navigation-selected': view === 'run-center' }" theme="default"
              variant="text" aria-label="运行中心" @click="emit('showRunCenter')"
            >
              <template #icon>
                <ViewModuleIcon />
              </template>
              <span v-if="!collapsed">运行中心</span><span
                v-if="sessionActivityCount && !collapsed"
                class="menu-count active-count"
              >{{
                sessionActivityCount }}</span>
            </t-button>
          </t-tooltip>
          <t-tooltip content="设置" placement="right" :disabled="!collapsed">
            <t-button
              class="about-entry" :class="{ 'navigation-selected': view === 'settings' }" theme="default"
              variant="text" aria-label="设置" @click="emit('showSettings')"
            >
              <template #icon>
                <SettingIcon />
              </template>
              <span v-if="!collapsed">设置</span>
            </t-button>
          </t-tooltip>
          <div class="sidebar-note">
            <span class="status-dot" />
            <span v-if="!collapsed">本地多任务运行 · 数据保存在本机</span>
          </div>
        </div>
      </template>
    </t-menu>
  </aside>
</template>

<style scoped src="./shell.css"></style>
<style scoped src="./content.css"></style>
