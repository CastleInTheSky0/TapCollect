import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { createTask } from '@shared/defaults'
import { createMergeValue } from '@shared/field-mapping'
import { TaskStore } from '@main/services/task-store'
import { AccessCoordinator } from '@main/services/access-coordinator'
import { CollectorEngine, CollectorRunControl } from './collector-engine'
import { HttpClient } from './http-client'
import { configureXmlRecord } from './xml-template'
import { importSpreadsheetTemplate, readSpreadsheetCell } from './spreadsheet-template'

const roots: string[] = []
const prefix = '/cms_files/jcms1/webHlRVQaNGUMr3f7uQMNj83/site/attach/old'
const pdf = '/zhejiangshengyitizuzhijuanxianzhiyuanshu.pdf'
const item = (href: string, title = '列表标题', extra = ''): string =>
  `<li><a href="${href}">${title}</a><span>2026-09-08</span>${extra}</li>`

const setup = async (list: string) => {
  const root = await mkdtemp(join(tmpdir(), 'tapcollect-detail-attachment-'))
  roots.push(root)
  const task = createTask('attachments')
  task.listUrl = 'https://example.com/list'
  task.listPageRules = [task.listUrl]
  task.listItem.selector = 'li'
  task.detail.link.selector = 'a'
  task.detail.attachment = { enabled: true, fieldPath: 'file' }
  task.request.delayMs = 0
  task.output.rootDirectory = join(root, 'output')
  task.resources.download = { enabled: true, rootDirectory: join(root, 'files'), urlPrefix: prefix }
  task.xml = configureXmlRecord('<root><item><title/><date/><body/><file>示例值</file></item></root>', 'test.xml', '/root/item')
  for (const mapping of task.xml.mappings) {
    mapping.mode = 'page'
    mapping.pageSource = mapping.fieldPath === 'body' ? 'detail' : 'list'
    mapping.selector = { title: 'a', date: 'span', body: '.body', file: '.file' }[mapping.fieldPath]!
    mapping.required = mapping.fieldPath !== 'file'
  }
  task.xml.mappings.find((m) => m.fieldPath === 'file')!.mode = 'preserve'
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    if (path === '/list') return new Response(`<ul>${list}</ul>`, { headers: { 'content-type': 'text/html;charset=utf-8' } })
    if (path === '/article') return new Response('<div class="body">文章正文</div>', { headers: { 'content-type': 'text/html;charset=utf-8' } })
    if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/files/report.PDF' } })
    if (path === '/external') return new Response(null, { status: 302, headers: { location: 'https://other.example/report.pdf' } })
    if (path === '/missing.pdf') return new Response(null, { status: 404 })
    if (path === '/empty') return new Response('<p>无正文</p>', { headers: { 'content-type': 'text/html' } })
    return new Response('verified-file-bytes', { headers: { 'content-type': 'application/pdf' } })
  })
  const store = new TaskStore(join(root, 'data'))
  const engine = new CollectorEngine(store, new HttpClient(fetcher as typeof fetch))
  return { root, task, store, engine, fetcher }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('detail attachment collection', () => {
  it('previews mixed records and exact prefix URLs without fetching direct files or writing resources', async () => {
    const { task, engine, fetcher } = await setup(item(pdf) + item('/article') + item('/files/a.zip'))
    const result = await engine.testTask(task)
    expect(result.failures).toEqual([])
    expect(result.rows.map((row) => row.file)).toEqual([`${prefix}${pdf}`, '示例值', `${prefix}/files/a.zip`])
    expect(result.rows.map((row) => row.body)).toEqual(['', '文章正文', ''])
    expect(result.rows.every((row) => row.title === '列表标题' && row.date === '2026-09-08')).toBe(true)
    expect(result.resourcePlans.map((plan) => plan.sourcePageUrl)).toEqual([task.listUrl, task.listUrl])
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([task.listUrl, 'https://example.com/article'])
    await expect(stat(task.resources.download.rootDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.xmlPreview).toContain(`${prefix}${pdf}`)
    await expect(engine.getDetailSamples(task)).resolves.toEqual(['https://example.com/article'])
  })

  it('downloads direct files once, preserves output order and leaves external targets unrequested', async () => {
    const { task, engine, fetcher } = await setup(item(pdf) + item('/article') + item('/files/a.zip') + item(pdf) + item('https://other.example/a.pdf'))
    const result = await engine.run(task, null, new CollectorRunControl(), { progress: vi.fn(), log: vi.fn() })
    expect(result.status).toBe('completed')
    expect(result.counters).toMatchObject({ succeeded: 4, duplicated: 1, skipped: 0 })
    expect(result.resources).toEqual({ downloaded: 2, skipped: 0, failed: 0 })
    const xml = await readFile(result.outputFiles[0]!, 'utf8')
    expect(xml.indexOf(`${prefix}${pdf}`)).toBeLessThan(xml.indexOf('文章正文'))
    expect(xml.indexOf('文章正文')).toBeLessThan(xml.indexOf(`${prefix}/files/a.zip`))
    expect(await readFile(join(task.resources.download.rootDirectory, pdf.slice(1)), 'utf8')).toBe('verified-file-bytes')
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith(pdf))).toHaveLength(1)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('other.example'))).toBe(false)
  })

  it.each(['empty', 'fixed', 'preserve', 'page', 'merge'] as const)('overrides %s mapping only for attachments', async (mode) => {
    const { task, engine } = await setup(item(pdf, '标题', '<div class="file"><img src="/unused.png"></div>'))
    const target = task.xml!.mappings.find((m) => m.fieldPath === 'file')!
    target.mode = mode
    target.required = true
    target.extraction = 'html'
    target.fixedValue = '固定值'
    const child = createMergeValue('child')
    child.selector = '.missing'
    child.pageSource = 'detail'
    target.mergeValues = [child]
    const result = await engine.testTask(task)
    expect(result.rows[0]?.file).toBe(`${prefix}${pdf}`)
    expect(result.resourcePlans.map((plan) => plan.sourceUrl)).toEqual([`https://example.com${pdf}`])
    expect(result.xmlPreview).toContain(`${prefix}${pdf}`)
  })

  it('only defers the attachment target list requirement and still enforces other requirements', async () => {
    const { task, engine } = await setup(item(pdf) + item('/article') + item(pdf, ''))
    const target = task.xml!.mappings.find((m) => m.fieldPath === 'file')!
    target.mode = 'page'
    target.required = true
    const result = await engine.testTask(task)
    expect(result.records).toHaveLength(1)
    expect(result.rows[0]?.file).toBe(`${prefix}${pdf}`)
    expect(result.failures.map((failure) => failure.fieldPath)).toEqual(['file', 'title'])
  })

  it('retains required detail behavior for ordinary articles and skips detail-only merge requirements for files', async () => {
    const { task, engine } = await setup(item(pdf) + item('/empty'))
    const body = task.xml!.mappings.find((m) => m.fieldPath === 'body')!
    body.mode = 'merge'
    const child = createMergeValue('body')
    child.pageSource = 'detail'
    child.selector = '.body'
    body.mergeValues = [child]
    const result = await engine.testTask(task)
    expect(result.rows).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({ stage: 'merged-field', fieldPath: 'body' })
  })

  it('recognizes extensionless and redirected file responses and preserves external redirect handling', async () => {
    const { task, engine, fetcher } = await setup(item('/download?id=1') + item('/redirect') + item('/external'))
    const result = await engine.testTask(task)
    expect(result.failures).toEqual([])
    expect(result.resourcePlans).toHaveLength(2)
    expect(result.rows[0]?.file).toMatch(new RegExp(`^${prefix}/download__[a-f0-9]{8}$`))
    expect(result.rows[1]?.file).toBe(`${prefix}/files/report.PDF`)
    expect(result.records[2]?.externalUrl).toBe('https://other.example/report.pdf')
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('other.example'))).toBe(false)
  })

  it('logs failed downloads and retains the planned URL without losing records', async () => {
    const { task, engine } = await setup(item('/missing.pdf'))
    const log = vi.fn()
    const result = await engine.run(task, null, new CollectorRunControl(), { progress: vi.fn(), log })
    expect(result.status).toBe('completed')
    expect(result.resources.failed).toBe(1)
    expect(result.counters.succeeded).toBe(1)
    expect(await readFile(result.outputFiles[0]!, 'utf8')).toContain(`${prefix}/missing.pdf`)
    expect(log.mock.calls.some(([entry]) => entry.message.includes('来源页面：https://example.com/list'))).toBe(true)
  })

  it('finishes mixed records after bounded old-resource failures and never repeats a failed shared download', async () => {
    const { task, store, fetcher } = await setup(item('/article', '第一篇') + item('/missing.pdf', '失效附件') + item('/after', '后一篇'))
    task.xml!.mappings.find(mapping => mapping.fieldPath === 'body')!.extraction = 'html'
    const access = new AccessCoordinator('test-agent')
    access.configure({ ...access.settings, minIntervalMs: 0, jitterPercent: 0, retryBaseMs: 100, retryMaxMs: 100, maxRetries: 0, resourceMaxRetries: 1, failureThreshold: 1 })
    const fixture = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async input => {
      const path = new URL(String(input)).pathname
      if (path === '/legacy.doc') throw new Error('net::ERR_EMPTY_RESPONSE')
      if (path === '/article' || path === '/after') return new Response(`<div class="body">${path === '/article' ? '第一篇正文' : '后一篇正文'}<a href="http://example.com/legacy.doc">旧文件</a><a href="/soft.doc">无效文件</a></div>`, { headers: { 'content-type': 'text/html' } })
      if (path === '/soft.doc') return new Response('<html><title>404错误提示</title><body>您访问的页面未找到</body></html>', { headers: { 'content-type': 'application/msword' } })
      return fixture(input)
    })
    const engine = new CollectorEngine(store, new HttpClient(fetcher, access))
    const result = await access.withContext(task.id, undefined, () => engine.run(task, null, new CollectorRunControl(), { progress: vi.fn(), log: vi.fn() }))
    expect(result.status).toBe('completed')
    expect(result.counters).toMatchObject({ succeeded: 3, failed: 0, skipped: 0 })
    expect(result.resources).toEqual({ downloaded: 0, skipped: 0, failed: 3 })
    expect(access.getProtection('example.com')).toBeUndefined()
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/legacy.doc'))).toHaveLength(2)
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/soft.doc'))).toHaveLength(1)
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/missing.pdf'))).toHaveLength(1)
    const xml = await readFile(result.outputFiles[0]!, 'utf8')
    expect(xml).toContain('第一篇正文')
    expect(xml).toContain('后一篇正文')
    expect(xml).toContain(`${prefix}/missing.pdf`)
    const errors = await readFile(result.errorLogPath, 'utf8')
    expect(errors).toContain('资源返回错误提示页面')
    expect(errors).toContain('资源返回 404')
    expect(errors).toContain('net::ERR_EMPTY_RESPONSE')
    expect(errors).toContain('"1"')
  })

  it('exports attachment overrides through spreadsheet field resolution', async () => {
    const { task, engine } = await setup(item(pdf))
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['标题', '附件'], ['', '示例值']]), '数据')
    task.spreadsheet = importSpreadsheetTemplate(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'template.xlsx')
    task.output.format = 'spreadsheet'
    task.spreadsheet.mappings[0]!.mode = 'page'
    task.spreadsheet.mappings[0]!.selector = 'a'
    task.spreadsheet.mappings[1]!.mode = 'preserve'
    task.detail.attachment.fieldPath = 'B'
    const result = await engine.run(task, null, new CollectorRunControl(), { progress: vi.fn(), log: vi.fn() })
    expect(result.status).toBe('completed')
    expect(readSpreadsheetCell(await readFile(result.outputFiles[0]!), '数据', 'B2')?.v).toBe(`${prefix}${pdf}`)
  })

  it.each([pdf, '/missing.pdf'])('retains attachment overrides and processed resource outcomes for %s on resume', async (fileUrl) => {
    const { task, engine, store, fetcher } = await setup(item(fileUrl))
    task.xml!.encoding = 'unsupported-encoding'
    const first = await engine.run(task, null, new CollectorRunControl(), { progress: vi.fn(), log: vi.fn() })
    expect(first.status).toBe('failed')
    const checkpoint = await store.getCheckpoint(task.id)
    expect(checkpoint?.pendingRecords[0]?.detailAttachment).toEqual({ fieldPath: 'file', url: `${prefix}${fileUrl}` })
    task.xml!.encoding = 'UTF-8'
    const resumed = await engine.run(task, checkpoint, new CollectorRunControl(), { progress: vi.fn(), log: vi.fn() })
    expect(resumed.status).toBe('completed')
    expect(await readFile(resumed.outputFiles[0]!, 'utf8')).toContain(`${prefix}${fileUrl}`)
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith(fileUrl))).toHaveLength(1)
  })
})
