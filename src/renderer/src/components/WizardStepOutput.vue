<script setup lang="ts">
import { AddIcon, DeleteIcon, FolderOpenIcon, PlayIcon, RefreshIcon } from 'tdesign-icons-vue-next'
import type {
  OutputFieldDefinition,
  TaskConfig,
  TestCollectionResult
} from '@shared/types'

// 任务草稿通过 v-model 传入；子组件直接编辑嵌套字段（与 FieldMappingEditor 的约定一致）
const task = defineModel<TaskConfig>({ required: true })

export interface WizardTableColumn {
  colKey: string
  title: string
  width: number
  ellipsis?: boolean
  fixed?: 'left'
}

defineProps<{
  isClickDetail: boolean
  testing: boolean
  activeTaskLocked: boolean
  busy: boolean
  saving: boolean
  activeOutputTemplate: { fields: OutputFieldDefinition[] } | null
  testResult: TestCollectionResult | null
  testMatchSummaries: Array<{ path: string; counts: string }>
  testTableData: Array<Record<string, unknown>>
  testTableColumns: WizardTableColumn[]
  testResourceTableData: Array<Record<string, unknown>>
  testResourceTableColumns: WizardTableColumn[]
}>()

const emit = defineEmits<{
  'set-custom-attributes': [value: string | number]
  'choose-resource-directory': []
  'add-resource-replacement': []
  'choose-output-directory': []
  'save-default-output-directory': []
  'add-header': []
  'run-test': []
  'request-run': []
}>()
</script>

