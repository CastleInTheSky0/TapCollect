<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RunSessionItem } from '@shared/types'
const props = defineProps<{ item: RunSessionItem; affected?: number }>()
const emit = defineEmits<{ pause: []; openVerification: []; confirmVerification: [] }>()
const now = ref(Date.now())
let timer: number | undefined
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { window.clearInterval(timer) })
const seconds = computed(() => Math.max(0, Math.ceil(((props.item.protection?.until ?? 0) - now.value) / 1000)))
</script>

<template>
  <section v-if="item.protection || item.verification" class="host-protection-notice" aria-live="polite">
    <div>
      <strong>{{ item.verification ? '需要人工处理' : '站点冷却中' }} · {{ item.verification?.hostname ?? item.protection?.hostname }}</strong>
      <p>{{ item.protection?.reason }}</p>
      <p v-if="item.verification">{{ item.verification.message }}</p>
      <small>{{ item.status === 'pausing' ? '正在保存安全检查点' : item.status === 'queued' ? '任务等待站点恢复' : '已保留安全检查点' }}<template v-if="affected"> · 影响 {{ affected }} 个任务</template></small>
    </div>
    <div class="protection-actions">
      <template v-if="!item.verification && item.protection?.kind === 'cooling'">
        <span>{{ seconds > 0 ? `${seconds} 秒后尝试恢复` : '等待恢复探测' }}</span>
        <t-button v-if="item.status === 'paused'" theme="default" variant="outline" size="small" @click="emit('pause')">停止自动恢复</t-button>
      </template>
      <template v-else-if="item.verification">
        <span v-if="seconds > 0">至少等待 {{ seconds }} 秒后才能探测</span>
        <t-button :disabled="!item.verification.canOpen || !['paused', 'queued'].includes(item.status)" theme="default" variant="outline" size="small" @click="emit('openVerification')">{{ item.verification.windowOpen ? '返回验证页面' : '打开验证页面' }}</t-button>
        <t-button :disabled="!['paused', 'queued'].includes(item.status) || ['waiting', 'probing'].includes(item.verification.status)" :loading="item.verification.status === 'probing'" theme="primary" size="small" @click="emit('confirmVerification')">{{ item.verification.status === 'waiting' ? '等待验证探测' : '我已完成验证，尝试恢复' }}</t-button>
        <t-button v-if="['waiting', 'probing'].includes(item.verification.status)" theme="default" variant="text" size="small" @click="emit('pause')">停止验证后恢复</t-button>
      </template>
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
@media (max-width: 1100px) { .host-protection-notice { flex-wrap: wrap; } .protection-actions { align-items: flex-start; } }
</style>
