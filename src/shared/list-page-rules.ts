import type { PaginationConfig, PaginationMode, TaskConfig } from './types'

export type ListPageRule =
  | { kind: 'fixed'; url: string; lineNumber: number }
  | { kind: 'template'; template: string; lineNumber: number }

export interface ListPageRuleAnalysis {
  mode: PaginationMode
  lines: string[]
  rules: ListPageRule[]
  errors: string[]
  firstUrl: string
  hostname: string
  templateRule: Extract<ListPageRule, { kind: 'template' }> | null
}

type TaskListPageSource = Pick<TaskConfig, 'listUrl' | 'pagination'> & {
  listPageRules?: string[]
}

const markerCount = (value: string): number => value.split('{page}').length - 1

const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1

const resolveHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url : null
  } catch {
    return null
  }
}

export const normalizeListPageRuleLines = (lines: string[]): string[] =>
  lines.map((line) => line.trim()).filter(Boolean)

export const taskListPageRuleLines = (task: TaskListPageSource): string[] => {
  const explicit = normalizeListPageRuleLines(task.listPageRules ?? [])
  if (explicit.length > 0) return explicit
  const legacyTemplate = task.pagination.urlTemplate?.trim() ?? ''
  if (legacyTemplate) return [legacyTemplate]
  const legacyListUrl = task.listUrl.trim()
  return legacyListUrl ? [legacyListUrl] : []
}

export const buildPageUrl = (template: string, page: number): string => {
  if (markerCount(template) !== 1) throw new Error('分页 URL 模板必须且只能包含一个 {page}')
  return template.replace('{page}', String(page))
}

export const analyzeListPageRules = (
  lines: string[],
  pagination: Pick<PaginationConfig, 'startPage' | 'step' | 'maxPages'> &
    Partial<Pick<PaginationConfig, 'mode'>>
): ListPageRuleAnalysis => {
  const mode = pagination.mode ?? 'url'
  const normalizedLines = normalizeListPageRuleLines(lines)
  const errors: string[] = []
  const rules: ListPageRule[] = []
  let expectedHostname = ''
  let templateRule: Extract<ListPageRule, { kind: 'template' }> | null = null

  normalizedLines.forEach((line, index) => {
    const lineNumber = index + 1
    const markers = markerCount(line)
    if (mode === 'click' && markers > 0) {
      errors.push(`第 ${lineNumber} 行在动态分页模式下不能包含 {page}`)
      return
    }
    if (markers > 1) {
      errors.push(`第 ${lineNumber} 行只能包含一个 {page}`)
      return
    }

    const candidate = markers === 1 ? line.replace('{page}', String(pagination.startPage)) : line
    const parsed = resolveHttpUrl(candidate)
    if (!parsed) {
      errors.push(`第 ${lineNumber} 行不是有效的 HTTP/HTTPS 地址`)
      return
    }
    const hostname = parsed.hostname.toLowerCase()
    if (expectedHostname && hostname !== expectedHostname) {
      errors.push(`第 ${lineNumber} 行的 hostname 与第一条地址不同`)
      return
    }
    expectedHostname ||= hostname

    if (markers === 1) {
      const rule: Extract<ListPageRule, { kind: 'template' }> = {
        kind: 'template',
        template: line,
        lineNumber
      }
      if (templateRule) {
        errors.push('同一个任务最多只能配置一条 {page} 分页模板')
        return
      }
      templateRule = rule
      rules.push(rule)
      return
    }
    rules.push({ kind: 'fixed', url: parsed.toString(), lineNumber })
  })

  if (normalizedLines.length === 0) errors.push('请至少填写一个列表页面 URL')
  if (mode === 'click' && normalizedLines.length > 1) {
    errors.push('点击下一页模式只能配置一条固定列表 URL')
  }
  if (mode === 'click') {
    if (!isPositiveSafeInteger(pagination.maxPages)) {
      errors.push('动态分页最大采集页数必须是正整数')
    }
  } else if (templateRule) {
    if (!Number.isInteger(pagination.startPage)) errors.push('分页起始值必须是整数')
    if (!Number.isInteger(pagination.step) || pagination.step === 0) {
      errors.push('分页步长必须是非零整数')
    }
    if (!isPositiveSafeInteger(pagination.maxPages)) {
      errors.push('分页模板最大采集页数必须是正整数')
    }
  }

  const firstRule = rules[0]
  const firstUrl =
    firstRule?.kind === 'fixed'
      ? firstRule.url
      : firstRule?.kind === 'template'
        ? buildPageUrl(firstRule.template, pagination.startPage)
        : ''

  return {
    mode,
    lines: normalizedLines,
    rules,
    errors,
    firstUrl,
    hostname: expectedHostname,
    templateRule
  }
}

export const analyzeTaskListPageRules = (task: TaskListPageSource): ListPageRuleAnalysis =>
  analyzeListPageRules(taskListPageRuleLines(task), {
    mode: task.pagination.mode ?? 'url',
    startPage: task.pagination.startPage,
    step: task.pagination.step ?? 1,
    maxPages: task.pagination.maxPages
  })

export const firstTaskListPageUrl = (task: TaskListPageSource): string =>
  analyzeTaskListPageRules(task).firstUrl
