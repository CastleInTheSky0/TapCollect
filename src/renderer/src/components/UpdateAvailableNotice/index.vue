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
  width: fit-content;
  max-width: calc(100vw - 32px);
  transform: translateX(-50%);
}

.update-available-notice :deep(.t-alert) {
  align-items: center;
  border: 1px solid var(--line);
  background: var(--surface);
}

.update-available-notice :deep(.t-alert__content) {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.update-available-notice :deep(.t-alert__title),
.update-available-notice :deep(.t-alert__message) {
  width: auto;
}

.update-available-notice :deep(.t-alert__message) {
  align-items: center;
  margin-top: 0;
}

.update-available-notice :deep(.t-alert__description:empty) {
  display: none;
}

.update-available-notice :deep(.t-alert__operation) {
  display: flex;
  align-items: center;
  white-space: nowrap;
}
</style>
