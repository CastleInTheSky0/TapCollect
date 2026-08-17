<script setup lang="ts">
import { ref } from 'vue'
import { AddIcon, DeleteIcon } from 'tdesign-icons-vue-next'
import { createMergeValue, isFieldMappingConfigured } from '@shared/field-mapping'
import type { FieldMapping, OutputFieldDefinition } from '@shared/types'
import PageValueEditor from './PageValueEditor.vue'

const props = defineProps<{
  fields: OutputFieldDefinition[]
  mappings: FieldMapping[]
}>()

defineEmits<{
  pick: [fieldPath: string, mergeValueId?: string]
  evaluate: [fieldPath: string, mergeValueId?: string]
}>()

const expanded = ref<Array<string | number>>([])

const modeLabels: Record<FieldMapping['mode'], string> = {
  unconfigured: '待配置',
  page: '页面采集',
  fixed: '固定值',
  system: '系统值',
  merge: '合并值',
  preserve: '保留示例',
  empty: '输出为空',
  'external-url': '外链 URL'
}

const fieldFor = (mapping: FieldMapping): OutputFieldDefinition | undefined =>
  props.fields.find((field) => field.path === mapping.fieldPath)

const fieldPathLabel = (mapping: FieldMapping): string => {
  const field = fieldFor(mapping)
  return field && 'column' in field ? `${String(field.column)} 列` : mapping.fieldPath
}

const addMergeValue = (mapping: FieldMapping): void => {
  mapping.mergeValues.push(createMergeValue(crypto.randomUUID()))
}

const ensureMergeValues = (mapping: FieldMapping): void => {
  if (mapping.mode === 'merge' && mapping.mergeValues.length === 0) addMergeValue(mapping)
}

const moveMergeValue = (mapping: FieldMapping, index: number, offset: number): void => {
  const target = index + offset
  if (target < 0 || target >= mapping.mergeValues.length) return
  const [value] = mapping.mergeValues.splice(index, 1)
  if (value) mapping.mergeValues.splice(target, 0, value)
}
</script>

<template>
  <t-collapse
    v-model="expanded" class="mapping-list" borderless expand-icon-placement="right"
    :expand-on-row-click="true"
  >
    <t-collapse-panel
      v-for="mapping in mappings" :key="mapping.fieldPath" :value="mapping.fieldPath"
      class="mapping-row" :class="{ unresolved: !isFieldMappingConfigured(mapping) }"
    >
      <template #header>
        <div class="mapping-summary">
          <span class="field-identity">
            <span class="field-name-line">
              <strong>{{ fieldFor(mapping)?.name || mapping.fieldPath }}</strong>
              <t-tag v-if="fieldFor(mapping)?.cdata" size="small" theme="primary" variant="light">
                CDATA
              </t-tag>
            </span>
            <small>{{ fieldPathLabel(mapping) }}</small>
          </span>
          <t-tag size="small" :theme="isFieldMappingConfigured(mapping) ? 'default' : 'warning'" variant="light">
            {{ modeLabels[mapping.mode] }}
          </t-tag>
        </div>
      </template>

      <div class="mapping-detail">
        <div class="field full">
          <span>字段处理方式</span>
          <t-select v-model="mapping.mode" @change="ensureMergeValues(mapping)">
            <t-option value="unconfigured" label="请选择处理方式" disabled />
            <t-option value="page" label="页面采集" />
            <t-option value="fixed" label="固定值" />
            <t-option value="system" label="系统值" />
            <t-option value="external-url" label="外链 URL" />
            <t-option value="merge" label="合并值" />
            <t-option value="preserve" label="保留模板示例值" />
            <t-option value="empty" label="输出为空" />
          </t-select>
        </div>

        <PageValueEditor
          v-if="mapping.mode === 'page'" :model-value="mapping" show-required
          @pick="$emit('pick', mapping.fieldPath)" @evaluate="$emit('evaluate', mapping.fieldPath)"
        />

        <div v-else-if="mapping.mode === 'merge'" class="merge-editor full">
          <div class="merge-settings">
            <div class="field">
              <span>字段合并分隔符</span>
              <t-input v-model="mapping.mergeSeparator" placeholder="默认直接拼接，例如： - " />
            </div>
            <div class="check-line">
              <t-checkbox v-model="mapping.required">合并结果必填，无值时跳过记录</t-checkbox>
            </div>
          </div>
          <t-alert theme="info" message="按下面的顺序拼接非空子值；空子值会自动忽略，不产生多余分隔符。" />
          <div v-for="(value, index) in mapping.mergeValues" :key="value.id" class="merge-value-card">
            <div class="merge-value-header">
              <strong>合并项 {{ index + 1 }}</strong>
              <div class="merge-value-actions">
                <t-button
                  size="small" theme="default" variant="text" :disabled="index === 0"
                  @click="moveMergeValue(mapping, index, -1)"
                >
                  上移
                </t-button>
                <t-button
                  size="small" theme="default" variant="text"
                  :disabled="index === mapping.mergeValues.length - 1" @click="moveMergeValue(mapping, index, 1)"
                >
                  下移
                </t-button>
                <t-tooltip content="删除合并项" placement="top">
                  <t-button
                    size="small" theme="danger" variant="text" shape="square"
                    @click="mapping.mergeValues.splice(index, 1)"
                  >
                    <DeleteIcon />
                  </t-button>
                </t-tooltip>
              </div>
            </div>
            <div class="field full">
              <span>子值类型</span>
              <t-select v-model="value.mode">
                <t-option value="page" label="页面采集" />
                <t-option value="fixed" label="固定值" />
                <t-option value="system" label="系统值" />
                <t-option value="external-url" label="外链 URL" />
              </t-select>
            </div>
            <PageValueEditor
              v-if="value.mode === 'page'" :model-value="value"
              @pick="$emit('pick', mapping.fieldPath, value.id)"
              @evaluate="$emit('evaluate', mapping.fieldPath, value.id)"
            />
            <div v-else-if="value.mode === 'fixed'" class="field full">
              <span>固定值</span>
              <t-textarea v-model="value.fixedValue" :autosize="{ minRows: 2, maxRows: 6 }" />
            </div>
            <div v-else-if="value.mode === 'system'" class="field full">
              <span>系统值</span>
              <t-select v-model="value.systemValue">
                <t-option value="list-url" label="当前列表 URL" />
                <t-option value="detail-url" label="当前详情 URL" />
                <t-option value="collected-at" label="采集时间（ISO）" />
              </t-select>
            </div>
            <t-alert v-else class="mapping-note full" theme="info" message="站外记录使用补全后的外链 URL；站内记录此子值为空。" />
          </div>
          <t-button theme="default" variant="dashed" block @click="addMergeValue(mapping)">
            <template #icon>
              <AddIcon />
            </template>
            添加合并项
          </t-button>
        </div>

        <div v-else-if="mapping.mode === 'fixed'" class="field full">
          <span>固定值</span>
          <t-textarea v-model="mapping.fixedValue" :autosize="{ minRows: 3, maxRows: 7 }" />
        </div>

        <div v-else-if="mapping.mode === 'system'" class="field full">
          <span>系统值</span>
          <t-select v-model="mapping.systemValue">
            <t-option value="list-url" label="当前列表 URL" />
            <t-option value="detail-url" label="当前详情 URL" />
            <t-option value="collected-at" label="采集时间（ISO）" />
          </t-select>
        </div>

        <t-alert
          v-else-if="mapping.mode === 'external-url'" class="mapping-note full" theme="info"
          message="站外链接不请求详情；补全后的绝对地址写入此字段。站内记录输出为空。"
        />
        <t-alert
          v-else-if="mapping.mode === 'preserve'" class="mapping-note full" theme="info"
          :message="`输出模板中的示例值：${fieldFor(mapping)?.sampleValue || '（空）'}`"
        />
        <t-alert
          v-else-if="mapping.mode === 'empty'" class="mapping-note full" theme="info"
          message="该字段会保留节点结构并输出为空。"
        />
      </div>
    </t-collapse-panel>
  </t-collapse>
