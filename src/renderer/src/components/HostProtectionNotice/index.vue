<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RunSessionItem } from '@shared/types'
const props = defineProps<{ item: RunSessionItem; affected?: number }>()
const emit = defineEmits<{ pause: []; resume: [] }>()
const now = ref(Date.now())
let timer: number | undefined
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { window.clearInterval(timer) })
const seconds = computed(() => Math.max(0, Math.ceil(((props.item.protection?.until ?? 0) - now.value) / 1000)))
</script>

<template>
  <section v-if="item.protection" class="host-protection-notice" aria-live="polite">
    <div>
      <strong>{{ item.protection.kind === 'cooling' ? '站点冷却中' : '需要人工处理' }} · {{ item.protection.hostname }}</strong>
      <p>{{ item.protection.reason }}</p>
      <small>{{ item.status === 'pausing' ? '正在保存安全检查点' : item.status === 'queued' ? '任务等待站点恢复' : '已保留安全检查点' }}<template v-if="affected"> · 影响 {{ affected }} 个任务</template></small>
    </div>
    <div class="protection-actions">
      <template v-if="item.protection.kind === 'cooling'">
        <span>{{ seconds > 0 ? `${seconds} 秒后尝试恢复` : '等待恢复探测' }}</span>
        <t-button v-if="item.status === 'paused'" theme="default" variant="outline" size="small" @click="emit('pause')">停止自动恢复</t-button>
      </template>
      <t-button v-else :disabled="!['paused', 'queued'].includes(item.status)" theme="primary" size="small" @click="emit('resume')">检查后重试</t-button>
    </div>
  </section>
</template>

<style scoped>
.host-protection-notice { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 12px 0; padding: 16px 18px; background: #fff8ed; border-left: 3px solid var(--warning); border-radius: 5px; }
.host-protection-notice strong { font-size: 13px; color: #865c22; }
.host-protection-notice p { margin: 7px 0; line-height: 1.6; font-size: 12px; }
.host-protection-notice small { color: var(--muted); font-size: 11px; }
.protection-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 9px; flex-shrink: 0; }
.protection-actions > span { color: #865c22; font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
