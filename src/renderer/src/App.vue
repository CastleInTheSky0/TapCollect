<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, ref } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { RouterView } from 'vue-router'
import MessagePlugin from 'tdesign-vue-next/es/message/plugin'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MenuFoldIcon,
  MenuUnfoldIcon
} from 'tdesign-icons-vue-next'
import { firstTaskListPageUrl } from '@shared/list-page-rules'
import { appStoreKey } from '@renderer/store'
import AboutUpdateDialog from '@renderer/components/AboutUpdateDialog/index.vue'
import PreviewPane from '@renderer/components/PreviewPane/index.vue'
import RunDrawer from '@renderer/components/RunDrawer/index.vue'
import TaskDialogs from '@renderer/components/TaskDialogs/index.vue'
import TaskSidebar from '@renderer/components/TaskSidebar/index.vue'
import { useFeedback } from '@renderer/composables/useFeedback'
import { useAppNavigation } from '@renderer/composables/useAppNavigation'
import { useAppSettings } from '@renderer/composables/useAppSettings'
import { usePaneLayout } from '@renderer/composables/usePaneLayout'
import { useRunSession } from '@renderer/composables/useRunSession'
import { useTasks } from '@renderer/composables/useTasks'
import { useTaskForm } from '@renderer/composables/useTaskForm'
import { usePreview } from '@renderer/composables/usePreview'

const api = window.collector
const aboutUpdateVisible = ref(false)

const feedback = useFeedback()
const navigationStore = useAppNavigation({
  showError: feedback.showError,
  getTasks: () => tasksStore.tasks.value,
  getRunItems: () => runSessionStore.runSession.value.items,
  getActiveTaskId: () => taskFormStore.activeId.value,
  getSelectedRunTaskId: () => runSessionStore.selectedRunTaskId.value,
  loadTask: (id) => taskFormStore.loadTask(id),
  selectRunTask: (id) => runSessionStore.selectRunTask(id),
  schedulePreviewBoundsUpdate: () => layoutStore.schedulePreviewBoundsUpdate()
})
const { appView, routeTaskId, openTask } = navigationStore

// 预览边界元素按规范由 App.vue 持有 ref，组件通过函数型 ref 写回
const previewVisible = ref(false)
const previewSurface = ref<HTMLElement | null>(null)

const setPreviewSurface = (element: Element | ComponentPublicInstance | null): void => {
  previewSurface.value = element instanceof HTMLElement ? element : null
}

// 组合装配：跨功能调用以延迟绑定回调传入，各 composable 可独立阅读；
// 所有回调都只在运行时执行，不会在 setup 阶段被调用
const settingsStore = useAppSettings({
  showError: feedback.showError,
  showNotice: feedback.showNotice,
  refreshRunSession: () => runSessionStore.refreshFromMain(),
  getActiveOutputRoot: () => taskFormStore.activeTask.value?.output.rootDirectory.trim() ?? ''
})

const layoutStore = usePaneLayout({ appView, previewVisible, previewSurface })

const runSessionStore = useRunSession({
  showError: feedback.showError,
  showNotice: feedback.showNotice,
  showWarning: feedback.showWarning,
  formatConfigurationIssues: feedback.formatConfigurationIssues,
  settings: settingsStore.settings,
  appView,
  openRunCenter: (taskId) => navigationStore.openRunCenter(taskId),
  getActiveId: () => taskFormStore.activeId.value,
  refreshTasks: () => tasksStore.refreshTasks(),
  loadTask: (id) => navigationStore.openTask(id),
  closePreview: () => previewStore.closePreview(),
  getPreviewVisible: () => previewVisible.value,
  getActiveTask: () => taskFormStore.activeTask.value,
  getHasUnsavedChanges: () => taskFormStore.hasUnsavedChanges.value,
  getConfigurationIssues: () => taskFormStore.configurationIssues.value
})

const taskFormStore = useTaskForm({
  showError: feedback.showError,
  showNotice: feedback.showNotice,
  showWarning: feedback.showWarning,
  formatConfigurationIssues: feedback.formatConfigurationIssues,
  settings: settingsStore.settings,
  refreshTasks: () => tasksStore.refreshTasks(),
  isActiveTaskLocked: () => runSessionStore.activeTaskLocked.value,
  navigation: {
    openTask: (id) => navigationStore.openTask(id),
    selectRunTask: runSessionStore.selectRunTask,
    setPreviewUrl: (url) => previewStore.setPreviewUrl(url),
    getPreviewVisible: () => previewVisible.value,
    navigatePreview: (url) => api.previewNavigate(url),
    schedulePreviewBounds: layoutStore.schedulePreviewBoundsUpdate,
    resetDetailSamples: () => previewStore.resetDetailSamples()
  }
})

