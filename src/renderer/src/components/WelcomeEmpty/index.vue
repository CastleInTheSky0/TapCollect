<script setup lang="ts">
import { AddIcon, FileCodeIcon } from 'tdesign-icons-vue-next'

const emit = defineEmits<{
  create: []
}>()
</script>

<template>
  <div class="welcome-empty">
    <FileCodeIcon size="42px" />
    <span>网页 → XML / Excel</span>
    <h1>创建第一个采集任务</h1>
    <p>配置列表、可选详情、分页和输出模板字段映射。</p>
    <t-button theme="primary" @click="emit('create')">
      <template #icon>
        <AddIcon />
      </template>
      新建任务
    </t-button>
  </div>
</template>
