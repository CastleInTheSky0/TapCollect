<script setup lang="ts">
import { ChevronRightIcon, CursorIcon, InternetIcon, LinkIcon, SearchIcon } from 'tdesign-icons-vue-next'
import type { OutputFieldDefinition, TaskConfig } from '@shared/types'
import type { PreviewOpenAction } from '../preview-open-guard'

// 任务草稿通过 v-model 传入；子组件直接编辑嵌套字段（与 FieldMappingEditor 的约定一致）
const task = defineModel<TaskConfig>({ required: true })

defineProps<{
  isClickDetail: boolean
  listHostname: string
  previewOpening: boolean
  previewOpenAction: PreviewOpenAction | null
  detailSamples: string[]
  detailSampleIndex: number
  activeOutputTemplate: { fields: OutputFieldDefinition[] } | null
  outputFieldLabel: (field: OutputFieldDefinition) => string
}>()

const emit = defineEmits<{
  evaluate: [target: 'detail-link']
  pick: [target: 'detail-link']
  'open-detail-first': []
  'open-detail-next': []
}>()
</script>

<template>
  <div class="step-heading">
    <span>03 / 05</span>
    <h1>详情链接与详情字段</h1>
    <p>站内链接会请求详情；不同完整 hostname 的链接保留为外链，不访问目标页面。</p>
  </div>
  <div class="switch-line">
    <span><strong>启用详情页采集</strong><small>关闭后只采列表字段，并选择一个输出字段作为去重键。</small></span>
    <t-switch v-model="task.detail.enabled" />
  </div>
  <div v-if="task.detail.enabled" class="section-line">
    <div class="detail-navigation-picker">
      <div>
        <strong>进入详情方式</strong>
        <span>有链接读取地址；没有链接时模拟点击列表元素</span>
      </div>
      <t-radio-group v-model="task.detail.navigationMode" variant="default-filled">
        <t-radio-button value="link">读取链接</t-radio-button>
        <t-radio-button value="click">点击元素</t-radio-button>
      </t-radio-group>
    </div>
    <div class="section-title">
      <strong>{{ isClickDetail ? '详情点击元素' : '详情链接' }}</strong>
      <span>相对于每一个列表项容器选择</span>
    </div>
    <div class="selector-grid" :class="{ 'link-grid': !isClickDetail }">
      <t-select v-model="task.detail.link.selectorType">
        <t-option value="css" label="CSS" />
        <t-option value="xpath" label="XPath 1.0" />
      </t-select>
      <t-input
        v-model="task.detail.link.selector"
        class="code-input"
        :spell-check="false"
        :placeholder="isClickDetail ? '例如 .detail-trigger' : '例如 a.title'"
      />
      <t-input
        v-if="!isClickDetail"
        v-model="task.detail.linkAttribute"
        class="code-input"
        placeholder="href"
      />
      <t-tooltip content="验证" placement="top">
        <t-button
          :aria-label="isClickDetail ? '验证详情点击元素选择器' : '验证详情链接选择器'"
          theme="default"
          variant="outline"
          @click="emit('evaluate', 'detail-link')"
        >
          <SearchIcon />
        </t-button>
      </t-tooltip>
      <t-tooltip content="点选" placement="top">
        <t-button
          :aria-label="isClickDetail ? '点选详情点击元素' : '点选详情链接'"
          theme="primary"
          variant="outline"
          @click="emit('pick', 'detail-link')"
        >
          <CursorIcon />
        </t-button>
      </t-tooltip>
    </div>
    <div
      v-if="
        !isClickDetail &&
          task.detail.link.selectorType === 'css' &&
          task.detail.link.selector.trim() === ':scope'
      "
      class="selector-result-note"
    >
      <LinkIcon />
      <span>
        <strong>已选中列表项自身链接</strong>
        采集时会直接读取每个列表项的 {{ task.detail.linkAttribute || 'href' }} 地址。
      </span>
    </div>
    <div v-if="!isClickDetail" class="host-rule">
      <LinkIcon />
      <span>站内判断</span>
      <strong>只比较完整 hostname</strong>
      <t-tag theme="primary" variant="light">{{ listHostname }}</t-tag>
    </div>
    <div class="sample-actions">
      <t-button
        size="small"
        theme="default"
        variant="outline"
        :disabled="previewOpening"
        :loading="previewOpenAction === 'detail-first'"
        @click="emit('open-detail-first')"
      >
        <template #icon>
          <InternetIcon />
        </template>
        打开第一条有效详情
      </t-button>
      <t-button
        size="small"
        theme="default"
        variant="outline"
        :disabled="previewOpening || !detailSamples.length"
        :loading="previewOpenAction === 'detail-next'"
        @click="emit('open-detail-next')"
      >
        下一条样例
        <template #suffix>
          <ChevronRightIcon />
        </template>
      </t-button>
      <span v-if="detailSamples.length">
        {{ detailSampleIndex + 1 }} / {{ detailSamples.length }}
      </span>
    </div>
  </div>
  <div v-else class="section-line">
    <div class="field">
      <span>本次运行去重字段</span>
      <t-select v-model="task.dedupeFieldPath" placeholder="请选择输出字段">
        <t-option
          v-for="field in activeOutputTemplate?.fields || []"
          :key="field.path"
          :value="field.path"
          :label="outputFieldLabel(field)"
        />
      </t-select>
    </div>
  </div>
  <div v-if="task.detail.navigationMode === 'link'" class="scope-note">
    <strong>外链记录仍会输出</strong>
    <span>详情页字段为空；可把“外链 URL”来源映射到模板中的任意一个字段。</span>
  </div>
</template>
