import { describe, expect, it } from 'vitest'
import { createTask } from './defaults'
import {
  analyzeListPageRules,
  analyzeTaskListPageRules,
  buildPageUrl,
  taskListPageRuleLines
} from './list-page-rules'

describe('list page rules', () => {
  it('keeps arbitrary fixed URLs around one path template in input order', () => {
    const analysis = analyzeListPageRules(
      [
        'https://www.example.com/news/node.htm',
        'https://www.example.com/news/node_{page}.htm',
        'https://www.example.com/news/special.htm'
      ],
      { startPage: 2, step: 1, maxPages: 10 }
    )

    expect(analysis.errors).toEqual([])
    expect(analysis.rules.map((rule) => rule.kind)).toEqual(['fixed', 'template', 'fixed'])
    expect(analysis.firstUrl).toBe('https://www.example.com/news/node.htm')
  })

  it('accepts a negative non-zero page step', () => {
    const analysis = analyzeListPageRules(['https://example.com/list_{page}.htm'], {
      startPage: 100,
      step: -5,
      maxPages: 3
    })

    expect(analysis.errors).toEqual([])
    expect(buildPageUrl(analysis.templateRule!.template, 95)).toBe(
      'https://example.com/list_95.htm'
    )
  })

  it('does not require pagination values for a fixed-only task', () => {
    const analysis = analyzeListPageRules(['https://example.com/only.htm'], {
      startPage: 1.5,
      step: 0,
      maxPages: 0
    })

    expect(analysis.errors).toEqual([])
    expect(analysis.rules).toEqual([
      { kind: 'fixed', url: 'https://example.com/only.htm', lineNumber: 1 }
    ])
  })

  it('rejects multiple templates, a zero step, and mixed hostnames', () => {
    const multipleTemplates = analyzeListPageRules(
      ['https://example.com/a_{page}.htm', 'https://example.com/b_{page}.htm'],
      { startPage: 1, step: 1, maxPages: 10 }
    )
    expect(multipleTemplates.errors).toContain('同一个任务最多只能配置一条 {page} 分页模板')

    const zeroStep = analyzeListPageRules(['https://example.com/a_{page}.htm'], {
      startPage: 1,
      step: 0,
      maxPages: 10
    })
    expect(zeroStep.errors).toContain('分页步长必须是非零整数')

    const mixedHosts = analyzeListPageRules(
      ['https://www.example.com/a.htm', 'https://news.example.com/b.htm'],
      { startPage: 1, step: 1, maxPages: 10 }
    )
    expect(mixedHosts.errors).toContain('第 2 行的 hostname 与第一条地址不同')
  })

  it('migrates a legacy template task without adding the sample URL as a fixed page', () => {
    const task = createTask('legacy')
    task.listUrl = 'https://example.com/list?page=1'
    task.pagination.urlTemplate = 'https://example.com/list?page={page}'
    task.listPageRules = []

    expect(taskListPageRuleLines(task)).toEqual(['https://example.com/list?page={page}'])
    expect(analyzeTaskListPageRules(task).firstUrl).toBe('https://example.com/list?page=1')
  })
})
