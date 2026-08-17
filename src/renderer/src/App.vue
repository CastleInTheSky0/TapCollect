<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import MessagePlugin from 'tdesign-vue-next/es/message/plugin'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MenuFoldIcon,
  MenuUnfoldIcon
} from 'tdesign-icons-vue-next'
import { firstTaskListPageUrl } from '@shared/list-page-rules'
import AboutUpdateDialog from './components/AboutUpdateDialog.vue'
import PreviewPane from './components/PreviewPane.vue'
import RunCenter from './components/RunCenter.vue'
import WelcomeEmpty from './components/WelcomeEmpty.vue'
import RunDrawer from './components/RunDrawer.vue'
import TaskDialogs from './components/TaskDialogs.vue'
import TaskSidebar from './components/TaskSidebar.vue'
import WorkspaceHeader from './components/WorkspaceHeader.vue'
import WizardStepBasic from './components/WizardStepBasic.vue'
import WizardStepList from './components/WizardStepList.vue'
import WizardStepDetail from './components/WizardStepDetail.vue'
import WizardStepTemplate from './components/WizardStepTemplate.vue'
import WizardStepOutput from './components/WizardStepOutput.vue'
import { useFeedback } from './composables/useFeedback'
import { useAppView } from './composables/useAppView'
import { useAppSettings } from './composables/useAppSettings'
import { usePaneLayout } from './composables/usePaneLayout'
import { useRunSession } from './composables/useRunSession'
import { useTasks } from './composables/useTasks'
import { useTaskForm, steps } from './composables/useTaskForm'
import { usePreview } from './composables/usePreview'

const api = window.collector
const aboutUpdateVisible = ref(false)

const feedback = useFeedback()
const { appView, setAppView } = useAppView()

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
  schedulePreviewBoundsUpdate: layoutStore.schedulePreviewBoundsUpdate,
  getActiveId: () => taskFormStore.activeId.value,
  refreshTasks: () => tasksStore.refreshTasks(),
  loadTask: (id) => taskFormStore.loadTask(id),
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
    setAppView,
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
  loadTask: taskFormStore.loadTask,
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

// 模板绑定（保持原有命名）
const { settings, settingsSaving, saveDefaultOutputDirectory, changeMaxConcurrentRuns } =
  settingsStore
