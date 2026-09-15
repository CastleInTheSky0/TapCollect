import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { setTimeout as wait } from 'node:timers/promises'
import PQueue from 'p-queue'
import { circuitBreaker, ConsecutiveBreaker, handleWhen, type CircuitBreakerPolicy } from 'cockatiel'
import { normalizeAccessPolicy, type AccessPolicySettings, type HostProtection } from '@shared/access-protection'
import type { RequestConfig } from '@shared/types'
import { AccessProtectionError, RequestInterruptedError, RetryableRequestError, parseRetryAfter } from '@main/core/access-errors'
import { detectBlockedPage } from '@main/core/block-detector'

export interface AccessRequestIdentity { userAgent: string; language: string; fetch: typeof fetch }
interface RequestContext { taskId: string; signal: AbortSignal | undefined; identity: AccessRequestIdentity | undefined; probeHostname?: string }
export interface AccessRequestTarget { taskId: string; url: string; resource: boolean }
interface HostState {
  queue: PQueue
  starts: PQueue
  breaker: CircuitBreakerPolicy
  lastStart: number
  touched: number
  taskIds: Set<string>
  targets: Map<string, AccessRequestTarget>
  protection?: HostProtection | undefined
}

/** 主进程共享调度器：所有任务和测试共用队列，任务取消信号通过异步上下文隔离。 */
export class AccessCoordinator extends EventEmitter {
  private readonly context = new AsyncLocalStorage<RequestContext>()
  private readonly hosts = new Map<string, HostState>()
  private readonly global = new PQueue({ concurrency: 8 })
  private readonly resources = new PQueue({ concurrency: 3 })
  settings = normalizeAccessPolicy(null)

  constructor(private readonly runtimeUserAgent: string) { super() }
  get userAgent(): string { return this.runtimeUserAgent }

  configure(settings: AccessPolicySettings): void {
    const previous = this.settings
    this.settings = normalizeAccessPolicy(settings)
    this.global.concurrency = this.settings.globalConcurrency
    this.resources.concurrency = this.settings.resourceConcurrency
    for (const [hostname, state] of this.hosts) {
      state.queue.concurrency = state.protection ? 1 : this.settings.hostConcurrency
      // 仅空闲且未受保护的站点更新熔断器，避免保存设置清除正在执行的保护。
      if (!state.protection && !state.queue.pending && !state.queue.size &&
        (previous.failureThreshold !== this.settings.failureThreshold || previous.cooldownSeconds !== this.settings.cooldownSeconds)) {
        state.breaker = this.createBreaker(hostname)
      }
    }
  }

  withContext<T>(taskId: string, signal: AbortSignal | undefined, operation: () => Promise<T>, identity?: AccessRequestIdentity): Promise<T> {
    return this.context.run({ taskId, signal, identity }, operation)
  }

  withManualProbe<T>(taskId: string, hostname: string, signal: AbortSignal, operation: () => Promise<T>, identity?: AccessRequestIdentity): Promise<T> {
    return this.context.run({ taskId, signal, identity, probeHostname: hostname }, operation)
  }

  assertUrlAllowed(url: string): void {
    const hostname = new URL(url).hostname.toLowerCase()
    this.assertAllowed(this.host(hostname), this.signal, this.context.getStore()?.probeHostname === hostname)
  }

  taskTarget(taskId: string, hostname: string): AccessRequestTarget | undefined {
    return this.hosts.get(hostname)?.targets.get(taskId)
  }

  get signal(): AbortSignal | undefined { return this.context.getStore()?.signal }
  get language(): string { return this.context.getStore()?.identity?.language ?? this.settings.language }
  transport(url: string, init: RequestInit, fallback: typeof fetch): Promise<Response> {
    return (this.context.getStore()?.identity?.fetch ?? fallback)(url, init)
  }

  requestConfig(config: RequestConfig): RequestConfig {
    const identity = this.context.getStore()?.identity
    return {
      ...config,
      userAgent: identity?.userAgent ?? (this.settings.automaticUserAgent ? this.runtimeUserAgent : config.userAgent),
      headers: config.headers.filter(({ key }) =>
        key.trim().toLowerCase() !== 'accept-language' && (!(identity || this.settings.automaticUserAgent) || key.trim().toLowerCase() !== 'user-agent'))
    }
  }

  getProtection(hostname: string): HostProtection | undefined {
    return this.hosts.get(hostname.toLowerCase())?.protection
  }

