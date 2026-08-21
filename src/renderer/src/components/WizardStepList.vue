<script setup lang="ts">
import { ChevronRightIcon, CursorIcon, SearchIcon } from 'tdesign-icons-vue-next'
import type { PaginationParameter, TaskConfig } from '@shared/types'
import type { ListPageRuleAnalysis } from '@shared/list-page-rules'

type StepListTarget = 'list-item' | 'next-button'

// 任务草稿通过 v-model 传入；子组件直接编辑嵌套字段（与 FieldMappingEditor 的约定一致）
const task = defineModel<TaskConfig>({ required: true })

defineProps<{
  isClickPagination: boolean
  hasPaginationTemplate: boolean
  listPageRuleAnalysis: ListPageRuleAnalysis | null
  paginationSuggestions: PaginationParameter[]
}>()

const emit = defineEmits<{
  'change-pagination-mode': []
  evaluate: [target: StepListTarget]
  pick: [target: StepListTarget]
  'detect-pagination': []
  'apply-suggestion': [suggestion: PaginationParameter]
  'sync-metadata': [task: TaskConfig]
}>()
</script>

<template>
  <div class="step-heading">
    <span>02 / 05</span>
    <h1>列表结构与分页</h1>
    <p>先选一条完整列表记录，再用相对选择器采集每条记录中的字段。</p>
  </div>
  <div class="section-line">
    <div class="section-title">
      <strong>分页方式</strong><span>静态地址规则或动态点击下一页</span>
    </div>
    <t-select v-model="task.pagination.mode" @change="emit('change-pagination-mode')">
      <t-option value="url" label="固定 URL / 数字页码模板" />
      <t-option value="click" label="点击下一页（动态渲染）" />
    </t-select>
  </div>
  <div class="section-line">
    <div class="section-title"><strong>列表项容器</strong><span>重复出现的一整条记录</span></div>
    <div class="selector-grid">
      <t-select v-model="task.listItem.selectorType">
        <t-option value="css" label="CSS" />
        <t-option value="xpath" label="XPath 1.0" />
      </t-select>
      <t-input
        v-model="task.listItem.selector"
        class="code-input"
        :spell-check="false"
        placeholder="例如 .ListItem"
      />
      <t-tooltip content="验证" placement="top">
        <t-button
          aria-label="验证列表项选择器"
          theme="default"
          variant="outline"
          @click="emit('evaluate', 'list-item')"
        >
          <SearchIcon />
        </t-button>
      </t-tooltip>
      <t-tooltip content="点选" placement="top">
        <t-button
          aria-label="点选列表项容器"
          theme="primary"
          variant="outline"
          @click="emit('pick', 'list-item')"
        >
          <CursorIcon />
        </t-button>
      </t-tooltip>
    </div>
  </div>
  <div v-if="!isClickPagination" class="section-line">
    <div class="section-title">
      <strong>数字页码规则</strong><span>支持路径、文件名或查询参数中的 {page}</span>
    </div>
    <t-button size="small" theme="default" variant="outline" @click="emit('detect-pagination')">
      <template #icon>
        <SearchIcon />
      </template>
      扫描 URL 数值参数
    </t-button>
    <div v-if="paginationSuggestions.length" class="suggestion-list">
      <t-button
        v-for="suggestion in paginationSuggestions"
        :key="suggestion.name"
        class="suggestion-item"
        theme="default"
        variant="text"
        block
        @click="emit('apply-suggestion', suggestion)"
      >
        <span class="suggestion-copy">
          <strong>{{ suggestion.name }} = {{ suggestion.value }}</strong>
          <code>{{ suggestion.template }}</code>
        </span>
        <ChevronRightIcon />
      </t-button>
    </div>
    <div v-if="hasPaginationTemplate" class="pagination-template">
      <span>当前分页模板</span>
      <code>{{ listPageRuleAnalysis?.templateRule?.template }}</code>
    </div>
    <div v-if="hasPaginationTemplate" class="form-grid compact thirds">
      <div class="field">
        <span>起始值</span>
        <t-input-number
          v-model="task.pagination.startPage"
          theme="column"
          :step="1"
          :decimal-places="0"
          @change="emit('sync-metadata', task)"
        />
      </div>
      <div class="field">
        <span>变化步长</span>
        <t-input-number
          v-model="task.pagination.step"
          theme="column"
          :step="1"
          :decimal-places="0"
        />
        <small>正数递增，负数递减，不能为 0。</small>
      </div>
      <div class="field">
        <span>模板最大采集页数</span>
        <t-input-number
          v-model="task.pagination.maxPages"
          theme="column"
          :min="1"
          :step="1"
          :decimal-places="0"
        />
        <small>只限制模板生成页数，不限制固定 URL。</small>
      </div>
    </div>
    <p v-else class="inline-note">
      当前只配置了固定 URL，不需要填写起始值、步长和模板最大页数。
    </p>
    <p class="inline-note">
      模板遇到无列表项、URL 重复、404/410 或整页记录重复时会结束，并继续后面的固定 URL。
    </p>
  </div>
  <div v-else class="section-line">
    <div class="section-title">
      <strong>下一页按钮</strong><span>在整个页面中点选，只负责触发一次翻页</span>
    </div>
    <div class="selector-grid">
      <t-select v-model="task.pagination.nextButton.selectorType">
        <t-option value="css" label="CSS" />
        <t-option value="xpath" label="XPath 1.0" />
      </t-select>
      <t-input
        v-model="task.pagination.nextButton.selector"
        class="code-input"
        :spell-check="false"
        placeholder="例如 .next-page"
      />
      <t-tooltip content="验证" placement="top">
        <t-button
          aria-label="验证下一页按钮选择器"
          theme="default"
          variant="outline"
          @click="emit('evaluate', 'next-button')"
        >
          <SearchIcon />
        </t-button>
      </t-tooltip>
      <t-tooltip content="点选" placement="top">
        <t-button
          aria-label="点选下一页按钮"
          theme="primary"
          variant="outline"
          @click="emit('pick', 'next-button')"
        >
          <CursorIcon />
        </t-button>
      </t-tooltip>
    </div>
    <div class="form-grid compact">
      <div class="field">
        <span>最大采集页数</span>
        <t-input-number
          v-model="task.pagination.maxPages"
          theme="column"
          :min="1"
          :step="1"
          :decimal-places="0"
        />
        <small>包含初始页，用于防止按钮或页面脚本异常造成无限翻页。</small>
      </div>
    </div>
    <t-alert
      theme="info"
      message="工具等待列表内容发生变化后再采集下一页；接口返回 HTML、JSON 数组或 JSON 对象都不需要单独配置。"
    />
    <p class="inline-note">
      按钮缺失、禁用、列表不变、整页重复或达到最大页数时会自动结束。
    </p>
  </div>
</template>
