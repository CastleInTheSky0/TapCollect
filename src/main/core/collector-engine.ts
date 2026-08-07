import { randomUUID } from 'node:crypto'
import type {
  ExtractedRecord,
  RecordFailure,
  RunCheckpoint,
  RunLog,
  RunProgress,
  RunResult,
  TaskConfig,
  TestCollectionResult
} from '@shared/types'
import { createEmptyCounters, isTaskRunnable } from '@shared/defaults'
import { analyzeTaskListPageRules, firstTaskListPageUrl } from '@shared/list-page-rules'
import { renderXmlBatch } from './xml-template'
import {
  candidateToRecord,
  createRecordFailure,
  extractDetailPage,
  extractListPage,
  type ListCandidate
} from './extraction'
import { HttpClient, HttpRequestError } from './http-client'
import { buildPageUrl, formatRunStamp, normalizeUrl } from './url-utils'
import { missingRequiredMergeFields, resolveFieldValue } from './field-values'
import { XmlOutputSession } from '@main/services/output-writer'
import type { TaskStore } from '@main/services/task-store'

export interface CollectorEvents {
  progress: (progress: RunProgress) => void
  log: (log: RunLog) => void
}

interface CandidateOutcome {
  record: ExtractedRecord | null
  failures: RecordFailure[]
  counter: 'success' | 'skipped' | 'failed'
  matchCounts: Record<string, number>
}

const delay = async (milliseconds: number): Promise<void> => {
  if (milliseconds <= 0) return
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

const cloneCheckpoint = (checkpoint: RunCheckpoint): RunCheckpoint =>
  JSON.parse(JSON.stringify(checkpoint)) as RunCheckpoint

export class CollectorRunControl {
  private state: 'running' | 'paused' | 'cancelled' = 'running'
  private waiters: Array<(shouldContinue: boolean) => void> = []
  private latestCheckpoint: RunCheckpoint | null = null

  setCheckpoint(checkpoint: RunCheckpoint): void {
    this.latestCheckpoint = cloneCheckpoint(checkpoint)
  }

  getCheckpoint(): RunCheckpoint | null {
    return this.latestCheckpoint ? cloneCheckpoint(this.latestCheckpoint) : null
  }

  pause(): boolean {
    if (this.state !== 'running') return false
    this.state = 'paused'
    return true
  }

  resume(): boolean {
    if (this.state !== 'paused') return false
    this.state = 'running'
    this.releaseWaiters(true)
    return true
  }

  cancel(): boolean {
    if (this.state === 'cancelled') return false
    this.state = 'cancelled'
    this.releaseWaiters(false)
    return true
  }

  isPaused(): boolean {
    return this.state === 'paused'
  }

  isCancelled(): boolean {
    return this.state === 'cancelled'
  }

  async waitUntilRunnable(): Promise<boolean> {
    if (this.state === 'cancelled') return false
    if (this.state === 'running') return true
    return new Promise<boolean>((resolve) => this.waiters.push(resolve))
  }

  private releaseWaiters(shouldContinue: boolean): void {
    const waiters = this.waiters.splice(0)
    waiters.forEach((resolve) => resolve(shouldContinue))
  }
}

const orderedConcurrentMap = async <T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      const value = values[index]
      if (value !== undefined) results[index] = await mapper(value, index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker())
  )
  return results
}

const missingFailures = (
  candidate: ListCandidate,
  stage: 'list-field' | 'detail-field' | 'merged-field',
  fields: string[]
): RecordFailure[] =>
  fields.map((field) => createRecordFailure(candidate, stage, '必填字段没有采集到值', field))

const resolveListOnlyDedupeValue = (task: TaskConfig, candidate: ListCandidate): string => {
  const field = task.xml?.fields.find((definition) => definition.path === task.dedupeFieldPath)
  const mapping = task.xml?.mappings.find((entry) => entry.fieldPath === task.dedupeFieldPath)
  if (!field || !mapping) return ''
  return resolveFieldValue(mapping, field, candidateToRecord(candidate))
}

