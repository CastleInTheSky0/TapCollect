<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AccessProfile, AccessProfileInput } from '@shared/access-profile'
import { useAppStore } from '@renderer/store'

const dirty = defineModel<boolean>('dirty', { default: false })
const { accessProfileStore: store } = useAppStore()
const { profiles, busy, error } = store
const draft = ref<AccessProfileInput | null>(null)
const baseline = ref('')
const confirmation = ref<{ kind: 'delete' | 'clear'; profile: AccessProfile } | null>(null)
const cookieTarget = ref<AccessProfile | null>(null)
const cookieJson = ref('')
watch([draft, cookieJson], () => { dirty.value = (draft.value !== null && JSON.stringify(draft.value) !== baseline.value) || Boolean(cookieJson.value) }, { deep: true })
const beginEdit = (profile?: AccessProfile): void => {
  draft.value = profile
    ? { id: profile.id, name: profile.name, origin: profile.origin, userAgent: profile.userAgent, language: profile.language }
    : { id: '', name: '', origin: '', userAgent: '', language: '' }
  baseline.value = JSON.stringify(draft.value)
}
const save = async (): Promise<void> => { if (draft.value && await store.save(draft.value)) draft.value = null }
const confirm = async (): Promise<void> => {
  const action = confirmation.value
  if (!action) return
  if (await (action.kind === 'delete' ? store.remove(action.profile.id) : store.clear(action.profile.id))) confirmation.value = null
}
const closeCookies = (): void => { cookieTarget.value = null; cookieJson.value = '' }
const importCookies = async (): Promise<void> => {
  if (cookieTarget.value && await store.importCookies(cookieTarget.value.id, cookieJson.value)) closeCookies()
}
const statusLabel = (profile: AccessProfile): string => profile.storageStatus === 'encrypted' ? 'Cookie 加密保存' : profile.storageStatus === 'memory-only' ? '仅本次启动有效' : 'Cookie 无法读取'
const confirmationBody = computed(() => confirmation.value?.kind === 'delete'
  ? '删除配置及其登录状态。仍被任务绑定的配置不能删除，请先解除绑定。'
  : '清除该配置的 Cookie 和浏览器存储，关闭相关预览。下次访问需要重新登录；已保存的任务配置不变。')
</script>

