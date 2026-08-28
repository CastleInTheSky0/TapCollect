<script setup lang="ts">
import { FileCodeIcon, FileExcelIcon, FolderOpenIcon } from 'tdesign-icons-vue-next'
import type { TaskConfig, XmlTreeNode } from '@shared/types'
import FieldMappingEditor from '@renderer/components/FieldMappingEditor/index.vue'

// 任务草稿通过 v-model 传入；子组件直接编辑嵌套字段（与 FieldMappingEditor 的约定一致）
const task = defineModel<TaskConfig>({ required: true })

defineProps<{
  unresolvedMappings: number
  flatXmlTree: Array<{ node: XmlTreeNode; depth: number }>
}>()

const emit = defineEmits<{
  'change-output-format': []
  'import-xml': []
  'select-record': [node: XmlTreeNode]
  'import-spreadsheet': []
  pick: [fieldPath: string, mergeValueId?: string]
  evaluate: [fieldPath: string, mergeValueId?: string]
}>()

// FieldMappingEditor 的事件载荷为 (字段路径, 可选合并项 id)，原样向上转发
const forwardPick = (fieldPath: string, mergeValueId?: string): void => {
  emit('pick', fieldPath, mergeValueId)
}

const forwardEvaluate = (fieldPath: string, mergeValueId?: string): void => {
  emit('evaluate', fieldPath, mergeValueId)
}

const updateXmlFieldCdata = (fieldPath: string, value: boolean): void => {
  const field = task.value.xml?.fields.find((candidate) => candidate.path === fieldPath)
  if (field) field.cdata = value
}
</script>

<template>
  <div class="step-heading mapping-heading">
    <span>04 / 05</span>
    <h1>输出模板与字段映射</h1>
    <p>选择 XML 或 Excel 表格。字段清单完全来自模板，不根据字段名自动猜测采集含义。</p>
  </div>
  <div class="output-format-picker">
    <div><strong>导出格式</strong><span>一个任务选择一种输出格式</span></div>
    <t-radio-group
      v-model="task.output.format"
      variant="default-filled"
      @change="emit('change-output-format')"
    >
      <t-radio-button value="xml">XML</t-radio-button>
      <t-radio-button value="spreadsheet">Excel 表格</t-radio-button>
    </t-radio-group>
  </div>

  <template v-if="task.output.format === 'xml'">
    <div class="template-toolbar">
      <div>
        <strong>{{ task.xml?.fileName || '尚未导入模板' }}</strong>
        <span v-if="task.xml?.recordPath">
          记录节点 {{ task.xml.recordPath }} · {{ task.xml.encoding }}
        </span>
        <span v-else>导入完整合法 XML 后选择一条示例记录节点</span>
      </div>
      <t-button theme="default" variant="outline" @click="emit('import-xml')">
        <template #icon>
          <FileCodeIcon />
        </template>
        {{ task.xml ? '重新导入' : '导入 XML 模板' }}
      </t-button>
    </div>

    <div v-if="task.xml" class="xml-workbench">
      <aside class="xml-tree">
        <div class="pane-label">XML 树</div>
        <t-button
          v-for="entry in flatXmlTree"
          :key="entry.node.path"
          theme="default"
          variant="text"
          block
          :class="{ selected: task.xml.recordPath === entry.node.path }"
          :style="{ paddingLeft: `${10 + entry.depth * 14}px` }"
          @click="emit('select-record', entry.node)"
        >
          <span>{{ entry.node.kind === 'attribute' ? '@' : '‹›' }}</span>
          {{ entry.node.name }}
        </t-button>
      </aside>
      <div class="mapping-pane">
        <div class="mapping-pane-head">
          <div><strong>字段处理</strong><span>每个字段必须明确选择一种处理方式</span></div>
          <t-tag :theme="unresolvedMappings === 0 ? 'success' : 'warning'" variant="light">
            {{ unresolvedMappings ? `${unresolvedMappings} 项待配置` : '全部已配置' }}
          </t-tag>
        </div>
        <FieldMappingEditor
          v-if="task.xml.recordPath"
          :fields="task.xml.fields"
          :mappings="task.xml.mappings"
          @pick="forwardPick"
          @evaluate="forwardEvaluate"
          @update-cdata="updateXmlFieldCdata"
        />
        <div v-else class="mapping-empty">请先从左侧 XML 树中选择单条记录节点。</div>
      </div>
    </div>
    <div v-else class="large-empty">
      <FileCodeIcon size="34px" />
      <strong>导入你的 XML 模板</strong>
      <p>模板固定节点、注释、命名空间和 CDATA 规则会保留。</p>
      <t-button theme="primary" @click="emit('import-xml')">
        <template #icon>
          <FolderOpenIcon />
        </template>
        选择 XML 文件
      </t-button>
    </div>
  </template>

  <template v-else>
    <div class="template-toolbar">
      <div>
        <strong>{{ task.spreadsheet?.fileName || '尚未导入模板' }}</strong>
        <span v-if="task.spreadsheet">
          工作表：{{ task.spreadsheet.sheetName }} ·
          {{ task.spreadsheet.format.toUpperCase() }} ·
          {{ task.spreadsheet.fields.length }} 列
        </span>
        <span v-else>第一行作为列名，第二行起写入采集记录</span>
      </div>
      <t-button theme="default" variant="outline" @click="emit('import-spreadsheet')">
        <template #icon>
          <FileExcelIcon />
        </template>
        {{ task.spreadsheet ? '重新导入' : '导入表格模板' }}
      </t-button>
    </div>

    <div v-if="task.spreadsheet" class="spreadsheet-workbench">
      <div class="mapping-pane">
        <div class="mapping-pane-head">
          <div><strong>列字段处理</strong><span>列名来自模板第一行，列字母用于区分重复名称</span></div>
          <t-tag :theme="unresolvedMappings === 0 ? 'success' : 'warning'" variant="light">
            {{ unresolvedMappings ? `${unresolvedMappings} 项待配置` : '全部已配置' }}
          </t-tag>
        </div>
        <FieldMappingEditor
          :fields="task.spreadsheet.fields"
          :mappings="task.spreadsheet.mappings"
          @pick="forwardPick"
          @evaluate="forwardEvaluate"
        />
      </div>
    </div>
    <div v-else class="large-empty">
      <FileExcelIcon size="34px" />
      <strong>导入 XLSX 或 XLS 模板</strong>
      <p>使用首个工作表，第一行非空单元格会生成可映射列。</p>
      <t-button theme="primary" @click="emit('import-spreadsheet')">
        <template #icon>
          <FolderOpenIcon />
        </template>
        选择表格文件
      </t-button>
    </div>
  </template>
</template>
