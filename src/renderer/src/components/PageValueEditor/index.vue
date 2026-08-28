<script setup lang="ts">
import { ref } from 'vue'
import { AddIcon, CursorIcon, DeleteIcon, SearchIcon } from 'tdesign-icons-vue-next'
import {
  CONTENT_FILTER_SELECTOR_PRESETS,
  normalizeContentFilterSelectors,
  splitContentFilterInput
} from '@shared/content-filter'
import type { PageExtractionConfig } from '@shared/types'

type PageEditorModel = PageExtractionConfig & { required?: boolean }

const model = defineModel<PageEditorModel>({ required: true })

withDefaults(defineProps<{ showRequired?: boolean; detailEnabled?: boolean }>(), {
  showRequired: false,
  detailEnabled: true
})

defineEmits<{
  pick: []
  evaluate: []
}>()

const addReplacement = (): void => {
  model.value.replacements.push({ id: crypto.randomUUID(), from: '', to: '' })
}

const changeLocatorType = (value: unknown): void => {
  if (value !== 'css' && value !== 'xpath' && value !== 'markers') return
  model.value.selectorType = value
  if (value === 'markers' && model.value.extraction === 'attribute') {
    model.value.extraction = 'html'
  }
}

const contentFilterOptions = CONTENT_FILTER_SELECTOR_PRESETS.map((selector) => ({
  label: selector,
  value: selector
}))
const contentFilterInput = ref('')
const contentFilterError = ref('')

const selectorValidationError = (selector: string): string => {
  try {
    document.createElement('div').querySelector(selector)
    return ''
  } catch {
    return `CSS 选择器“${selector}”无效，请修改后再添加`
  }
}

const appendContentFilterSelectors = (selectors: string[]): string => {
  const normalized = normalizeContentFilterSelectors(selectors)
  const invalid = normalized.find((selector) => selectorValidationError(selector))
  if (invalid) {
    contentFilterError.value = selectorValidationError(invalid)
    return invalid
  }
  model.value.contentFilterSelectors = normalizeContentFilterSelectors([
    ...model.value.contentFilterSelectors,
    ...normalized
  ])
  contentFilterError.value = ''
  return ''
}

const handleContentFilterInput = (value: string): void => {
  const { selectors, pending } = splitContentFilterInput(value)
  if (selectors.length === 0) {
    contentFilterInput.value = pending
    contentFilterError.value = ''
    return
  }
  const invalid = appendContentFilterSelectors(selectors)
  contentFilterInput.value = invalid || pending
}

const createContentFilterSelector = (value: string | number | boolean | bigint): void => {
  const selector = String(value).trim()
  const invalid = appendContentFilterSelectors([selector])
  contentFilterInput.value = invalid ? selector : ''
}

const setContentFilterSelectors = (value: unknown): void => {
  const selectors = normalizeContentFilterSelectors(value)
  const current = new Set(model.value.contentFilterSelectors)
  const invalid = selectors.find(
    (selector) => !current.has(selector) && selectorValidationError(selector)
  )
  if (invalid) {
    contentFilterError.value = selectorValidationError(invalid)
    contentFilterInput.value = invalid
    return
  }
  model.value.contentFilterSelectors = selectors
  contentFilterError.value = ''
}
</script>

