<script setup lang="ts">
import { InternetIcon } from 'tdesign-icons-vue-next'
import type { TaskConfig } from '@shared/types'
import type { ListPageRuleAnalysis } from '@shared/list-page-rules'
import type { PreviewOpenAction } from '@renderer/utils/preview-open-guard'

// 任务草稿通过 v-model 传入；子组件直接编辑嵌套字段（与 FieldMappingEditor 的约定一致）
const task = defineModel<TaskConfig>({ required: true })
const listPageRulesText = defineModel<string>('listPageRulesText', { required: true })

defineProps<{
  isClickPagination: boolean
  previewOpening: boolean
  previewOpenAction: PreviewOpenAction | null
  fixedListPageCount: number
  hasPaginationTemplate: boolean
  listPageRuleAnalysis: ListPageRuleAnalysis | null
}>()

const emit = defineEmits<{
  'open-list-preview': []
}>()
</script>

<template>
  <div class="step-heading">
    <span>01 / 05</span>
    <h1>定义采集入口</h1>
    <p>任务名称决定输出目录；列表 URL 用于预览、站内判断和分页建议。</p>
  </div>
  <div class="form-grid">
    <div class="field full">
      <span>任务名称</span>
      <t-input v-model="task.name" :maxlength="120" placeholder="例如：图片新闻" />
      <small>最终输出到“输出根目录 / {{ task.name || '任务名称' }}”。</small>
    </div>
    <div class="field full">
      <span>列表页面 URL（每行一条）</span>
      <div class="inline-control list-url-control">
        <t-textarea
          v-model="listPageRulesText"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :spell-check="false"
          :placeholder="isClickPagination ? '只填写一个动态列表初始 URL' : '固定地址或包含 {page} 的模板，每行一条'"
        />
        <t-button
          theme="default"
          variant="outline"
          :disabled="previewOpening"
          :loading="previewOpenAction === 'step-list'"
          @click="emit('open-list-preview')"
        >
          <template #icon>
            <InternetIcon />
          </template>
          打开预览
        </t-button>
      </div>
      <div class="list-rule-summary">
        <t-tag variant="light">
          {{ isClickPagination ? '动态初始地址' : '固定地址' }} {{ fixedListPageCount }} 条
        </t-tag>
        <t-tag v-if="isClickPagination" theme="warning" variant="light">点击下一页</t-tag>
        <t-tag v-if="hasPaginationTemplate" theme="primary" variant="light">分页模板 1 条</t-tag>
        <span v-if="listPageRuleAnalysis?.hostname">
          hostname：{{ listPageRuleAnalysis.hostname }}
        </span>
      </div>
      <t-alert
        v-if="listPageRuleAnalysis?.errors.length"
        theme="error"
        :message="listPageRuleAnalysis.errors.join('；')"
      />
      <small>
        {{ isClickPagination
          ? '动态模式只接受一个初始 URL，正式采集会执行页面脚本并读取最终渲染的列表。'
          : '按行顺序采集；固定 URL 各请求一次，最多一行可包含 {page}。' }}
      </small>
    </div>
  </div>
</template>