export class CollectorEngine {
  constructor(
    private readonly store: TaskStore,
    private readonly httpClient = new HttpClient()
  ) {}

  async getDetailSamples(task: TaskConfig, limit = 20): Promise<string[]> {
    if (!task.detail.enabled || !task.detail.link.selector.trim()) return []
    const listUrl = firstTaskListPageUrl(task)
    if (!listUrl) return []
    const response = await this.httpClient.fetchHtml(
      listUrl,
      task.request,
      new URL(listUrl).hostname
    )
    if (response.kind !== 'success') return []
    const page = extractListPage(task, response.html, response.finalUrl, 1, 0)
    return [
      ...new Set(
        page.candidates
          .map((candidate) => candidate.detailRequestUrl)
          .filter((url): url is string => Boolean(url))
      )
    ].slice(0, Math.max(1, limit))
  }

  async testTask(task: TaskConfig): Promise<TestCollectionResult> {
    if (!task.xml) throw new Error('请先导入 XML 模板并配置记录节点')
    const listUrl = firstTaskListPageUrl(task)
    if (!listUrl) throw new Error('请先填写有效的列表页面 URL')
    const response = await this.httpClient.fetchHtml(
      listUrl,
      task.request,
      new URL(listUrl).hostname
    )
    if (response.kind !== 'success') throw new Error('测试列表页未返回可采集的 HTML')
    const page = extractListPage(task, response.html, response.finalUrl, 1, 0)
    const failures: RecordFailure[] = []
    const records: ExtractedRecord[] = []
    const matchCounts: Record<string, number[]> = Object.fromEntries(
      Object.entries(page.matchCounts).map(([path, counts]) => [path, counts.slice(0, 3)])
    )

    for (const candidate of page.candidates.slice(0, 3)) {
      if (candidate.missingListFields.length > 0) {
        failures.push(...missingFailures(candidate, 'list-field', candidate.missingListFields))
        continue
      }
      const outcome = await this.processCandidate(task, candidate, null)
      failures.push(...outcome.failures)
      for (const [path, count] of Object.entries(outcome.matchCounts)) {
        const counts = matchCounts[path] ?? []
        counts.push(count)
        matchCounts[path] = counts
      }
      if (outcome.record) records.push(outcome.record)
    }

    const rows = records.map((record) => {
      const row: Record<string, string> = {}
      for (const field of task.xml?.fields ?? []) {
        const mapping = task.xml?.mappings.find((candidate) => candidate.fieldPath === field.path)
        if (!mapping || mapping.mode === 'unconfigured') {
          row[field.path] = ''
        } else {
          row[field.path] = resolveFieldValue(mapping, field, record)
        }
      }
      return row
    })
    return {
      records,
      rows,
      matchCounts,
      failures,
      listItemCount: page.itemCount,
      xmlPreview: records.length > 0 ? renderXmlBatch(task.xml, records) : '',
      messages: [
        `列表项匹配 ${page.itemCount} 条`,
        `测试生成 ${records.length} 条记录`,
        failures.length > 0 ? `发现 ${failures.length} 个问题` : '必填字段检查通过'
      ]
    }
  }