  hasVisited(taskId: string, hostname: string): boolean {
    return this.hosts.get(hostname)?.taskIds.has(taskId) ?? false
  }

  taskProtection(taskId: string, primaryHostname: string): HostProtection | undefined {
    return [...this.hosts.entries()]
      .filter(([hostname, state]) => hostname === primaryHostname || state.taskIds.has(taskId))
      .map(([, state]) => state.protection)
      .filter((value): value is HostProtection => Boolean(value))
      .sort((left, right) => Number(right.kind === 'action-required') - Number(left.kind === 'action-required') || right.until - left.until)[0]
  }

  forgetTask(taskId: string): void {
    for (const state of this.hosts.values()) { state.taskIds.delete(taskId); state.targets.delete(taskId) }
  }

  clearManual(hostname: string): void {
    const state = this.hosts.get(hostname.toLowerCase())
    if (state?.protection?.kind !== 'action-required') return
    if (state.protection.until > Date.now()) return
    state.protection = undefined
    state.breaker = this.createBreaker(hostname)
    state.queue.concurrency = this.settings.hostConcurrency
    this.emit('cleared', hostname)
  }

  protect(hostname: string, reason: string, until = 0, target?: AccessRequestTarget): AccessProtectionError {
    hostname = hostname.toLowerCase()
    const state = this.host(hostname)
    const existing = state.protection
    const protection: HostProtection = {
      hostname,
      kind: existing?.kind === 'action-required' || until === 0 ? 'action-required' : 'cooling',
      reason: existing?.kind === 'action-required' && until > 0 ? existing.reason : reason,
      until: Math.max(until, existing?.until ?? 0)
    }
    if (target) { state.taskIds.add(target.taskId); state.targets.set(target.taskId, target) }
    state.protection = protection
    state.queue.concurrency = 1
    this.emit('protected', protection, target)
    return new AccessProtectionError(protection)
  }

  inspectHtml(html: string, url: string, resource = false): void {
    if (!this.settings.detectChallenges) return
    const reason = detectBlockedPage(html, url)
    if (reason) throw this.protect(new URL(url).hostname, reason, 0, this.requestTarget(url, resource))
  }

  acknowledgeSuccess(url: string): void {
    const hostname = new URL(url).hostname.toLowerCase()
    const state = this.hosts.get(hostname)
    if (state?.protection?.kind === 'cooling' && state.protection.until <= Date.now()) this.clearCooling(hostname, state)
  }

  private requestTarget(url: string, resource: boolean): AccessRequestTarget | undefined {
    const taskId = this.context.getStore()?.taskId
    return taskId ? { taskId, url, resource } : undefined
  }

  private assertAllowed(state: HostState, signal?: AbortSignal, probe = false): void {
    if (state.protection && ((state.protection.kind === 'action-required' && !probe) || state.protection.until > Date.now())) {
      throw new AccessProtectionError(state.protection)
    }
    if (signal?.aborted) throw new RequestInterruptedError()
  }