const tasksStore = useTasks({
  showError: feedback.showError,
  showNotice: feedback.showNotice,
  showWarning: feedback.showWarning,
  applyRunSession: runSessionStore.applyRunSession,
  getSelectedRunTaskId: () => runSessionStore.selectedRunTaskId.value,
  clearDismissedTask: runSessionStore.clearDismissedTask,
  getRunItem: runSessionStore.getRunItem,
  getTestingTaskId: () => runSessionStore.runSession.value.testingTaskId,
  loadTask: (id) => navigationStore.openTask(id),
  clearActiveTask: taskFormStore.clearActiveTask
})

const previewStore = usePreview({
  showError: feedback.showError,
  showNotice: feedback.showNotice,
  showWarning: feedback.showWarning,
  previewVisible,
  layout: {
    expandPreviewPane: layoutStore.expandPreviewPane,
    previewBounds: layoutStore.previewBounds,
    schedulePreviewBoundsUpdate: layoutStore.schedulePreviewBoundsUpdate
  },
  getActiveTask: () => taskFormStore.activeTask.value,
  getActiveOutputTemplate: () => taskFormStore.activeOutputTemplate.value,
  isActiveTaskLocked: () => runSessionStore.activeTaskLocked.value,
  isClickDetail: () => taskFormStore.isClickDetail.value
})

provide(appStoreKey, {
  navigationStore,
  settingsStore,
  runSessionStore,
  taskFormStore,
  previewStore
})

// 模板绑定（保持原有命名）
const { settings } = settingsStore
const {
  runSession,
  runActionTaskId,
  resumePrompt,
  cancelPromptTaskId,
  cancelAllPrompt,
  showRunDrawer,
  selectedRunItem,
  activeTaskLocked,
  showRunCenter,
  requestRun,
  launchRun,
  pauseRun,
  resumeRun,
  cancelRun,
  confirmCancelRun,
  confirmCancelAllRuns,
  dismissRunDrawer,
  openOutput,
  openErrorLog
} = runSessionStore
const {
  activeTask,
  busy,
  saving,
  activeId,
  hasUnsavedChanges,
  createNewTask
} = taskFormStore
const {
  tasks,
  taskConfigTransferring,
  taskConfigImportResult,
  exportTaskConfigsPrompt,
  pendingDeleteTaskId,
  refreshTasks,
  duplicateTask,
  importTaskConfigs,
  requestExportTaskConfigs,
  exportTaskConfigs,
  removeTask,
  confirmRemoveTask
} = tasksStore
const {
  previewUrl,
  previewStatus,
  previewOpenAction,
  pickingLabel,
  previewOpening,
  openPreview,
  openConfiguredListPreview,
  closePreview
} = previewStore
const {
  sidebarCollapsed,
  previewCollapsed,
  resizingPane,
  runLogHeight,
  runLogMaxHeight,
  appShellStyle,
  toggleSidebarPane,
  togglePreviewPane,
  startPaneResize,
  handlePaneResize,
  stopPaneResize,
  resizePaneWithKeyboard,
  handleWindowResize,
  fitCurrentPaneWidths
} = layoutStore

let resizeObserver: ResizeObserver | null = null

onMounted(async () => {
  try {
    settings.value = await api.getSettings()
    runSessionStore.applyRunSession(await api.getRunSession())
    await refreshTasks()
    await navigationStore.start()
  } catch (error) {
    feedback.showError(error)
  }
  fitCurrentPaneWidths()
  resizeObserver = new ResizeObserver(layoutStore.schedulePreviewBoundsUpdate)
  if (previewSurface.value) resizeObserver.observe(previewSurface.value)
  window.addEventListener('resize', handleWindowResize)
  window.addEventListener('pointermove', handlePaneResize)
  window.addEventListener('pointerup', stopPaneResize)
  window.addEventListener('pointercancel', stopPaneResize)
})

onBeforeUnmount(() => {
  MessagePlugin.closeAll()
  resizeObserver?.disconnect()
  layoutStore.cancelScheduledPreviewBoundsUpdate()
  window.removeEventListener('resize', handleWindowResize)
  window.removeEventListener('pointermove', handlePaneResize)
  window.removeEventListener('pointerup', stopPaneResize)
  window.removeEventListener('pointercancel', stopPaneResize)
  document.body.classList.remove('pane-resizing')
  document.body.classList.remove('run-log-resizing')
  void api.previewClose()
})
</script>