  async run(
    task: TaskConfig,
    resumeCheckpoint: RunCheckpoint | null,
    control: CollectorRunControl,
    events: CollectorEvents
  ): Promise<RunResult> {
    if (!isTaskRunnable(task) || !task.xml) throw new Error('任务配置尚未完成，不能运行')
    const listPages = analyzeTaskListPageRules(task)
    const pageRules = listPages.rules

    const now = new Date()
    const checkpoint: RunCheckpoint = resumeCheckpoint ?? {
      version: 1,
      taskId: task.id,
      runId: randomUUID(),
      startedAt: now.toISOString(),
      runStamp: formatRunStamp(now),
      nextRuleIndex: 0,
      nextPage: task.pagination.startPage,
      templatePagesVisited: 0,
      nextSequence: 0,
      nextFileIndex: 1,
      pagesVisited: 0,
      seenPageUrls: [],
      seenKeys: [],
      pendingRecords: [],
      outputFiles: [],
      errorLogPath: '',
      counters: createEmptyCounters()
    }
    const freshRun = resumeCheckpoint === null
    const output = new XmlOutputSession(task, this.store, checkpoint.runStamp, checkpoint.errorLogPath)
    await output.prepare(freshRun)
    checkpoint.errorLogPath = output.errorLogPath
    control.setCheckpoint(checkpoint)
    await this.store.saveCheckpoint(checkpoint)

    let currentUrl = ''
    let currentPageOrdinal = checkpoint.pagesVisited + 1
    let terminalMessage = '采集完成'

    const emitLog = (level: RunLog['level'], message: string): void => {
      events.log({ runId: checkpoint.runId, level, time: new Date().toISOString(), message })
    }
    const emitProgress = (status: RunProgress['status'], stage: RunProgress['stage'], message: string): void => {
      events.progress({
        runId: checkpoint.runId,
        taskId: task.id,
        status,
        stage,
        page: currentPageOrdinal,
        maxPages: task.pagination.maxPages,
        currentUrl,
        currentFile: checkpoint.outputFiles.at(-1) ?? '',
        recordsInCurrentFile: checkpoint.pendingRecords.length,
        counters: { ...checkpoint.counters },
        message
      })
    }

    const synchronize = async (): Promise<boolean> => {
      control.setCheckpoint(checkpoint)
      if (control.isCancelled()) return false
      if (!control.isPaused()) return true
      await this.store.saveCheckpoint(checkpoint)
      emitProgress('paused', 'list', '任务已暂停，当前批次保存在检查点中')
      emitLog('warning', '任务已暂停')
      const shouldContinue = await control.waitUntilRunnable()
      if (shouldContinue) {
        emitProgress('running', 'list', '继续采集')
        emitLog('info', '任务继续运行')
      }
      return shouldContinue
    }

    const appendFailure = async (failure: RecordFailure): Promise<void> => {
      await output.appendFailure(failure)
      emitLog('warning', `${failure.stage}${failure.fieldPath ? `/${failure.fieldPath}` : ''}：${failure.reason}`)
    }

    const flushFullBatches = async (): Promise<void> => {
      while (checkpoint.pendingRecords.length >= task.output.recordsPerFile) {
        const records = checkpoint.pendingRecords.slice(0, task.output.recordsPerFile)
        const path = await output.writeBatch(records, checkpoint.nextFileIndex)
        checkpoint.pendingRecords.splice(0, records.length)
        checkpoint.outputFiles.push(path)
        checkpoint.nextFileIndex += 1
        control.setCheckpoint(checkpoint)
        await this.store.saveCheckpoint(checkpoint)
        emitLog('success', `已生成 ${path}`)
      }
    }

    const flushLastBatch = async (): Promise<void> => {
      if (checkpoint.pendingRecords.length === 0) return
      const records = checkpoint.pendingRecords.slice()
      const path = await output.writeBatch(records, checkpoint.nextFileIndex)
      checkpoint.pendingRecords.splice(0, records.length)
      checkpoint.outputFiles.push(path)
      checkpoint.nextFileIndex += 1
      control.setCheckpoint(checkpoint)
      emitLog('success', `已生成 ${path}`)
    }

    emitProgress('running', 'preparing', freshRun ? '开始新任务' : '从检查点继续任务')
    emitLog(
      'info',
      freshRun ? '开始采集' : `从第 ${checkpoint.nextRuleIndex + 1} 条列表地址规则继续采集`
    )

    try {
      while (checkpoint.nextRuleIndex < pageRules.length) {
        if (!(await synchronize())) break
        const rule = pageRules[checkpoint.nextRuleIndex]
        if (!rule) break
        if (rule.kind === 'template' && checkpoint.templatePagesVisited >= task.pagination.maxPages) {
          terminalMessage = `分页模板已达到最大采集页数 ${task.pagination.maxPages}`
          emitLog('info', terminalMessage)
          checkpoint.nextRuleIndex += 1
          control.setCheckpoint(checkpoint)
          await this.store.saveCheckpoint(checkpoint)
          continue
        }

        const pageValue = checkpoint.nextPage
        currentUrl = rule.kind === 'template' ? buildPageUrl(rule.template, pageValue) : rule.url
        currentPageOrdinal = checkpoint.pagesVisited + 1
        const normalizedPageUrl = normalizeUrl(currentUrl)
        if (checkpoint.seenPageUrls.includes(normalizedPageUrl)) {
          terminalMessage =
            rule.kind === 'template'
              ? '分页模板生成了重复 URL，结束该模板并继续后续固定地址'
              : '固定列表 URL 已请求过，跳过并继续下一条地址'
          emitLog('warning', terminalMessage)
          checkpoint.nextRuleIndex += 1
          control.setCheckpoint(checkpoint)
          await this.store.saveCheckpoint(checkpoint)
          continue
        }

        const pageDescription =
          rule.kind === 'template'
            ? `第 ${currentPageOrdinal} 个列表页（分页值 ${pageValue}）`
            : `第 ${currentPageOrdinal} 个列表页`
        emitProgress('running', 'list', `正在采集${pageDescription}`)
        emitLog('info', `请求列表页：${currentUrl}`)
        if (checkpoint.pagesVisited > 0) await delay(task.request.delayMs)
        const listResponse = await this.httpClient.fetchHtml(
          currentUrl,
          task.request,
          new URL(currentUrl).hostname
        )
        if (listResponse.kind === 'not-found') {
          terminalMessage =
            rule.kind === 'template'
              ? `分页模板返回 ${listResponse.status}，结束该模板并继续后续固定地址`
              : `固定列表 URL 返回 ${listResponse.status}，跳过并继续下一条地址`
          emitLog('info', terminalMessage)
          checkpoint.nextRuleIndex += 1
          control.setCheckpoint(checkpoint)
          await this.store.saveCheckpoint(checkpoint)
          continue
        }
        if (listResponse.kind === 'external-redirect') {
          throw new Error(`列表页重定向到站外地址：${listResponse.finalUrl}`)
        }

        const extracted = extractListPage(
          task,
          listResponse.html,
          listResponse.finalUrl,
          currentPageOrdinal,
          checkpoint.nextSequence
        )
        if (extracted.itemCount === 0) {
          checkpoint.seenPageUrls.push(normalizedPageUrl)
          checkpoint.pagesVisited += 1
          if (rule.kind === 'template') checkpoint.templatePagesVisited += 1
          terminalMessage =
            rule.kind === 'template'
              ? '当前页没有列表项，结束该模板并继续后续固定地址'
              : '固定列表 URL 没有列表项，跳过并继续下一条地址'
          emitLog('info', terminalMessage)
          checkpoint.nextRuleIndex += 1
          control.setCheckpoint(checkpoint)
          await this.store.saveCheckpoint(checkpoint)
          continue
        }

        const committedKeys = new Set(checkpoint.seenKeys)
        const reservedKeys = new Set(checkpoint.seenKeys)
        const work: Array<{ candidate: ListCandidate; key: string }> = []
        let duplicateCount = 0

        for (const candidate of extracted.candidates) {
          let key = ''
          if (task.detail.enabled) {
            const link = candidate.externalUrl || candidate.detailUrl
            if (link) key = normalizeUrl(link)
          } else {
            key = resolveListOnlyDedupeValue(task, candidate).trim()
          }

          if (!key) {
            checkpoint.counters.skipped += 1
            const reason = task.detail.enabled ? '没有有效的详情链接' : '去重字段没有值'
            await appendFailure(createRecordFailure(candidate, 'list', reason, task.dedupeFieldPath))
            continue
          }
          if (reservedKeys.has(key)) {
            duplicateCount += 1
            checkpoint.counters.duplicated += 1
            continue
          }
          reservedKeys.add(key)

          if (candidate.missingListFields.length > 0) {
            committedKeys.add(key)
            checkpoint.seenKeys.push(key)
            checkpoint.counters.skipped += 1
            for (const failure of missingFailures(candidate, 'list-field', candidate.missingListFields)) {
              await appendFailure(failure)
            }
            continue
          }
          work.push({ candidate, key })
        }

        const outcomes = await orderedConcurrentMap(
          work,
          task.request.detailConcurrency,
          async ({ candidate }) => {
            if (task.detail.enabled && candidate.detailRequestUrl) await delay(task.request.delayMs)
            return this.processCandidate(task, candidate, control)
          }
        )

        for (const [index, outcome] of outcomes.entries()) {
          const completedWork = work[index]
          let completedKey = completedWork?.key ?? ''
          if (task.detail.enabled && outcome.record) {
            const finalLink = outcome.record.externalUrl || outcome.record.detailUrl
            if (finalLink) completedKey = normalizeUrl(finalLink)
          }
          if (completedKey && committedKeys.has(completedKey)) {
            duplicateCount += 1
            checkpoint.counters.duplicated += 1
            continue
          }
          if (completedKey) {
            committedKeys.add(completedKey)
            checkpoint.seenKeys.push(completedKey)
          }
          for (const failure of outcome.failures) await appendFailure(failure)
          if (outcome.counter === 'failed') checkpoint.counters.failed += 1
          if (outcome.counter === 'skipped') checkpoint.counters.skipped += 1
          if (outcome.record) {
            checkpoint.pendingRecords.push(outcome.record)
            checkpoint.counters.succeeded += 1
            await flushFullBatches()
          }
        }

        checkpoint.seenPageUrls.push(normalizedPageUrl)
        checkpoint.pagesVisited += 1
        if (rule.kind === 'template') checkpoint.templatePagesVisited += 1
        checkpoint.nextSequence += extracted.itemCount
        checkpoint.counters.discovered += extracted.itemCount

        const pageWasDuplicate = duplicateCount === extracted.itemCount
        if (rule.kind === 'template') {
          if (pageWasDuplicate) {
            checkpoint.nextRuleIndex += 1
          } else {
            checkpoint.nextPage = pageValue + task.pagination.step
          }
        } else {
          checkpoint.nextRuleIndex += 1
        }
        control.setCheckpoint(checkpoint)
        await this.store.saveCheckpoint(checkpoint)
        emitProgress('running', 'list', `${pageDescription}处理完成`)

        if (pageWasDuplicate) {
          terminalMessage =
            rule.kind === 'template'
              ? '当前页全部为本次任务已见记录，结束该模板并继续后续固定地址'
              : '固定列表 URL 中的记录全部重复，继续下一条地址'
          emitLog('info', terminalMessage)
        } else {
          terminalMessage = '采集完成'
        }
      }

      if (control.isCancelled()) {
        await flushLastBatch()
        await this.store.clearCheckpoint(task.id)
        emitProgress('cancelled', 'cancelled', '任务已取消，当前有效记录已写出')
        return this.buildResult(checkpoint, 'cancelled', '任务已取消，已保留采集结果')
      }

      await flushLastBatch()
      await this.store.clearCheckpoint(task.id)
      emitProgress('completed', 'completed', terminalMessage)
      emitLog('success', terminalMessage)
      return this.buildResult(checkpoint, 'completed', terminalMessage)
    } catch (error) {
      control.setCheckpoint(checkpoint)
      await this.store.saveCheckpoint(checkpoint)
      const message = error instanceof Error ? error.message : String(error)
      const retries = error instanceof HttpRequestError ? error.retries : 0
      try {
        await output.appendFailure({
          page: currentPageOrdinal,
          itemIndex: 0,
          listUrl: currentUrl,
          detailUrl: '',
          stage: error instanceof HttpRequestError ? 'list-request' : 'task',
          fieldPath: '',
          reason: message,
          retries,
          time: new Date().toISOString()
        })
      } catch {
        // The original failure remains authoritative when the log file itself is unavailable.
      }
      emitProgress('failed', 'failed', message)
      emitLog('error', `任务失败：${message}`)
      return this.buildResult(checkpoint, 'failed', message)
    }
  }

