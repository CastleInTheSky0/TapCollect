<script setup lang="ts">
import { AddIcon, CursorIcon, DeleteIcon, SearchIcon } from 'tdesign-icons-vue-next'
import type { PageExtractionConfig } from '@shared/types'

type PageEditorModel = PageExtractionConfig & { required?: boolean }

const model = defineModel<PageEditorModel>({ required: true })

withDefaults(defineProps<{ showRequired?: boolean }>(), {
  showRequired: false
})

defineEmits<{
  pick: []
  evaluate: []
}>()

const addReplacement = (): void => {
  model.value.replacements.push({ id: crypto.randomUUID(), from: '', to: '' })
}
</script>

<template>
  <div class="page-value-editor">
    <div class="field">
      <span>页面来源</span>
      <t-select v-model="model.pageSource">
        <t-option value="list" label="列表页（相对列表项）" />
        <t-option value="detail" label="详情页" />
      </t-select>
    </div>
    <div class="field">
      <span>选择器类型</span>
      <t-select v-model="model.selectorType">
        <t-option value="css" label="CSS" />
        <t-option value="xpath" label="XPath 1.0" />
      </t-select>
    </div>
    <div class="field selector-field full">
      <span>选择器</span>
      <div class="inline-control">
        <t-input
          v-model="model.selector"
          class="code-input"
          :spell-check="false"
          placeholder="例如 .title 或 .//h1"
        />
        <t-button theme="default" variant="outline" @click="$emit('evaluate')">
          <template #icon><SearchIcon /></template>
          验证
        </t-button>
        <t-button theme="primary" variant="outline" @click="$emit('pick')">
          <template #icon><CursorIcon /></template>
          点选
        </t-button>
      </div>
    </div>
    <div class="field">
      <span>提取内容</span>
      <t-select v-model="model.extraction">
        <t-option value="text" label="文字内容（不含 HTML 标签）" />
        <t-option value="html" label="HTML 内容（保留排版和标签）" />
        <t-option value="attribute" label="标签属性（如链接、图片地址）" />
      </t-select>
    </div>
    <div v-if="model.extraction === 'attribute'" class="field">
      <span>属性名</span>
      <t-input v-model="model.attribute" placeholder="href / src / content" />
    </div>
    <div class="field">
      <span>多元素处理</span>
      <t-select v-model="model.matchMode">
        <t-option value="first" label="只取第一个" />
        <t-option value="all" label="合并全部" />
      </t-select>
    </div>
    <div v-if="model.matchMode === 'all'" class="field">
      <span>合并分隔符</span>
      <t-input v-model="model.separator" />
    </div>
    <div class="check-line full">
      <t-checkbox v-if="showRequired" v-model="model.required">必填，无值时跳过记录</t-checkbox>
      <t-checkbox v-model="model.trim">去除首尾空白</t-checkbox>
      <t-checkbox v-if="model.extraction === 'text'" v-model="model.collapseWhitespace">
        合并连续空白
      </t-checkbox>
    </div>
    <div class="replace-block full">
      <div class="subheading">
        <span>字段字符串替换</span>
        <t-button size="small" theme="default" variant="text" @click="addReplacement">
          <template #icon><AddIcon /></template>
          添加
        </t-button>
      </div>
      <div v-for="rule in model.replacements" :key="rule.id" class="replacement-line">
        <t-input v-model="rule.from" placeholder="原字符串" />
        <span>→</span>
        <t-input v-model="rule.to" placeholder="新字符串" />
        <t-tooltip content="删除替换规则" placement="top">
          <t-button
            theme="danger"
            variant="text"
            shape="square"
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

.field > span,
.subheading > span {
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

.code-input :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
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

.replacement-line + .replacement-line {
  margin-top: 7px;
}

.replacement-line .t-input {
  min-width: 0;
  flex: 1;
}

.replacement-line > span {
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