<template>
  <main
    class="app-shell" :class="{
      'sidebar-collapsed': sidebarCollapsed,
      'preview-collapsed': previewCollapsed,
      'run-center-view': appView === 'run-center',
      'pane-is-resizing': resizingPane
    }" :style="appShellStyle"
  >
    <TaskSidebar
      :collapsed="sidebarCollapsed" :tasks="tasks" :active-id="routeTaskId || activeId" :view="appView"
      :run-items="runSession.items" :testing-task-id="runSession.testingTaskId"
      :disabled="busy || saving || taskConfigTransferring" @select="openTask" @show-run-center="showRunCenter"
      @create="createNewTask" @import-configs="importTaskConfigs" @export-configs="requestExportTaskConfigs"
      @duplicate="duplicateTask" @remove="removeTask" @run="requestRun" @show-about="aboutUpdateVisible = true"
    />

    <div
      class="pane-divider sidebar-divider" role="separator" aria-label="调整任务栏宽度" aria-orientation="vertical"
      tabindex="0" @pointerdown="startPaneResize('sidebar', $event)"
      @keydown="resizePaneWithKeyboard('sidebar', $event)"
    >
      <t-tooltip :content="sidebarCollapsed ? '展开任务栏' : '折叠任务栏'" placement="right">
        <t-button
          class="pane-toggle" theme="default" variant="outline" shape="square" size="small" @pointerdown.stop
          @click.stop="toggleSidebarPane"
        >
          <MenuUnfoldIcon v-if="sidebarCollapsed" />
          <MenuFoldIcon v-else />
        </t-button>
      </t-tooltip>
    </div>

    <section class="workspace" :class="{ 'configuration-locked': activeTaskLocked }">
      <RouterView />
    </section>

    <div
      class="pane-divider preview-divider" role="separator" aria-label="调整网页预览宽度" aria-orientation="vertical"
      :aria-hidden="appView === 'run-center'" :inert="appView === 'run-center'"
      :tabindex="appView === 'run-center' ? -1 : 0" @pointerdown="startPaneResize('preview', $event)"
      @keydown="resizePaneWithKeyboard('preview', $event)"
    >
      <t-tooltip :content="previewCollapsed ? '展开网页预览' : '折叠网页预览'" placement="left">
        <t-button
          class="pane-toggle" theme="default" variant="outline" shape="square" size="small" @pointerdown.stop
          @click.stop="togglePreviewPane"
        >
          <ChevronLeftIcon v-if="previewCollapsed" />
          <ChevronRightIcon v-else />
        </t-button>
      </t-tooltip>
    </div>

    <PreviewPane
      v-model:preview-url="previewUrl" :inactive="previewCollapsed || appView === 'run-center'"
      :picking-label="pickingLabel" :preview-status="previewStatus" :preview-visible="previewVisible"
      :preview-opening="previewOpening" :preview-open-action="previewOpenAction"
      :show-list-button="Boolean(activeTask && firstTaskListPageUrl(activeTask))" :surface-ref="setPreviewSurface"
      @open-preview="openPreview" @open-list-preview="openConfiguredListPreview('placeholder-list')"
      @close-preview="closePreview"
    />

    <RunDrawer
      v-if="showRunDrawer" :item="selectedRunItem" :run-action-task-id="runActionTaskId"
      :run-log-height="runLogHeight" :run-log-max-height="runLogMaxHeight" @resize-log="runLogHeight = $event"
      @dismiss="dismissRunDrawer" @pause="pauseRun()" @resume="resumeRun()" @cancel="cancelRun()"
      @open-output="openOutput()" @open-error="openErrorLog()"
    />

    <AboutUpdateDialog v-model:visible="aboutUpdateVisible" :api="api" />

    <TaskDialogs
      v-model:resume-prompt="resumePrompt" v-model:pending-delete-task-id="pendingDeleteTaskId"
      v-model:export-task-configs-prompt="exportTaskConfigsPrompt"
      v-model:task-config-import-result="taskConfigImportResult" v-model:cancel-prompt-task-id="cancelPromptTaskId"
      v-model:cancel-all-prompt="cancelAllPrompt" :has-unsaved-changes="hasUnsavedChanges" @launch-run="launchRun"
      @confirm-remove="confirmRemoveTask" @export-configs="exportTaskConfigs" @confirm-cancel-run="confirmCancelRun"
      @confirm-cancel-all="confirmCancelAllRuns"
    />
  </main>
</template>
