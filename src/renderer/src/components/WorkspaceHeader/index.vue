<script setup lang="ts">
import { PlayIcon, SaveIcon } from 'tdesign-icons-vue-next'

defineProps<{
  taskName: string
  groupName: string
  hasTask: boolean
  activeTaskLocked: boolean
  testingTaskId: string
  activeId: string
  hasUnsavedChanges: boolean
  runnable: boolean
  busy: boolean
  saving: boolean
}>()

const emit = defineEmits<{
  save: []
  run: []
}>()
</script>

<template>
  <header class="workspace-header">
    <div class="workspace-title">
      <span class="context-label workspace-breadcrumb" :title="groupName ? `任务配置 > ${groupName}` : '任务配置'">
        <span>任务配置</span><template v-if="groupName"><span aria-hidden="true">&gt;</span><span class="breadcrumb-group">{{ groupName }}</span></template>
      </span>
      <strong>{{ taskName }}</strong>
    </div>
    <div class="header-actions">
      <t-tag v-if="hasTask && activeTaskLocked" theme="warning" variant="light">
        {{ testingTaskId === activeId ? '测试中，配置只读' : '任务活动中，配置只读' }}
      </t-tag>
      <t-tag v-if="hasTask" :theme="hasUnsavedChanges ? 'warning' : 'success'" variant="light">
        {{ hasUnsavedChanges ? '有未保存修改' : '草稿已保存' }}
      </t-tag>
      <t-tag v-if="hasTask" :theme="runnable ? 'success' : 'warning'" variant="light">
        {{ runnable ? '配置完整' : '配置未完成' }}
      </t-tag>
      <t-button
        theme="default"
        variant="outline"
        :loading="saving"
        :disabled="!hasTask || busy || activeTaskLocked"
        @click="emit('save')"
      >
        <template #icon>
          <SaveIcon />
        </template>
        保存草稿
      </t-button>
      <t-button
        theme="primary"
        :disabled="!hasTask || busy || saving || activeTaskLocked"
        @click="emit('run')"
      >
        <template #icon>
          <PlayIcon />
        </template>
        运行任务
      </t-button>
    </div>
  </header>
</template>

<style scoped>
.workspace-breadcrumb { display: flex; min-width: 0; align-items: center; gap: 6px; }
.workspace-breadcrumb > span:first-child { flex: 0 0 auto; }
.breadcrumb-group { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
