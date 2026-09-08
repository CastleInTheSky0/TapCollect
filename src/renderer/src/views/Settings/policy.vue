<script setup lang="ts">
import type { AppSettings } from '@shared/types'
const model = defineModel<AppSettings>({ required: true })
defineProps<{ section: string }>()
</script>

<template>
  <template v-if="section === 'concurrency'">
    <t-alert theme="info" title="同一站点统一调度" message="列表、详情、资源下载和动态页面操作共享全局限制，任务中的并发设置不能突破这里的上限。" />
    <section class="settings-section">
      <h3>并发上限</h3>
      <div class="setting-row"><div class="setting-copy"><strong>同时运行任务数</strong><p>调整后立即调度排队任务，降低上限不会中断已运行任务。</p></div><div class="setting-control"><t-input-number v-model="model.maxConcurrentRuns" aria-label="同时运行任务数" :min="1" :max="5" :decimal-places="0" /><span>个任务</span></div></div>
      <div class="setting-row"><div class="setting-copy"><strong>全局网络并发</strong><p>所有采集任务和测试采集合计的请求上限。</p></div><div class="setting-control"><t-input-number v-model="model.access.globalConcurrency" aria-label="全局网络并发" :min="1" :max="32" :decimal-places="0" /><span>个请求</span></div></div>
      <div class="setting-row"><div class="setting-copy"><strong>单站点并发上限</strong><p>同一主机名同时访问的请求数量，建议保持为 1。</p></div><div class="setting-control"><t-input-number v-model="model.access.hostConcurrency" aria-label="单站点并发上限" :min="1" :max="Math.min(5, model.access.globalConcurrency)" :decimal-places="0" /><span>个请求</span></div></div>
      <div class="setting-row"><div class="setting-copy"><strong>资源下载并发</strong><p>图片与附件下载同时受全局和单站点并发限制。</p></div><div class="setting-control"><t-input-number v-model="model.access.resourceConcurrency" aria-label="资源下载并发" :min="1" :max="model.access.globalConcurrency" :decimal-places="0" /><span>个资源</span></div></div>
    </section>
  </template>
  <template v-else-if="section === 'pacing'">
    <t-alert theme="info" title="任务可以配置得更慢" message="实际间隔取全局最小请求间隔与任务请求间隔中的较大值，再增加随机等待。" />
    <section class="settings-section">
      <h3>访问间隔</h3>
      <div class="setting-row"><div class="setting-copy"><strong>最小请求间隔</strong><p>同一站点两次请求开始之间至少等待的时间。</p></div><div class="setting-control"><t-input-number v-model="model.access.minIntervalMs" aria-label="最小请求间隔" :min="0" :max="60000" :step="100" :decimal-places="0" /><span>毫秒</span></div></div>
      <div class="setting-row"><div class="setting-copy"><strong>随机等待幅度</strong><p>只增加等待，不会缩短最小间隔。例如 1000 毫秒与 20% 对应 1000–1200 毫秒。</p></div><div class="setting-control"><t-input-number v-model="model.access.jitterPercent" aria-label="随机等待幅度" :min="0" :max="100" :step="5" :decimal-places="0" /><span>%</span></div></div>
    </section>
    <p class="settings-footnote">动态页面的打开、点击详情、返回列表和翻页统一排队；页面内部自行发起的图片、脚本等请求由浏览器管理。</p>
  </template>
  <template v-else-if="section === 'protection'">
    <t-alert theme="info" title="保留进度后暂停" message="站点进入冷却时，受影响任务保存安全检查点。冷却结束后先恢复一个任务探测，再恢复其他任务。" />
    <section class="settings-section">
      <h3>重试与退避</h3>
      <div class="setting-row"><div class="setting-copy"><strong>遵循 Retry-After</strong><p>服务器要求等待时暂停该站点，不受下方最大退避时间限制。</p></div><t-tag theme="default" variant="light">始终开启</t-tag></div>
      <div class="setting-row"><div class="setting-copy"><strong>最大重试次数</strong><p>列表和详情请求遇到网络错误、408、425、429 和 5xx 时的额外尝试次数。</p></div><div class="setting-control"><t-input-number v-model="model.access.maxRetries" aria-label="最大重试次数" :min="0" :max="10" :decimal-places="0" /><span>次</span></div></div>
      <div class="setting-row">
        <div class="setting-copy"><strong>资源下载重试次数</strong><p>附件、图片等资源下载遇到网络错误、408、425 或 5xx 时，最多额外重试 0–5 次，默认 3 次；0 表示只尝试一次。400、404 等错误及可识别的错误提示网页直接跳过，失败写入日志并继续采集。限流和访问验证仍暂停。</p></div>
        <div class="setting-control"><t-input-number v-model="model.access.resourceMaxRetries" aria-label="资源下载重试次数" :min="0" :max="5" :decimal-places="0" /><span>次</span></div>
      </div>
      <div class="setting-row"><div class="setting-copy"><strong>初始退避时间</strong><p>重试使用指数退避，并加入随机等待。</p></div><div class="setting-control"><t-input-number v-model="model.access.retryBaseMs" aria-label="初始退避时间" :min="100" :max="60000" :step="100" :decimal-places="0" /><span>毫秒</span></div></div>
      <div class="setting-row"><div class="setting-copy"><strong>最大退避时间</strong><p>单次普通重试等待的上限。</p></div><div class="setting-control"><t-input-number v-model="model.access.retryMaxMs" aria-label="最大退避时间" :min="model.access.retryBaseMs" :max="300000" :step="1000" :decimal-places="0" /><span>毫秒</span></div></div>
    </section>
    <section class="settings-section">
      <h3>站点保护</h3>
      <div class="setting-row"><div class="setting-copy"><strong>连续失败阈值</strong><p>同一站点的页面请求连续达到此次数后进入冷却；普通资源下载失败按重试上限跳过。</p></div><div class="setting-control"><t-input-number v-model="model.access.failureThreshold" aria-label="连续失败阈值" :min="1" :max="20" :decimal-places="0" /><span>次</span></div></div>
      <div class="setting-row"><div class="setting-copy"><strong>站点冷却时间</strong><p>普通熔断的等待时间；动态页面临时错误也会进入冷却。</p></div><div class="setting-control"><t-input-number v-model="model.access.cooldownSeconds" aria-label="站点冷却时间" :min="5" :max="86400" :step="5" :decimal-places="0" /><span>秒</span></div></div>
      <div class="setting-row"><div class="setting-copy"><strong>识别 HTTP 200 验证页</strong><p>结合标题、表单与验证提示识别，避免将验证页当成空列表。</p></div><t-switch v-model="model.access.detectChallenges" aria-label="识别 HTTP 200 验证页" /></div>
      <div class="setting-row"><div class="setting-copy"><strong>需要人工处理时</strong><p>401、403 或验证页会暂停采集；检查访问条件后，在运行中心手动重试。</p></div><t-tag theme="warning" variant="light">暂停并提示</t-tag></div>
    </section>
  </template>
  <template v-else-if="section === 'network'">
    <section class="settings-section">
      <h3>浏览器身份</h3>
      <div class="setting-row"><div class="setting-copy"><strong>自动匹配浏览器 UA</strong><p>采集使用当前内置 Chromium 的身份；关闭后使用任务中配置的 User-Agent。</p></div><t-switch v-model="model.access.automaticUserAgent" aria-label="自动匹配浏览器 UA" /></div>
      <div class="setting-row"><div class="setting-copy"><strong>请求语言</strong><p>应用于采集与网页预览的 Accept-Language。</p></div><t-select v-model="model.access.language" aria-label="请求语言" :options="[{ label: '简体中文优先', value: 'zh-CN,zh;q=0.9,en;q=0.7' }, { label: '繁体中文优先', value: 'zh-TW,zh;q=0.9,en;q=0.7' }, { label: '英语优先', value: 'en-US,en;q=0.9' }]" /></div>
    </section>
    <section class="settings-section">
      <h3>诊断与数据</h3>
      <div class="setting-row"><div class="setting-copy"><strong>敏感信息脱敏</strong><p>运行诊断中的认证信息及常见敏感 URL 参数会隐藏。</p></div><t-tag theme="default" variant="light">始终开启</t-tag></div>
      <div class="setting-row"><div class="setting-copy"><strong>会话与登录</strong><p>绑定同一访问配置的预览与采集共用 Cookie；未绑定任务保留独立会话。在“访问配置”中管理，在任务“基本信息”中绑定。</p></div><t-tag theme="default" variant="light">按配置隔离</t-tag></div>
    </section>
  </template>
</template>
