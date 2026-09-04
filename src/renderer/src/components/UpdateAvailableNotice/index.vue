<script setup lang="ts">
import type { UpdateCheckResult } from '@shared/types'

defineProps<{
  visible: boolean
  result: UpdateCheckResult | null
}>()

const emit = defineEmits<{
  dismiss: []
  open: []
}>()
</script>

<template>
  <aside v-if="visible && result?.status === 'available'" class="update-available-notice" aria-live="polite">
    <t-alert theme="info" :title="`发现新版本 v${result.release.version}`" close @close="emit('dismiss')">
      <template #operation>
        <span @click="emit('open')">查看更新</span>
      </template>
    </t-alert>
  </aside>
</template>

<style scoped>
.update-available-notice {
  position: fixed;
  top: 16px;
  left: 50%;
  z-index: 5500;
  width: min(540px, calc(100vw - 32px));
  transform: translateX(-50%);
}

.update-available-notice :deep(.t-alert) {
  border: 1px solid var(--td-brand-color-3);
  box-shadow: 0 12px 32px rgba(23, 55, 61, 0.18);
}
</style>