<template>
  <div class="access-profiles">
    <t-alert v-if="error" theme="error" :message="error" />
    <t-alert theme="info" title="在预览中登录后复用 Cookie" message="为任务选择同一访问配置，预览、静态请求和动态采集即可共用会话。不同配置相互隔离；同一主机仍共享访问节奏与保护。" />
    <div class="profile-toolbar">
      <t-button :disabled="Boolean(draft) || busy" @click="beginEdit()">新建访问配置</t-button>
      <t-button theme="default" variant="text" :disabled="busy" @click="store.refresh">刷新会话状态</t-button>
    </div>
    <section v-if="draft" class="profile-editor">
      <h3>{{ draft.id ? '编辑访问配置' : '新建访问配置' }}</h3>
      <div class="form-grid">
        <label class="field full"><span>配置名称</span><t-input v-model="draft.name" aria-label="配置名称" :maxlength="80" /></label>
        <label class="field full"><span>来源</span><t-input v-model="draft.origin" aria-label="访问配置来源" :disabled="Boolean(draft.id)" placeholder="https://example.com" /><small>仅协议、主机和可选端口。创建后固定；跨来源资源不携带该配置的凭据。</small></label>
        <label class="field full"><span>User-Agent 覆盖（可选）</span><t-input v-model="draft.userAgent" aria-label="User-Agent 覆盖" placeholder="留空继承全局自动 UA 或任务 UA" :maxlength="512" /></label>
        <label class="field full"><span>请求语言覆盖（可选）</span><t-input v-model="draft.language" aria-label="请求语言覆盖" placeholder="留空继承全局请求语言" :maxlength="512" /></label>
      </div>
      <div class="profile-actions"><t-button theme="default" variant="outline" :disabled="busy" @click="draft = null">取消编辑</t-button><t-button :loading="busy" @click="save">保存访问配置</t-button></div>
    </section>
    <p v-if="!profiles.length" class="settings-footnote">尚无访问配置。未绑定的任务继续使用原有独立会话。</p>
    <section v-for="profile in profiles" :key="profile.id" class="profile-row">
      <div class="profile-copy"><strong>{{ profile.name }}</strong><p>{{ profile.origin }}</p><small>{{ profile.cookieCount }} 个 Cookie · {{ statusLabel(profile) }}</small></div>
      <div class="profile-actions">
        <t-button theme="default" variant="text" :disabled="Boolean(draft) || busy" @click="beginEdit(profile)">编辑</t-button>
        <t-button theme="default" variant="text" :disabled="busy || profile.storageStatus === 'unreadable'" @click="cookieTarget = profile">导入 Cookie</t-button>
        <t-button theme="default" variant="text" :disabled="busy" @click="confirmation = { kind: 'clear', profile }">清除登录状态</t-button>
        <t-button theme="danger" variant="text" :disabled="busy" @click="confirmation = { kind: 'delete', profile }">删除</t-button>
      </div>
      <t-alert v-if="profile.storageStatus !== 'encrypted'" theme="warning" :message="profile.storageStatus === 'memory-only' ? '当前系统安全存储不可用，Cookie 仅在本次启动内保留，不写入明文文件。' : '无法读取或保存本机加密 Cookie。请检查系统安全存储和数据目录；需要重建会话时使用“清除登录状态”。'" />
    </section>
    <p class="settings-footnote">配置被排队、运行、暂停或测试任务使用时不能编辑、删除或导入/清除 Cookie。空闲配置修改前会关闭相关预览。Cookie 在本机加密保存，其他浏览器存储仅在本次启动内保留；移动到另一系统账户后可能需要清除并重新登录。</p>
    <t-dialog :visible="Boolean(confirmation)" :header="confirmation?.kind === 'delete' ? '删除访问配置' : '清除登录状态'" :body="confirmationBody" :confirm-btn="{ content: '确认', loading: busy }" @confirm="confirm" @cancel="confirmation = null" @close="confirmation = null" />
    <t-dialog :visible="Boolean(cookieTarget)" header="导入 Cookie" width="640px" :confirm-btn="{ content: '导入 Cookie', loading: busy, disabled: !cookieJson.trim() }" @confirm="importCookies" @cancel="closeCookies" @close="closeCookies">
      <p>粘贴 JSON 数组。仅接受当前来源主机的 Cookie，导入按名称和路径更新；不会显示已有 Cookie 的值。</p>
      <t-textarea v-model="cookieJson" aria-label="Cookie JSON" :autosize="{ minRows: 7, maxRows: 12 }" :spell-check="false" placeholder="[{&quot;name&quot;:&quot;session&quot;,&quot;value&quot;:&quot;填入值&quot;,&quot;path&quot;:&quot;/&quot;,&quot;httpOnly&quot;:true}]" />
      <p class="settings-footnote">支持 name、value、domain、path、secure、httpOnly、sameSite、expirationDate（Unix 秒）。过期值、父域、非法属性或重复项会被拒绝。</p>
    </t-dialog>
  </div>
</template>

<style scoped>
.profile-toolbar, .profile-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.profile-toolbar { margin: 24px 0 12px; }
.profile-editor { padding: 20px; border: 1px solid var(--line); border-radius: 8px; margin: 20px 0; }
.profile-editor h3 { margin-top: 0; }
.profile-editor .profile-actions { justify-content: flex-end; margin-top: 20px; }
.profile-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 20px 0; border-bottom: 1px solid var(--line); }
.profile-row > .t-alert { width: 100%; }
.profile-copy { flex: 1; min-width: 180px; overflow-wrap: anywhere; }
.profile-copy p { margin: 7px 0; color: var(--muted); }
.profile-copy small { color: var(--muted); }
</style>