<template>
  <div class="page-value-editor">
    <div class="field">
      <span>页面来源</span>
      <t-select v-model="model.pageSource">
        <t-option value="list" label="列表页（相对列表项）" />
        <t-option value="detail" label="详情页" :disabled="!detailEnabled" />
      </t-select>
      <small v-if="!detailEnabled && model.pageSource === 'detail'" class="detail-source-error">
        详情页采集已关闭，当前来源不可用，请改选“列表页”。
      </small>
    </div>
    <div class="field">
      <span>定位方式</span>
      <t-select v-model="model.selectorType" @change="changeLocatorType">
        <t-option value="css" label="CSS" />
        <t-option value="xpath" label="XPath 1.0" />
        <t-option value="markers" label="前后标记" />
      </t-select>
    </div>
    <div v-if="model.selectorType !== 'markers'" class="field selector-field full">
      <span>选择器</span>
      <div class="inline-control">
        <t-input v-model="model.selector" class="code-input" :spell-check="false" placeholder="例如 .title 或 .//h1" />
        <t-tooltip content="验证" placement="top">
          <t-button theme="default" variant="outline" @click="$emit('evaluate')">
            <template #icon>
              <SearchIcon />
            </template>
            验证
          </t-button>
        </t-tooltip>
        <t-tooltip content="点选" placement="top">
          <t-button theme="primary" variant="outline" @click="$emit('pick')">
            <template #icon>
              <CursorIcon />
            </template>
            点选
          </t-button>
        </t-tooltip>
      </div>
    </div>
    <template v-else>
      <div class="field marker-field full">
        <span>内容前标记</span>
        <t-textarea
          v-model="model.startMarker" class="code-input" :spell-check="false"
          :autosize="{ minRows: 2, maxRows: 8 }" placeholder="例如 <div class=&quot;details&quot;>"
        />
      </div>
      <div class="field marker-field full">
        <span>内容后标记</span>
        <t-textarea
          v-model="model.endMarker" class="code-input" :spell-check="false"
          :autosize="{ minRows: 3, maxRows: 10 }"
          placeholder="可输入包含注释、换行和多个标签的完整原文"
        />
      </div>
      <small class="marker-note full">
        按页面 HTML 原文匹配（区分大小写，空格和缩进需一致；CRLF/LF 换行可互相识别）；请使用“测试采集”查看结果。
      </small>
      <div class="switch-control full">
        <div>
          <strong>保存前后标记</strong>
          <span>关闭时只保存两个标记之间的内容；开启时将两个边界标记一并保存</span>
        </div>
        <t-switch v-model="model.includeMarkers" />
      </div>
    </template>
    <div class="field">
      <span>提取内容</span>
      <t-select v-model="model.extraction">
        <t-option value="text" label="文字内容（不含 HTML 标签）" />
        <t-option value="html" label="HTML 内容（保留排版和标签）" />
        <t-option
          v-if="model.selectorType !== 'markers'"
          value="attribute"
          label="标签属性（如链接、图片地址）"
        />
      </t-select>
    </div>
    <div
      v-if="model.selectorType !== 'markers' && model.extraction === 'attribute'"
      class="field"
    >
      <span>属性名</span>
      <t-input v-model="model.attribute" placeholder="href / src / content" />
    </div>
    <div
      v-else-if="model.selectorType !== 'markers' && model.extraction === 'text'"
      class="field text-prefix-field"
    >
      <span>文字标签定位（可选）</span>
      <t-input v-model="model.textPrefix" clearable placeholder="例如：发布时间" />
      <small>只填写标签文字，无需输入中文或英文冒号；同一节点有多个“标签：值”时会按标签区分，其他连接符暂不支持</small>
    </div>
    <div
      v-if="model.extraction !== 'attribute'"
      class="field content-filter-field full"
    >
      <span>过滤标签及内容</span>
      <t-select
        :value="model.contentFilterSelectors"
        :input-value="contentFilterInput"
        :options="contentFilterOptions"
        :status="contentFilterError ? 'error' : 'default'"
        :tips="contentFilterError || '可从下拉选择常用标签，也可输入 CSS 选择器后按逗号生成 Tag'"
        :tag-input-props="{ excessTagsDisplayType: 'break-line' }"
        multiple
        filterable
        creatable
        clearable
        placeholder="例如 h1、.share、#advertisement"
        @change="setContentFilterSelectors"
        @create="createContentFilterSelector"
        @input-change="handleContentFilterInput"
      />
    </div>
    <div class="field">
      <span>{{ model.selectorType === 'markers' ? '多段处理' : '多元素处理' }}</span>
      <t-select v-model="model.matchMode">
        <t-option
          value="first" :label="model.selectorType === 'markers' ? '只取第一段' : '只取第一个'"
        />
        <t-option
          value="all" :label="model.selectorType === 'markers' ? '合并全部匹配段' : '合并全部'"
        />
      </t-select>
    </div>
    <div v-if="model.matchMode === 'all'" class="field">
      <span>合并分隔符</span>
      <t-input v-model="model.separator" />
    </div>
    <div class="check-line full">
      <t-checkbox v-if="showRequired" v-model="model.required">必填，无值时跳过记录</t-checkbox>
      <t-checkbox v-model="model.trim">去除首尾空白</t-checkbox>
      <t-checkbox
        v-if="model.extraction === 'text'"
        v-model="model.collapseWhitespace"
      >
        合并连续空白
      </t-checkbox>
    </div>
    <div class="timestamp-control full">
      <div>
        <strong>转为毫秒时间戳</strong>
        <span>仅转换当前字段；正文、标题及其他未开启字段保持原样</span>
      </div>
      <t-switch v-model="model.convertToTimestamp" />
    </div>
    <div class="replace-block full">
      <div class="subheading">
        <span>字段字符串替换</span>
        <t-button size="small" theme="default" variant="text" @click="addReplacement">
          <template #icon>
            <AddIcon />
          </template>
          添加
        </t-button>
      </div>
      <div v-for="rule in model.replacements" :key="rule.id" class="replacement-line">
        <t-input v-model="rule.from" placeholder="原字符串" />
        <span>→</span>
        <t-input v-model="rule.to" placeholder="新字符串" />
        <t-tooltip content="删除替换规则" placement="top">
          <t-button
            theme="danger" variant="text" shape="square"
            @click="model.replacements.splice(model.replacements.indexOf(rule), 1)"
          >
            <DeleteIcon />
          </t-button>
        </t-tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-value-editor {
  display: grid;
  min-width: 0;
  grid-column: 1 / -1;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 13px;
}

