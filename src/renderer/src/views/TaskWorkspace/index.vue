<script setup lang="ts">
import { ChevronLeftIcon, ChevronRightIcon } from 'tdesign-icons-vue-next'
import { useAppStore } from '@renderer/store'
import { WIZARD_STEPS } from '@renderer/constants/task'
import WorkspaceHeader from '@renderer/components/WorkspaceHeader/index.vue'
import WelcomeEmpty from '@renderer/components/WelcomeEmpty/index.vue'
import WizardStepBasic from '@renderer/components/WizardStepBasic/index.vue'
import WizardStepDetail from '@renderer/components/WizardStepDetail/index.vue'
import WizardStepList from '@renderer/components/WizardStepList/index.vue'
import WizardStepOutput from '@renderer/components/WizardStepOutput/index.vue'
import WizardStepTemplate from '@renderer/components/WizardStepTemplate/index.vue'

const { settingsStore, runSessionStore, taskFormStore, previewStore } = useAppStore()
const { saveDefaultOutputDirectory } = settingsStore
const { runSession, activeTaskLocked, requestRun } = runSessionStore
const {
  activeTask,
  currentStep,
  busy,
  saving,
  paginationSuggestions,
  testResult,
  testing,
  exportingTestFile,
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
  runTest,
  exportTestFile
} = taskFormStore
const {
  previewOpenAction,
  detailSamples,
  detailSampleIndex,
  previewOpening,
  openConfiguredListPreview,
  pickBaseSelector,
  evaluateBaseSelector,
  openDetailSample,
  pickMapping,
  evaluateMapping
} = previewStore
</script>

<template>
  <WorkspaceHeader
    :task-name="activeTask?.name || '尚未选择任务'"
    :has-task="Boolean(activeTask)"
    :active-task-locked="activeTaskLocked"
    :testing-task-id="runSession.testingTaskId"
    :active-id="activeId"
    :has-unsaved-changes="hasUnsavedChanges"
    :runnable="runnable"
    :busy="busy"
    :saving="saving"
    @save="saveCurrent(false)"
    @run="requestRun()"
  />

  <template v-if="activeTask">
    <t-steps
      :current="currentStep"
      class="wizard-nav"
      :readonly="activeTaskLocked"
      :inert="activeTaskLocked"
      separator="line"
      @change="selectStep"
    >
      <t-step-item
        v-for="(label, index) in WIZARD_STEPS"
        :key="label"
        :value="index + 1"
        :title="label"
      />
    </t-steps>

    <div class="step-scroll" :inert="activeTaskLocked">
      <Transition name="step" mode="out-in">
        <section :key="currentStep" class="step-content">
          <WizardStepBasic
            v-if="currentStep === 1"
            v-model="activeTask"
            v-model:list-page-rules-text="listPageRulesText"
            :is-click-pagination="isClickPagination"
            :preview-opening="previewOpening"
            :preview-open-action="previewOpenAction"
            :fixed-list-page-count="fixedListPageCount"
            :has-pagination-template="hasPaginationTemplate"
            :list-page-rule-analysis="listPageRuleAnalysis"
            @open-list-preview="openConfiguredListPreview('step-list')"
          />
          <WizardStepList
            v-else-if="currentStep === 2"
            v-model="activeTask"
            :is-click-pagination="isClickPagination"
            :has-pagination-template="hasPaginationTemplate"
            :list-page-rule-analysis="listPageRuleAnalysis"
            :pagination-suggestions="paginationSuggestions"
            @change-pagination-mode="changePaginationMode"
            @evaluate="evaluateBaseSelector"
            @pick="pickBaseSelector"
            @detect-pagination="detectPagination"
            @apply-suggestion="applyPaginationSuggestion"
            @sync-metadata="synchronizeListPageMetadata"
          />
          <WizardStepDetail
            v-else-if="currentStep === 3"
            v-model="activeTask"
            :is-click-detail="isClickDetail"
            :list-hostname="listHostname"
            :preview-opening="previewOpening"
            :preview-open-action="previewOpenAction"
            :detail-samples="detailSamples"
            :detail-sample-index="detailSampleIndex"
            :active-output-template="activeOutputTemplate"
            :output-field-label="outputFieldLabel"
            @evaluate="evaluateBaseSelector"
            @pick="pickBaseSelector"
            @open-detail-first="openDetailSample(false)"
            @open-detail-next="openDetailSample(true)"
          />
          <WizardStepTemplate
            v-else-if="currentStep === 4"
            v-model="activeTask"
            :unresolved-mappings="unresolvedMappings"
            :flat-xml-tree="flatXmlTree"
            @change-output-format="changeOutputFormat"
            @import-xml="importXml"
            @select-record="selectRecordNode"
            @import-spreadsheet="importSpreadsheet"
            @pick="pickMapping"
            @evaluate="evaluateMapping"
          />
          <WizardStepOutput
            v-else
            v-model="activeTask"
            :is-click-detail="isClickDetail"
            :testing="testing"
            :exporting-test-file="exportingTestFile"
            :active-task-locked="activeTaskLocked"
            :busy="busy"
            :saving="saving"
            :active-output-template="activeOutputTemplate"
            :test-result="testResult"
            :test-match-summaries="testMatchSummaries"
            :test-table-data="testTableData"
            :test-table-columns="testTableColumns"
            :test-resource-table-data="testResourceTableData"
            :test-resource-table-columns="testResourceTableColumns"
            @set-custom-attributes="setCustomAttributes"
            @choose-resource-directory="chooseResourceDirectory"
            @add-resource-replacement="addResourceReplacement"
            @choose-output-directory="chooseOutputDirectory"
            @save-default-output-directory="saveDefaultOutputDirectory"
            @add-header="addHeader"
            @run-test="runTest"
            @export-test-file="exportTestFile"
            @request-run="requestRun()"
          />
        </section>
      </Transition>
    </div>

    <footer class="wizard-footer" :inert="activeTaskLocked">
      <t-button
        theme="default"
        variant="text"
        :disabled="currentStep === 1"
        @click="currentStep -= 1"
      >
        <template #icon><ChevronLeftIcon /></template>
        上一步
      </t-button>
      <span>第 {{ currentStep }} 步，共 5 步</span>
      <t-button
        class="wizard-next-button"
        theme="default"
        variant="outline"
        :disabled="currentStep === 5"
        @click="currentStep += 1"
      >
        下一步
        <ChevronRightIcon />
      </t-button>
    </footer>
  </template>

  <WelcomeEmpty v-else @create="createNewTask" />
</template>

<style src="./style.css"></style>
