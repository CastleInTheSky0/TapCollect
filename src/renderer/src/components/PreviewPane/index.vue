<script setup lang="ts">
import { CloseIcon, InternetIcon } from 'tdesign-icons-vue-next'
import type { VNodeRef } from 'vue'
import type { PreviewOpenAction } from '@renderer/utils/preview-open-guard'

// 预览地址通过 v-model 与 App.vue 双向绑定
const previewUrl = defineModel<string>('previewUrl', { required: true })

defineProps<{
  inactive: boolean
  pickingLabel: string
  previewStatus: string
  previewVisible: boolean
  previewOpening: boolean
  previewOpenAction: PreviewOpenAction | null
  showListButton: boolean
  // 预览边界元素由 App.vue 持有 ref（布局 composable 与 ResizeObserver 依赖它测量位置），
  // 这里通过函数型 ref 把元素写回 App.vue
  surfaceRef: VNodeRef
}>()

const emit = defineEmits<{
  'open-preview': []
  'open-list-preview': []
  'close-preview': []
}>()
</script>

<template>
  <aside class="preview-pane" :aria-hidden="inactive" :inert="inactive">
    <header class="preview-header">
      <div><span>网页预览</span><strong>{{ pickingLabel || previewStatus }}</strong></div>
      <t-tooltip v-if="previewVisible" content="关闭预览" placement="left">
        <t-button
          theme="default"
          variant="text"
          shape="square"
          :disabled="previewOpening"
          @click="emit('close-preview')"
        >
          <CloseIcon />
        </t-button>
      </t-tooltip>
    </header>
    <div class="preview-address">
      <t-input
        v-model="previewUrl"
        :spell-check="false"
        :disabled="previewOpening"
        placeholder="输入 HTTP/HTTPS 地址"
        @enter="emit('open-preview')"
      >
        <template #prefix-icon>
          <InternetIcon />
        </template>
      </t-input>
      <t-button
        theme="primary"
        :disabled="previewOpening"
        :loading="previewOpenAction === 'address'"
        @click="emit('open-preview')"
      >
        前往
      </t-button>
    </div>
    <div :ref="surfaceRef" class="preview-surface" :class="{ active: previewVisible }">
      <div class="preview-placeholder">
        <div class="browser-glyph"><span /><span /><span /></div>
        <strong>{{ previewVisible ? '正在加载网页预览…' : '隔离网页预览' }}</strong>
        <p>远程网页无法访问 Node.js 或本地文件。<br />打开列表页后可直接点选元素。</p>
        <t-button
          v-if="!previewVisible && showListButton"
          theme="default"
          variant="outline"
          :disabled="previewOpening"
          :loading="previewOpenAction === 'placeholder-list'"
          @click="emit('open-list-preview')"
        >
          <template #icon>
            <InternetIcon />
          </template>
          打开列表页
        </t-button>
      </div>
    </div>
    <footer class="preview-footer">
      <span class="status-light" />静态模式读取原始 HTML；动态模式读取页面渲染后的 DOM
    </footer>
  </aside>
</template>

<style src="./style.css"></style>