  private async processCandidate(
    task: TaskConfig,
    candidate: ListCandidate,
    control: CollectorRunControl | null
  ): Promise<CandidateOutcome> {
    if (control?.isCancelled()) {
      return { record: null, failures: [], counter: 'skipped', matchCounts: {} }
    }
    if (control?.isPaused()) {
      const shouldContinue = await control.waitUntilRunnable()
      if (!shouldContinue) {
        return { record: null, failures: [], counter: 'skipped', matchCounts: {} }
      }
    }
    if (!task.detail.enabled || candidate.externalUrl) {
      return this.finalizeRecord(task, candidate, candidateToRecord(candidate), {})
    }
    if (!candidate.detailRequestUrl) {
      return {
        record: null,
        failures: [createRecordFailure(candidate, 'detail-link', '没有有效的详情链接')],
        counter: 'skipped',
        matchCounts: {}
      }
    }
    try {
      const response = await this.httpClient.fetchHtml(
        candidate.detailRequestUrl,
        task.request,
        new URL(candidate.listUrl).hostname
      )
      if (response.kind === 'external-redirect') {
        const external = {
          ...candidate,
          detailRequestUrl: '',
          detailUrl: '',
          externalUrl: response.finalUrl
        }
        return this.finalizeRecord(task, candidate, candidateToRecord(external), {})
      }
      if (response.kind === 'not-found') {
        return {
          record: null,
          failures: [
            createRecordFailure(
              candidate,
              'detail-request',
              `详情页返回 ${response.status}`,
              '',
              response.retries
            )
          ],
          counter: 'failed',
          matchCounts: {}
        }
      }
      const extracted = extractDetailPage(task, candidate, response.html, response.finalUrl)
      if (extracted.missingFields.length > 0) {
        return {
          record: null,
          failures: missingFailures(candidate, 'detail-field', extracted.missingFields),
          counter: 'skipped',
          matchCounts: extracted.matchCounts
        }
      }
      return this.finalizeRecord(task, candidate, extracted.record, extracted.matchCounts)
    } catch (error) {
      const retries = error instanceof HttpRequestError ? error.retries : 0
      const stage = error instanceof HttpRequestError ? 'detail-request' : 'detail-extraction'
      return {
        record: null,
        failures: [
          createRecordFailure(
            candidate,
            stage,
            error instanceof Error ? error.message : String(error),
            '',
            retries
          )
        ],
        counter: 'failed',
        matchCounts: {}
      }
    }
  }

  private finalizeRecord(
    task: TaskConfig,
    candidate: ListCandidate,
    record: ExtractedRecord,
    matchCounts: Record<string, number>
  ): CandidateOutcome {
    const missingFields = missingRequiredMergeFields(task, record)
    if (missingFields.length > 0) {
      return {
        record: null,
        failures: missingFailures(candidate, 'merged-field', missingFields),
        counter: 'skipped',
        matchCounts
      }
    }
    return { record, failures: [], counter: 'success', matchCounts }
  }

  private buildResult(
    checkpoint: RunCheckpoint,
    status: RunResult['status'],
    message: string
  ): RunResult {
    return {
      runId: checkpoint.runId,
      taskId: checkpoint.taskId,
      status,
      startedAt: checkpoint.startedAt,
      finishedAt: new Date().toISOString(),
      pagesVisited: checkpoint.pagesVisited,
      outputFiles: [...checkpoint.outputFiles],
      errorLogPath: checkpoint.errorLogPath,
      counters: { ...checkpoint.counters },
      message
    }
  }
}