const {
  runSession,
  selectedRunTaskId,
  runActionTaskId,
  batchRunAction,
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
  pauseAllRuns,
  resumeAllRuns,
  requestCancelAllRuns,
  confirmCancelAllRuns,
  selectRunTask,
  dismissRunDrawer,
  openOutput,
  openErrorLog
} = runSessionStore
const {
  activeTask,
  currentStep,
  busy,
  saving,
  paginationSuggestions,
  testResult,
  testing,
  activeId,
  runnable,
  hasUnsavedChanges,
  listPageRulesText,
  listPageRuleAnalysis,
  isClickPagination,
  isClickDetail,
  hasPaginationTemplate,
  fixedListPageCount,
  activeOutputTemplate,
  unresolvedMappings,
  testMatchSummaries,
  testTableData,
  testTableColumns,
  testResourceTableData,
  testResourceTableColumns,
  listHostname,
  flatXmlTree,
  outputFieldLabel,
  selectStep,
  synchronizeListPageMetadata,
  loadTask,
  createNewTask,
  saveCurrent,
  detectPagination,
  applyPaginationSuggestion,
  changePaginationMode,
  importXml,
  importSpreadsheet,
  changeOutputFormat,
  selectRecordNode,
  addResourceReplacement,
  addHeader,
  setCustomAttributes,
  chooseOutputDirectory,
  chooseResourceDirectory,
  runTest
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
  detailSamples,
  detailSampleIndex,
  previewOpening,
  openPreview,
  openConfiguredListPreview,
  closePreview,
  pickBaseSelector,
  evaluateBaseSelector,
  openDetailSample,
  pickMapping,
  evaluateMapping
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
    if (tasks.value[0]) await loadTask(tasks.value[0].id)
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
      :collapsed="sidebarCollapsed" :tasks="tasks" :active-id="activeId" :view="appView"
      :run-items="runSession.items" :testing-task-id="runSession.testingTaskId"
      :disabled="busy || saving || taskConfigTransferring" @select="loadTask" @show-run-center="showRunCenter"
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
      <RunCenter
        v-if="appView === 'run-center'" :snapshot="runSession" :selected-task-id="selectedRunTaskId"
        :action-task-id="runActionTaskId" :batch-action="batchRunAction" :settings-saving="settingsSaving"
        @select="selectRunTask" @pause="pauseRun" @resume="resumeRun" @cancel="cancelRun" @pause-all="pauseAllRuns"
        @resume-all="resumeAllRuns" @cancel-all="requestCancelAllRuns" @change-concurrency="changeMaxConcurrentRuns"
        @create="createNewTask" @open-output="openOutput" @open-error="openErrorLog"
      />
      <WorkspaceHeader
        v-if="appView === 'task'" :task-name="activeTask?.name || '尚未选择任务'"
        :has-task="Boolean(activeTask)" :active-task-locked="activeTaskLocked"
        :testing-task-id="runSession.testingTaskId" :active-id="activeId" :has-unsaved-changes="hasUnsavedChanges"
        :runnable="runnable" :busy="busy" :saving="saving" @save="saveCurrent(false)" @run="requestRun()"
      />

      <template v-if="appView === 'task' && activeTask">
        <t-steps
          :current="currentStep" class="wizard-nav" :readonly="activeTaskLocked" :inert="activeTaskLocked"
          separator="line" @change="selectStep"
        >
          <t-step-item v-for="(label, index) in steps" :key="label" :value="index + 1" :title="label" />
        </t-steps>

        <div class="step-scroll" :inert="activeTaskLocked">
          <Transition name="step" mode="out-in">
            <section :key="currentStep" class="step-content">
              <WizardStepBasic
                v-if="currentStep === 1" v-model="activeTask"
                v-model:list-page-rules-text="listPageRulesText" :is-click-pagination="isClickPagination"
                :preview-opening="previewOpening" :preview-open-action="previewOpenAction"
                :fixed-list-page-count="fixedListPageCount" :has-pagination-template="hasPaginationTemplate"
                :list-page-rule-analysis="listPageRuleAnalysis"
                @open-list-preview="openConfiguredListPreview('step-list')"
              />
              <WizardStepList
                v-else-if="currentStep === 2" v-model="activeTask"
                :is-click-pagination="isClickPagination" :has-pagination-template="hasPaginationTemplate"
                :list-page-rule-analysis="listPageRuleAnalysis" :pagination-suggestions="paginationSuggestions"
                @change-pagination-mode="changePaginationMode" @evaluate="evaluateBaseSelector" @pick="pickBaseSelector"
                @detect-pagination="detectPagination" @apply-suggestion="applyPaginationSuggestion"
                @sync-metadata="synchronizeListPageMetadata"
              />
              <WizardStepDetail
                v-else-if="currentStep === 3" v-model="activeTask" :is-click-detail="isClickDetail"
                :list-hostname="listHostname" :preview-opening="previewOpening" :preview-open-action="previewOpenAction"
                :detail-samples="detailSamples" :detail-sample-index="detailSampleIndex"
                :active-output-template="activeOutputTemplate" :output-field-label="outputFieldLabel"
                @evaluate="evaluateBaseSelector" @pick="pickBaseSelector" @open-detail-first="openDetailSample(false)"
                @open-detail-next="openDetailSample(true)"
              />
              <WizardStepTemplate
                v-else-if="currentStep === 4" v-model="activeTask"
                :unresolved-mappings="unresolvedMappings" :flat-xml-tree="flatXmlTree"
                @change-output-format="changeOutputFormat" @import-xml="importXml" @select-record="selectRecordNode"
                @import-spreadsheet="importSpreadsheet" @pick="pickMapping" @evaluate="evaluateMapping"
              />
              <WizardStepOutput
                v-else v-model="activeTask" :is-click-detail="isClickDetail" :testing="testing"
                :active-task-locked="activeTaskLocked" :busy="busy" :saving="saving"
                :active-output-template="activeOutputTemplate" :test-result="testResult"
                :test-match-summaries="testMatchSummaries" :test-table-data="testTableData"
                :test-table-columns="testTableColumns" :test-resource-table-data="testResourceTableData"
                :test-resource-table-columns="testResourceTableColumns" @set-custom-attributes="setCustomAttributes"
                @choose-resource-directory="chooseResourceDirectory" @add-resource-replacement="addResourceReplacement"
                @choose-output-directory="chooseOutputDirectory"
                @save-default-output-directory="saveDefaultOutputDirectory" @add-header="addHeader" @run-test="runTest"
                @request-run="requestRun()"
              />
            </section>
          </Transition>
        </div>

        <footer class="wizard-footer" :inert="activeTaskLocked">
          <t-button theme="default" variant="text" :disabled="currentStep === 1" @click="currentStep -= 1">
            <template #icon>
              <ChevronLeftIcon />
            </template>
            上一步
          </t-button>
          <span>第 {{ currentStep }} 步，共 5 步</span>
          <t-button
            class="wizard-next-button" theme="default" variant="outline" :disabled="currentStep === 5"
            @click="currentStep += 1"
          >
            下一步
            <ChevronRightIcon />
          </t-button>
        </footer>
      </template>

      <WelcomeEmpty v-else-if="appView === 'task'" @create="createNewTask" />
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
<style>
.section-line .full {
  margin-bottom: 13px;
}
</style>