<template>
  <div class="step-heading">
    <span>05 / 05</span>
    <h1>输出、请求与测试</h1>
    <p>最后确认资源处理、批次上限和网络参数，然后先执行一次小范围测试。</p>
  </div>

  <div class="section-line">
    <div class="section-title"><strong>资源处理</strong><span>可只改写地址，也可下载输出内容实际引用的站内资源</span></div>
    <div class="form-grid compact resource-mode-grid">
      <div class="field">
        <span>不下载时的地址处理方式</span>
        <t-select
          v-model="task.resources.addressMode"
          :disabled="task.resources.download.enabled"
        >
          <t-option value="absolute-replace" label="绝对地址 + 替换规则" />
          <t-option value="prefix" label="自定义前缀 + 原路径" />
        </t-select>
      </div>
      <div class="switch-line compact-switch resource-download-switch">
        <span><strong>下载资源</strong><small>默认关闭，仅处理最终输出引用</small></span>
        <t-switch v-model="task.resources.download.enabled" />
      </div>
    </div>
    <div class="check-row resource-cleaning-row">
      <t-checkbox v-model="task.html.cleanHtml">清理脚本、事件和 DocView 预览</t-checkbox>
      <t-checkbox
        v-if="!task.resources.download.enabled && task.resources.addressMode === 'absolute-replace'"
        v-model="task.html.absolutizeResources"
      >
        资源地址绝对化
      </t-checkbox>
    </div>
    <div class="field full">
      <span>补充资源属性（逗号分隔）</span>
      <t-input
        :value="task.html.customResourceAttributes.join(', ')"
        placeholder="例如 data-file, data-url"
        @change="emit('set-custom-attributes', $event)"
      />
    </div>

    <template v-if="task.resources.download.enabled">
      <t-alert
        class="resource-mode-note"
        theme="info"
        message="只下载与资源所属页面主机名完全相同的图片、音视频和附件；站外资源保持原地址。测试采集只预览计划，不会写文件。"
      />
      <div class="field full resource-field">
        <span>资源存放根目录</span>
        <div class="inline-control">
          <t-input v-model="task.resources.download.rootDirectory" readonly placeholder="请选择目录" />
          <t-button theme="default" variant="outline" @click="emit('choose-resource-directory')">
            <template #icon>
              <FolderOpenIcon />
            </template>
            选择目录
          </t-button>
        </div>
      </div>
      <div class="field full resource-field">
        <span>输出内容中的资源访问前缀</span>
        <t-input
          v-model="task.resources.download.urlPrefix"
          placeholder="例如 /resources 或 https://static.example.com/resources"
        />
        <small>本地目录按原资源路径建立；查询参数会生成稳定短标识，避免同名文件互相覆盖。</small>
      </div>
    </template>

    <div v-else-if="task.resources.addressMode === 'prefix'" class="field full resource-field">
      <span>自定义资源访问前缀</span>
      <t-input
        v-model="task.resources.urlPrefix"
        placeholder="例如 /resources 或 https://static.example.com/resources"
      />
      <small>站内资源会改为“前缀 + 原 URL 路径”；不会下载文件，也不会执行下面的替换规则。</small>
    </div>

    <template v-else>
      <div class="subheading">
        <span>有序路径替换</span>
        <t-button size="small" theme="default" variant="text" @click="emit('add-resource-replacement')">
          <template #icon>
            <AddIcon />
          </template>
          添加规则
        </t-button>
      </div>
      <div v-for="rule in task.resourceReplacements" :key="rule.id" class="replacement-line">
        <t-input v-model="rule.from" placeholder="原字符串" />
        <span>→</span>
        <t-input v-model="rule.to" placeholder="新字符串" />
        <t-tooltip content="删除替换规则" placement="top">
          <t-button
            theme="danger"
            variant="text"
            shape="square"
            @click="task.resourceReplacements.splice(task.resourceReplacements.indexOf(rule), 1)"
          >
            <DeleteIcon />
          </t-button>
        </t-tooltip>
      </div>
    </template>
  </div>

  <div class="section-line">
    <div class="section-title"><strong>采集输出</strong><span>采集结果会按设置的条数自动拆分成多个文件</span></div>
    <div class="field full">
      <span>输出根目录</span>
      <div class="inline-control">
        <t-input v-model="task.output.rootDirectory" readonly placeholder="请选择目录" />
        <t-button theme="default" variant="outline" @click="emit('choose-output-directory')">
          <template #icon>
            <FolderOpenIcon />
          </template>
          选择目录
        </t-button>
        <t-button theme="default" variant="text" @click="emit('save-default-output-directory')">
          设为全局默认
        </t-button>
      </div>
    </div>
    <div class="form-grid compact">
      <div class="field">
        <span>每个输出文件最多保存多少条</span>
        <t-input-number
          v-model="task.output.recordsPerFile"
          theme="column"
          :min="1"
          :max="200"
          :step="1"
          :decimal-places="0"
        />
      </div>
      <div class="switch-line compact-switch">
        <span><strong>覆盖旧结果</strong><small>默认开启</small></span>
        <t-switch v-model="task.output.overwrite" />
      </div>
    </div>
  </div>

  <div class="section-line">
    <div class="section-title">
      <strong>请求与并发</strong>
      <span>{{ isClickDetail ? '点击式详情按列表顺序逐条处理' : '列表页顺序请求，详情并发后仍按列表顺序输出' }}</span>
    </div>
    <div class="form-grid thirds">
      <div class="field">
        <span>超时（秒）</span>
        <t-input-number
          v-model="task.request.timeoutSeconds"
          theme="column"
          :min="5"
          :max="120"
          :step="1"
          :decimal-places="0"
        />
      </div>
      <div class="field">
        <span>详情并发</span>
        <t-input-number
          v-model="task.request.detailConcurrency"
          theme="column"
          :min="1"
          :max="5"
          :disabled="isClickDetail"
          :step="1"
          :decimal-places="0"
        />
        <small v-if="isClickDetail">点击后需返回原列表，因此固定为逐条采集。</small>
      </div>
      <div class="field">
        <span>请求延迟（毫秒）</span>
        <t-input-number
          v-model="task.request.delayMs"
          theme="column"
          :min="0"
          :step="100"
          :decimal-places="0"
        />
      </div>
      <div class="field">
        <span>编码覆盖</span>
        <t-select v-model="task.request.manualEncoding">
          <t-option value="" label="自动识别" />
          <t-option value="utf-8" label="UTF-8" />
          <t-option value="gbk" label="GBK" />
          <t-option value="gb2312" label="GB2312" />
          <t-option value="gb18030" label="GB18030" />
        </t-select>
      </div>
      <div class="field full">
        <span>User-Agent</span>
        <t-input v-model="task.request.userAgent" />
      </div>
    </div>
    <div class="subheading">
      <span>自定义请求头</span>
      <t-button size="small" theme="default" variant="text" @click="emit('add-header')">
        <template #icon>
          <AddIcon />
        </template>
        添加
      </t-button>
    </div>
    <div v-for="header in task.request.headers" :key="header.id" class="replacement-line header-line">
      <t-input v-model="header.key" placeholder="Referer" />
      <span>:</span>
      <t-input v-model="header.value" placeholder="值" />
      <t-tooltip content="删除请求头" placement="top">
        <t-button
          theme="danger"
          variant="text"
          shape="square"
          @click="task.request.headers.splice(task.request.headers.indexOf(header), 1)"
        >
          <DeleteIcon />
        </t-button>
      </t-tooltip>
    </div>
  </div>

  <div class="test-actions">
    <div><strong>测试采集</strong><span>读取当前列表页，并处理前 3 条记录。</span></div>
    <t-button
      theme="default"
      variant="outline"
      :loading="testing"
      :disabled="!activeOutputTemplate || activeTaskLocked"
      @click="emit('run-test')"
    >
      <template #icon>
        <RefreshIcon />
      </template>
      执行测试
    </t-button>
    <t-button
      theme="primary"
      :disabled="busy || saving || activeTaskLocked"
      @click="emit('request-run')"
    >
      <template #icon>
        <PlayIcon />
      </template>
      开始正式采集
    </t-button>
  </div>

  <div v-if="testResult" class="test-result">
    <div class="test-summary">
      <strong>测试结果</strong>
      <t-tag v-for="message in testResult.messages" :key="message" theme="success" variant="light">
        {{ message }}
      </t-tag>
    </div>
    <div v-if="testMatchSummaries.length" class="match-counts">
      <t-tag v-for="item in testMatchSummaries" :key="item.path" theme="default" variant="light">
        <strong>{{ item.path }}</strong> 匹配 {{ item.counts }}
      </t-tag>
    </div>
    <div v-if="testResult.rows.length" class="table-scroll">
      <t-table
        :data="testTableData"
        :columns="testTableColumns"
        row-key="__rowKey"
        size="small"
        table-layout="fixed"
        :bordered="true"
        :hover="true"
        :max-height="280"
      />
    </div>
    <t-collapse
      v-if="testResult.resourcePlans.length"
      class="result-collapse resource-plan-collapse"
      borderless
    >
      <t-collapse-panel
        value="resource-preview"
        :header="`资源计划（${testResult.resourcePlans.length} 个，不会实际下载）`"
      >
        <div class="resource-plan-table">
          <t-table
            :data="testResourceTableData"
            :columns="testResourceTableColumns"
            row-key="__rowKey"
            size="small"
            table-layout="fixed"
            :bordered="true"
            :hover="true"
            :max-height="300"
          />
        </div>
      </t-collapse-panel>
    </t-collapse>
    <t-collapse v-if="testResult.xmlPreview" class="result-collapse" borderless>
      <t-collapse-panel value="xml-preview" header="XML 预览">
        <pre>{{ testResult.xmlPreview }}</pre>
      </t-collapse-panel>
    </t-collapse>
    <div v-if="testResult.failures.length" class="failure-list">
      <strong>发现问题</strong>
      <p v-for="(failure, index) in testResult.failures" :key="index">
        第 {{ failure.itemIndex }} 条 · {{ failure.stage }}{{ failure.fieldPath ? ` / ${failure.fieldPath}` : '' }} ·
        {{ failure.reason }}
      </p>
    </div>
  </div>
</template>
