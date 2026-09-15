<script setup lang="ts">
import { computed } from 'vue'
import { FolderIcon } from 'tdesign-icons-vue-next'
import type { TaskGroupRegistry, TaskSummary } from '@shared/types'
import type { TaskGroupDialog } from '@renderer/composables/useTaskGroups'

const props = defineProps<{
  dialog: TaskGroupDialog | null
  registry: TaskGroupRegistry
  tasks: TaskSummary[]
  pending: boolean
  error: string
}>()
const name = defineModel<string>('name', { required: true })
const destination = defineModel<string>('destination', { required: true })
const emit = defineEmits<{ confirm: []; close: []; closed: [] }>()
const kind = computed(() => props.dialog?.kind)
const title = computed(() => ({
  'create-group': '新建分组', 'rename-group': '重命名分组', 'delete-group': '删除分组',
  move: '移动到分组', 'create-task': '新建采集任务'
})[kind.value ?? 'create-group'])
const confirmLabel = computed(() => ({
  'create-group': '创建分组', 'rename-group': '保存名称', 'delete-group': '删除分组',
  move: '确认移动', 'create-task': '创建任务'
})[kind.value ?? 'create-group'])
const selectedGroup = computed(() => {
  const dialog = props.dialog
  return dialog && 'groupId' in dialog ? props.registry.groups.find(group => group.id === dialog.groupId) : undefined
})
const taskCount = (groupId: string): number => props.tasks.filter(task => props.registry.memberships[task.id] === groupId).length
const options = computed(() => [
  { label: '不分组', value: '' },
  ...props.registry.groups.filter(group => kind.value !== 'delete-group' || group.id !== selectedGroup.value?.id)
    .map(group => ({ label: group.name, value: group.id }))
])
</script>

<template>
  <t-dialog
    :visible="Boolean(dialog)" :header="title" :footer="false" width="440px"
    :close-on-overlay-click="false" :close-btn="!pending" :close-on-esc-keydown="!pending"
    @close="emit('close')" @closed="emit('closed')"
  >
    <div class="task-group-dialog">
      <template v-if="kind === 'create-group' || kind === 'rename-group'">
        <p class="group-dialog-copy">按站点或工作内容命名，方便快速找到任务。</p>
        <label class="group-field-label" for="task-group-name">分组名称</label>
        <t-input
          id="task-group-name" v-model="name" aria-label="分组名称" :maxlength="40"
          placeholder="例如：市政府门户网站" :disabled="pending" autofocus @enter="emit('confirm')"
        />
        <p class="group-field-hint">最多 40 个字符，名称不能重复。</p>
      </template>
      <template v-else-if="dialog?.kind === 'move'">
        <p class="group-dialog-copy">为 <strong>{{ dialog.taskIds.length }}</strong> 个任务选择目标分组。</p>
        <t-radio-group v-model="destination" class="group-destinations" :disabled="pending" aria-label="目标分组">
          <t-radio value="" class="group-destination"><FolderIcon /><span>不分组</span></t-radio>
          <t-radio v-for="group in registry.groups" :key="group.id" :value="group.id" class="group-destination">
            <FolderIcon /><span :title="group.name">{{ group.name }}</span><small>{{ taskCount(group.id) }} 个任务</small>
          </t-radio>
        </t-radio-group>
      </template>
      <template v-else-if="kind === 'delete-group'">
        <p class="group-dialog-copy">
          删除“<strong>{{ selectedGroup?.name }}</strong>”后，组内
          <strong>{{ selectedGroup ? taskCount(selectedGroup.id) : 0 }}</strong> 个任务将保留。
        </p>
        <template v-if="selectedGroup && taskCount(selectedGroup.id)">
          <label class="group-field-label" for="delete-group-destination">任务移至</label>
          <t-select id="delete-group-destination" v-model="destination" :options="options" :disabled="pending" aria-label="任务移至" />
        </template>
      </template>
      <template v-else-if="kind === 'create-task'">
        <label class="group-field-label" for="new-group-task-name">任务名称</label>
        <t-input
          id="new-group-task-name" v-model="name" aria-label="任务名称" :maxlength="120"
          placeholder="例如：通知公告" :disabled="pending" autofocus @enter="emit('confirm')"
        />
        <label class="group-field-label group-field-spaced" for="new-task-group">所属分组</label>
        <t-select id="new-task-group" v-model="destination" :options="options" :disabled="pending" aria-label="所属分组" />
      </template>
      <t-alert v-if="error" theme="error" :message="error" class="group-dialog-error" />
      <div class="group-dialog-actions">
        <t-button theme="default" variant="outline" :disabled="pending" @click="emit('close')">取消</t-button>
        <t-button :theme="kind === 'delete-group' ? 'danger' : 'primary'" :loading="pending" @click="emit('confirm')">{{ confirmLabel }}</t-button>
      </div>
    </div>
  </t-dialog>
</template>

<style scoped src="./style.css"></style>