</template>

<style scoped>
.mapping-list {
  border-top: 1px solid var(--line);
}

.mapping-row {
  position: relative;
  border-bottom: 1px solid var(--line);
  background: #fff;
}

.mapping-row.unresolved::before {
  position: absolute;
  z-index: 2;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--warning);
  content: '';
}

.mapping-row :deep(.t-collapse-panel__header) {
  min-height: 54px;
  padding: 0 12px 0 14px;
  background: #fff;
}

.mapping-row :deep(.t-collapse-panel__header:hover) {
  background: #f7f9f9;
}

.mapping-row :deep(.t-collapse-panel__content) {
  padding: 0;
}

.mapping-row :deep(.t-collapse-panel__body) {
  padding: 0;
}

.mapping-summary {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.field-identity {
  min-width: 0;
  flex: 1;
}

.field-name-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.field-identity strong,
.field-identity small {
  display: block;
}

.field-identity strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field-identity small {
  overflow: hidden;
  margin-top: 3px;
  color: var(--muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field-name-line :deep(.t-tag),
.mapping-summary> :deep(.t-tag) {
  height: 19px;
  flex: 0 0 auto;
  padding: 0 6px;
  font-size: 9px;
}

.mapping-detail {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 13px;
  padding: 15px 18px 19px 34px;
  border-top: 1px solid #edf0f1;
  background: #f8faf9;
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

.mapping-note :deep(.t-alert__message) {
  font-size: 10px;
  line-height: 1.6;
}

.merge-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
}

.merge-settings {
  display: grid;
  align-items: end;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
}

.merge-value-card {
  display: grid;
  min-width: 0;
  padding: 13px;
  border: 1px solid #dfe6e7;
  border-radius: 7px;
  background: #fff;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.merge-value-header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  grid-column: 1 / -1;
  gap: 8px;
}

.merge-value-header strong {
  color: var(--ink);
  font-size: 11px;
}

.merge-value-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

@media (max-width: 1280px) {
  .mapping-detail {
    padding-left: 22px;
  }

  .merge-settings,
  .merge-value-card {
    grid-template-columns: 1fr;
  }

  .merge-value-header,
  .merge-value-card>.full {
    grid-column: 1;
  }
}
</style>