  async run<T>(url: string, minimumDelay: number, operation: () => Promise<T>, resource = false): Promise<T> {
    // PQueue starts queued callbacks in the finishing request's async context.
    // Retain the submitting task's identity through all shared queue layers.
    const scopedOperation = AsyncLocalStorage.bind(operation)
    const hostname = new URL(url).hostname.toLowerCase()
    const state = this.host(hostname)
    const signal = this.signal
    const taskId = this.context.getStore()?.taskId
    const probe = this.context.getStore()?.probeHostname === hostname
    if (taskId) { state.taskIds.add(taskId); state.targets.set(taskId, { taskId, url, resource }) }
    this.assertAllowed(state, signal, probe)
    const execute = async (): Promise<T> => {
      this.assertAllowed(state, signal, probe)
      return await this.global.add(async () => {
        await state.starts.add(async () => {
          this.assertAllowed(state, signal, probe)
          const minimum = Math.max(this.settings.minIntervalMs, minimumDelay)
          const spacing = minimum + Math.round(minimum * this.settings.jitterPercent / 100 * Math.random())
          const deadline = state.lastStart + spacing
          // Timers can wake slightly early; retain the configured minimum interval.
          for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
            await wait(remaining, undefined, { signal })
          }
          this.assertAllowed(state, signal, probe)
          state.lastStart = Date.now()
        }, { signal })
        return scopedOperation()
      }, { signal }) as T
    }
    try {
      return await state.queue.add(async () => resource
        ? await this.resources.add(execute, { signal }) as T : execute(), { signal }) as T
    } catch (error) {
      if (state.protection && !probe) throw new AccessProtectionError(state.protection)
      if (signal?.aborted) throw new RequestInterruptedError()
      throw error
    } finally { state.touched = Date.now() }
  }

  /** 响应体读取/下载结束才释放并发名额，避免大附件只有响应头受到限速。 */
  fetch(url: string, config: RequestConfig, fetcher: () => Promise<Response>, resource: boolean): Promise<Response> {
    const hostname = new URL(url).hostname.toLowerCase()
    const state = this.host(hostname)
    const signal = this.signal
    return new Promise<Response>((resolve, reject) => {
      void this.run(url, config.delayMs, async () => {
        const request = async (): Promise<Response> => {
          let response: Response
          try { response = await fetcher() } catch (error) {
            if (signal?.aborted) throw new RequestInterruptedError()
            throw new RetryableRequestError(`网络请求失败：${error instanceof Error ? error.message : String(error)}`)
          }
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel()
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
            if (retryAfter > 0) this.protect(hostname, '按 Retry-After 等待', Date.now() + retryAfter)
            throw this.protect(hostname, `服务器返回 ${response.status}，请人工检查访问权限后重试`, 0, this.requestTarget(url, resource))
          }
          if ([408, 425, 429].includes(response.status) || response.status >= 500) {
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
            await response.body?.cancel()
            if (retryAfter > 0) throw this.protect(hostname, `服务器返回 ${response.status}，按 Retry-After 等待`, Date.now() + retryAfter)
            if (resource && response.status === 429) {
              throw this.protect(hostname, '服务器返回 429，站点进入冷却', Date.now() + this.settings.cooldownSeconds * 1000)
            }
            throw new RetryableRequestError(`服务器返回 ${response.status}`, response.status)
          }
          return response
        }
        // 普通资源故障由下载重试上限收敛，避免失效附件反复触发整站冷却。
        // 明确的限流、Retry-After 和访问验证仍在 request 中保护同一站点。
        const response = resource ? await request() : await state.breaker.execute(request, signal)
        const reader = response.body?.getReader()
        if (!reader) { resolve(response); return }
        await new Promise<void>((finished) => {
          let done = false
          const finish = (): void => {
            if (done) return
            done = true
            signal?.removeEventListener('abort', abort)
            finished()
          }
          const abort = (): void => { void reader.cancel().catch(() => {}).finally(finish) }
          signal?.addEventListener('abort', abort, { once: true })
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                if (signal?.aborted) throw new RequestInterruptedError()
                const chunk = await reader.read()
                if (signal?.aborted) throw new RequestInterruptedError()
                if (chunk.done) { controller.close(); finish() }
                else controller.enqueue(chunk.value)
              } catch (error) { controller.error(error); finish() }
            },
            async cancel(reason) { try { await reader.cancel(reason) } finally { finish() } }
          })
          resolve(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }))
          if (signal?.aborted) abort()
        })
      }, resource).catch(reject)
    })
  }

  private clearCooling(hostname: string, state: HostState): void {
    state.protection = undefined
    state.queue.concurrency = this.settings.hostConcurrency
    this.emit('cleared', hostname)
  }

  private createBreaker(hostname: string): CircuitBreakerPolicy {
    const breaker = circuitBreaker(handleWhen(error => error instanceof RetryableRequestError), {
      breaker: new ConsecutiveBreaker(this.settings.failureThreshold),
      halfOpenAfter: this.settings.cooldownSeconds * 1000
    })
    breaker.onBreak(() => this.protect(hostname, '连续访问失败，站点进入冷却', Date.now() + this.settings.cooldownSeconds * 1000))
    return breaker
  }

  private host(hostname: string): HostState {
    let state = this.hosts.get(hostname)
    if (state) return state
    for (const [key, value] of this.hosts) {
      if (!value.protection && !value.queue.pending && !value.queue.size && Date.now() - value.touched > 300000) this.hosts.delete(key)
    }
    state = {
      queue: new PQueue({ concurrency: this.settings.hostConcurrency }),
      starts: new PQueue({ concurrency: 1 }),
      breaker: this.createBreaker(hostname), lastStart: 0, touched: Date.now(), taskIds: new Set(), targets: new Map()
    }
    this.hosts.set(hostname, state)
    return state
  }
}
