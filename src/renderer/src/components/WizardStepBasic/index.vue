<script setup lang="ts">
import { InternetIcon } from 'tdesign-icons-vue-next'
import { computed } from 'vue'
import type { AccessProfile } from '@shared/access-profile'
import { profileMatchesUrl } from '@shared/access-profile'
import type { TaskConfig } from '@shared/types'
import type { ListPageRuleAnalysis } from '@shared/list-page-rules'
import type { PreviewOpenAction } from '@renderer/utils/preview-open-guard'

// 任务草稿通过 v-model 传入；子组件直接编辑嵌套字段（与 FieldMappingEditor 的约定一致）
const task = defineModel<TaskConfig>({ required: true })
const listPageRulesText = defineModel<string>('listPageRulesText', { required: true })

const props = defineProps<{
  accessProfiles: AccessProfile[]
  accessProfileError: string
  isClickPagination: boolean
  previewOpening: boolean
  previewOpenAction: PreviewOpenAction | null
  fixedListPageCount: number
  hasPaginationTemplate: boolean
  listPageRuleAnalysis: ListPageRuleAnalysis | null
}>()

const emit = defineEmits<{
  'manage-profiles': []
  'open-list-preview': []
}>()
const selectedProfile = computed(() => props.accessProfiles.find(profile => profile.id === task.value.accessProfileId))
const missingProfile = computed(() => Boolean(task.value.accessProfileId) && !selectedProfile.value)
const profileOptions = computed(() => [
  { label: '不使用访问配置', value: '' },
  ...(missingProfile.value ? [{ label: '绑定的访问配置不存在，请重新选择', value: task.value.accessProfileId!, disabled: true }] : []),
  ...props.accessProfiles.map(profile => ({ label: `${profile.name} · ${profile.origin}`, value: profile.id }))
])
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
    <div class="field full">
      <span>访问配置</span>
      <div class="inline-control">
        <t-select v-model="task.accessProfileId" aria-label="任务访问配置" :options="profileOptions" />
        <t-button theme="default" variant="outline" @click="emit('manage-profiles')">管理访问配置</t-button>
      </div>
      <t-alert v-if="accessProfileError || missingProfile" theme="error" :message="accessProfileError || '绑定的访问配置不存在，预览、测试和运行前请重新选择或解除绑定。'" />
      <t-alert v-else-if="selectedProfile && task.listUrl && !profileMatchesUrl(selectedProfile, task.listUrl)" theme="warning" message="列表地址与配置来源不匹配，预览和采集前请修正。" />
      <small>{{ selectedProfile ? '同一配置共用预览与采集的 Cookie；修改绑定后请保存任务并重新打开预览。' : '未绑定时保持原有行为，预览登录不会带入采集。' }}</small>
    </div>
  </div>
</template>
