import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { createTask } from '@shared/defaults'
import { importSpreadsheetTemplate, readSpreadsheetCell } from './spreadsheet-template'
import type { FetchHtmlResult, HttpClient } from './http-client'
import { CollectorEngine, CollectorRunControl } from './collector-engine'
import { TaskStore } from '@main/services/task-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('spreadsheet collector output', () => {
  it('collects spreadsheet fields and splits batches using the existing checkpoint flow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-spreadsheet-run-'))
    temporaryDirectories.push(root)
    const task = createTask('spreadsheet-run')
    task.name = '表格采集'
    task.listPageRules = ['https://example.com/list']
    task.listUrl = task.listPageRules[0]!
    task.listItem.selector = '.item'
    task.detail.enabled = false
    task.output.format = 'spreadsheet'
    task.output.rootDirectory = join(root, 'exports')
    task.output.recordsPerFile = 1
    task.request.delayMs = 0

    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['标题'], ['模板示例']]),
      '数据'
    )
    const templateBytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    task.spreadsheet = importSpreadsheetTemplate(
      Buffer.isBuffer(templateBytes) ? templateBytes : Buffer.from(templateBytes),
      'template.xlsx'
    )
    const mapping = task.spreadsheet.mappings[0]!
    mapping.mode = 'page'
    mapping.pageSource = 'list'
    mapping.selector = '.title'
    task.dedupeFieldPath = 'A'

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html: [
        '<div class="item"><span class="title">第一条</span></div>',
        '<div class="item"><span class="title">第二条</span></div>'
      ].join(''),
      encoding: 'utf-8',
      retries: 0
    }))
    const store = new TaskStore(join(root, 'data'))
    const engine = new CollectorEngine(store, { fetchHtml } as unknown as HttpClient)

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })

    expect(result.status).toBe('completed')
    expect(result.outputFiles).toHaveLength(2)
    expect(result.outputFiles[0]).toMatch(/表格采集_001\.xlsx$/)
    expect(result.outputFiles[1]).toMatch(/表格采集_002\.xlsx$/)
    expect(
      readSpreadsheetCell(await readFile(result.outputFiles[0]!), '数据', 'A2')?.v
    ).toBe('第一条')
    expect(
      readSpreadsheetCell(await readFile(result.outputFiles[1]!), '数据', 'A2')?.v
    ).toBe('第二条')
    await expect(store.getCheckpoint(task.id)).resolves.toBeNull()
  })

  it('keeps pending records and file numbering when spreadsheet rendering fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-spreadsheet-failure-'))
    temporaryDirectories.push(root)
    const task = createTask('spreadsheet-failure')
    task.name = '失败恢复'
    task.listPageRules = ['https://example.com/list']
    task.listUrl = task.listPageRules[0]!
    task.listItem.selector = '.item'
    task.detail.enabled = false
    task.output.format = 'spreadsheet'
    task.output.rootDirectory = join(root, 'exports')
    task.output.recordsPerFile = 1
    task.request.delayMs = 0

    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['标题']]), '数据')
    const templateBytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    task.spreadsheet = importSpreadsheetTemplate(
      Buffer.isBuffer(templateBytes) ? templateBytes : Buffer.from(templateBytes),
      'template.xlsx'
    )
    task.spreadsheet.sheetName = '不存在的工作表'
    const mapping = task.spreadsheet.mappings[0]!
    mapping.mode = 'page'
    mapping.pageSource = 'list'
    mapping.selector = '.title'
    task.dedupeFieldPath = 'A'

    const fetchHtml = vi.fn(async (url: string): Promise<FetchHtmlResult> => ({
      kind: 'success',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html: '<div class="item"><span class="title">待恢复记录</span></div>',
      encoding: 'utf-8',
      retries: 0
    }))
    const store = new TaskStore(join(root, 'data'))
    const engine = new CollectorEngine(store, { fetchHtml } as unknown as HttpClient)

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })
    const checkpoint = await store.getCheckpoint(task.id)

    expect(result.status).toBe('failed')
    expect(result.outputFiles).toEqual([])
    expect(checkpoint?.pendingRecords.map((item) => item.values.A)).toEqual(['待恢复记录'])
    expect(checkpoint?.nextFileIndex).toBe(1)
    expect(checkpoint?.outputFiles).toEqual([])
  })
})
