<script setup lang="ts">
import { useAppStore } from '@renderer/store'
import RunCenter from '@renderer/components/RunCenter/index.vue'

const { navigationStore, settingsStore, runSessionStore, taskFormStore } = useAppStore()
const { settingsSaving, changeMaxConcurrentRuns } = settingsStore
const {
  runSession,
  selectedRunTaskId,
  runActionTaskId,
  batchRunAction,
  pauseRun,
  resumeRun,
  cancelRun,
  pauseAllRuns,
  resumeAllRuns,
  requestCancelAllRuns,
  openOutput,
  openErrorLog
} = runSessionStore
const { createNewTask } = taskFormStore

const selectRunTask = (taskId: string): void => {
  void navigationStore.openRunCenter(taskId)
}
</script>

<template>
  <RunCenter
    :snapshot="runSession"
    :selected-task-id="selectedRunTaskId"
    :action-task-id="runActionTaskId"
    :batch-action="batchRunAction"
    :settings-saving="settingsSaving"
    @select="selectRunTask"
    @pause="pauseRun"
    @resume="resumeRun"
    @cancel="cancelRun"
    @pause-all="pauseAllRuns"
    @resume-all="resumeAllRuns"
    @cancel-all="requestCancelAllRuns"
    @change-concurrency="changeMaxConcurrentRuns"
    @create="createNewTask"
    @open-output="openOutput"
    @open-error="openErrorLog"
  />
</template>