.full {
  grid-column: 1 / -1;
}

.field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;

}

.field>span,
.subheading>span {
  color: #536067;
  font-size: 10px;
  font-weight: 700;
}

.inline-control {
  display: flex;
  min-width: 0;
  gap: 7px;
}

.inline-control .t-input {
  min-width: 0;
  flex: 1;
}

.code-input :deep(input),
.code-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.marker-note {
  color: #7a878d;
  font-size: 10px;
  line-height: 1.5;
}

.content-filter-field :deep(.t-tag-input) {
  min-height: 34px;
}

.text-prefix-field small {
  color: #7a878d;
  font-size: 11px;
  line-height: 1.4;
}

.detail-source-error {
  color: var(--td-error-color, #c64747);
  font-size: 10px;
  line-height: 1.5;
}

.check-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 2px 0;
}

.check-line :deep(.t-checkbox__label) {
  font-size: 10px;
}

.timestamp-control,
.switch-control {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  padding: 9px 11px;
  border: 1px solid #dfe6e7;
  border-radius: 6px;
  background: #fff;
  gap: 12px;
}

.timestamp-control>div,
.switch-control>div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.timestamp-control strong,
.switch-control strong {
  color: var(--ink);
  font-size: 11px;
}

.timestamp-control span,
.switch-control span {
  color: var(--muted);
  font-size: 9px;
  line-height: 1.5;
}

.replace-block {
  padding-top: 2px;
}

.subheading,
.replacement-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.subheading {
  justify-content: space-between;
  margin-bottom: 7px;
}

.replacement-line+.replacement-line {
  margin-top: 7px;
}

.replacement-line .t-input {
  min-width: 0;
  flex: 1;
}

.replacement-line>span {
  color: #929da2;
}

@media (max-width: 1280px) {
  .page-value-editor {
    grid-template-columns: 1fr;
  }

  .full {
    grid-column: 1;
  }
}
</style>
