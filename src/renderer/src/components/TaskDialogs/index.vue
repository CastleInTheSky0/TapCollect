<script setup lang="ts">
import type { TaskConfigImportResult } from '@shared/types'

// 各对话框的显隐状态通过 v-model 与 App.vue 双向绑定，关闭逻辑与原实现一致
const resumePrompt = defineModel<boolean>('resumePrompt', { required: true })
const pendingDeleteTaskId = defineModel<string>('pendingDeleteTaskId', { required: true })
const exportTaskConfigsPrompt = defineModel<boolean>('exportTaskConfigsPrompt', { required: true })
const taskConfigImportResult = defineModel<TaskConfigImportResult | null>('taskConfigImportResult', {
  required: true
})
const cancelPromptTaskId = defineModel<string>('cancelPromptTaskId', { required: true })
const cancelAllPrompt = defineModel<boolean>('cancelAllPrompt', { required: true })

defineProps<{
  hasUnsavedChanges: boolean
}>()

const emit = defineEmits<{
  closed: []
  'launch-run': [resume: boolean]
  'confirm-remove': []
  'export-configs': []
  'confirm-cancel-run': []
  'confirm-cancel-all': []
}>()
</script>

<template>
  <t-dialog
    v-model:visible="resumePrompt"
    header="发现未完成检查点"
    theme="warning"
    :footer="false"
    :close-on-overlay-click="false"
    width="480px"
    @closed="emit('closed')"
  >
    <p class="dialog-copy">继续会从上次页码、未满批次和资源统计恢复；重新开始会放弃检查点，并按当前覆盖设置处理旧输出文件与资源。</p>
    <div class="dialog-actions">
      <t-button theme="default" variant="text" @click="resumePrompt = false">取消</t-button>
      <t-button theme="default" variant="outline" @click="emit('launch-run', false)">放弃并重新开始</t-button>
      <t-button theme="primary" @click="emit('launch-run', true)">继续上次任务</t-button>
    </div>
  </t-dialog>

  <t-dialog
    :visible="Boolean(pendingDeleteTaskId)"
    header="删除任务配置？"
    theme="danger"
    :footer="false"
    width="440px"
    @closed="emit('closed')"
    @close="pendingDeleteTaskId = ''"
  >
    <p class="dialog-copy">任务配置和运行中心记录会从本机删除；已经生成的 XML、表格、附件及其他采集输出文件不会被删除。</p>
    <div class="dialog-actions">
      <t-button theme="default" variant="text" @click="pendingDeleteTaskId = ''">取消</t-button>
      <t-button theme="danger" @click="emit('confirm-remove')">删除任务</t-button>
    </div>
  </t-dialog>

  <t-dialog
    v-model:visible="exportTaskConfigsPrompt"
    header="导出全部任务配置？"
    theme="warning"
    :footer="false"
    width="500px"
    @closed="emit('closed')"
  >
    <p class="dialog-copy">将导出当前全部已保存任务的完整配置，包括 XML/表格模板、本地目录和请求头。Cookie、Authorization 等请求头可能包含敏感信息，请妥善保管导出的 JSON 文件。</p>
    <p v-if="hasUnsavedChanges" class="dialog-copy">当前任务存在未保存修改，本次只会导出上次保存的版本。</p>
    <div class="dialog-actions">
      <t-button theme="default" variant="text" @click="exportTaskConfigsPrompt = false">取消</t-button>
      <t-button theme="primary" @click="emit('export-configs')">选择保存位置</t-button>
    </div>
  </t-dialog>

  <t-dialog
    :visible="Boolean(taskConfigImportResult)"
    header="任务配置导入结果"
    :footer="false"
    width="560px"
    @closed="emit('closed')"
    @close="taskConfigImportResult = null"
  >
    <t-alert
      :theme="taskConfigImportResult?.skipped.length ? 'warning' : 'success'"
      :message="`成功导入 ${taskConfigImportResult?.imported.length ?? 0} 个任务，跳过 ${taskConfigImportResult?.skipped.length ?? 0} 个任务。`"
    />
    <div v-if="taskConfigImportResult?.skipped.length" class="task-import-failures">
      <strong>未导入项目</strong>
      <ol>
        <li v-for="item in taskConfigImportResult.skipped" :key="`${item.sourceIndex}-${item.name}`">
          第 {{ item.sourceIndex }} 项 · {{ item.name }}：{{ item.reason }}
        </li>
      </ol>
    </div>
    <div class="dialog-actions">
      <t-button theme="primary" @click="taskConfigImportResult = null">关闭</t-button>
    </div>
  </t-dialog>

  <t-dialog
    :visible="Boolean(cancelPromptTaskId)"
    header="取消这个任务？"
    theme="warning"
    :footer="false"
    width="440px"
    @closed="emit('closed')"
    @close="cancelPromptTaskId = ''"
  >
    <p class="dialog-copy">运行或暂停中的任务会写出当前有效记录并清除检查点；尚未启动的排队任务只会移出队列。</p>
    <div class="dialog-actions">
      <t-button theme="default" variant="text" @click="cancelPromptTaskId = ''">返回</t-button>
      <t-button theme="danger" variant="outline" @click="emit('confirm-cancel-run')">确认取消</t-button>
    </div>
  </t-dialog>

  <t-dialog
    v-model:visible="cancelAllPrompt"
    header="取消全部采集任务？"
    theme="danger"
    :footer="false"
    width="460px"
    :close-on-overlay-click="false"
    @closed="emit('closed')"
  >
    <p class="dialog-copy">确认后会取消所有运行中和暂停中的任务，并清空等待队列。各任务会按当前安全进度处理检查点和有效记录。</p>
    <div class="dialog-actions">
      <t-button theme="default" variant="text" @click="cancelAllPrompt = false">返回</t-button>
      <t-button theme="danger" @click="emit('confirm-cancel-all')">确认全部取消</t-button>
    </div>
  </t-dialog>
</template>

<style src="./style.css"></style>
