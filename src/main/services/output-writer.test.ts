import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTask } from '@shared/defaults'
import { configureXmlRecord } from '@main/core/xml-template'
import { importSpreadsheetTemplate, readSpreadsheetCell } from '@main/core/spreadsheet-template'
import type { ExtractedRecord } from '@shared/types'
import * as XLSX from 'xlsx'
import { SpreadsheetOutputSession, XmlOutputSession, readOutputXml } from './output-writer'
import { TaskStore } from './task-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('XML output session', () => {
  it('writes a valid encoded XML batch using the configured file name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-output-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(join(root, 'data'))
    const task = createTask('task-output')
    task.name = '图片新闻'
    task.output.rootDirectory = join(root, 'exports')
    task.output.recordsPerFile = 2
    task.xml = configureXmlRecord(
      '<?xml version="1.0" encoding="GB2312"?><book><article><title><![CDATA[样例]]></title></article></book>',
      'template.xml',
      '/book/article'
    )
    task.xml.mappings[0]!.mode = 'page'
    const records: ExtractedRecord[] = [
      {
        sequence: 0,
        collectedAt: '2026-08-06T00:00:00.000Z',
        page: 1,
        itemIndex: 1,
        listUrl: 'https://example.com/list',
        detailUrl: '',
        externalUrl: '',
        values: { title: '中文标题' }
      }
    ]
    const session = new XmlOutputSession(task, store, '20260806_080000')
    await session.prepare(true)
    const path = await session.writeBatch(records, 1)
    expect(path).toMatch(/图片新闻_001\.xml$/)
    const content = await readOutputXml(path, 'gb2312')
    expect(content).toContain('<![CDATA[中文标题]]>')
  })
})

describe('spreadsheet output session', () => {
  it('writes a spreadsheet batch using the template extension and task naming rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-spreadsheet-output-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(join(root, 'data'))
    const task = createTask('task-spreadsheet-output')
    task.name = '公告列表'
    task.output.format = 'spreadsheet'
    task.output.rootDirectory = join(root, 'exports')
    task.output.recordsPerFile = 2
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['标题'], ['模板示例']]),
      '数据'
    )
    const templateBytes = XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' })
    task.spreadsheet = importSpreadsheetTemplate(
      Buffer.isBuffer(templateBytes) ? templateBytes : Buffer.from(templateBytes),
      'template.xls'
    )
    task.spreadsheet.mappings[0]!.mode = 'page'
    task.spreadsheet.mappings[0]!.selector = '.title'

    const records: ExtractedRecord[] = [
      {
        sequence: 0,
        collectedAt: '2026-08-09T00:00:00.000Z',
        page: 1,
        itemIndex: 1,
        listUrl: 'https://example.com/list',
        detailUrl: '',
        externalUrl: '',
        values: { A: '中文公告' }
      }
    ]
    const session = new SpreadsheetOutputSession(task, store, '20260809_080000')
    await session.prepare(true)
    const path = await session.writeBatch(records, 1)

    expect(path).toMatch(/公告列表_001\.xls$/)
    expect(readSpreadsheetCell(await readFile(path), '数据', 'A2')?.v).toBe('中文公告')
  })

  it('removes only manifest-owned files matching the active spreadsheet extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-spreadsheet-overwrite-'))
    temporaryDirectories.push(root)
    const store = new TaskStore(join(root, 'data'))
    const task = createTask('task-spreadsheet-overwrite')
    task.name = '格式切换'
    task.output.format = 'spreadsheet'
    task.output.rootDirectory = join(root, 'exports')

    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['标题']]), '数据')
    const templateBytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    task.spreadsheet = importSpreadsheetTemplate(
      Buffer.isBuffer(templateBytes) ? templateBytes : Buffer.from(templateBytes),
      'template.xlsx'
    )

    const outputDirectory = join(task.output.rootDirectory, task.name)
    await mkdir(outputDirectory, { recursive: true })
    const priorXlsx = join(outputDirectory, '格式切换_001.xlsx')
    const priorXml = join(outputDirectory, '格式切换_001.xml')
    const priorXls = join(outputDirectory, '格式切换_001.xls')
    const userFile = join(outputDirectory, '用户文件.xlsx')
    await Promise.all(
      [priorXlsx, priorXml, priorXls, userFile].map((path) => writeFile(path, path))
    )
    await store.saveOutputManifest(task.id, [priorXlsx, priorXml, priorXls])

    const session = new SpreadsheetOutputSession(task, store, '20260809_080000')
    await session.prepare(true)

    await expect(readFile(priorXlsx)).rejects.toThrow()
    await expect(readFile(priorXml, 'utf8')).resolves.toBe(priorXml)
    await expect(readFile(priorXls, 'utf8')).resolves.toBe(priorXls)
    await expect(readFile(userFile, 'utf8')).resolves.toBe(userFile)
    await expect(store.getOutputManifest(task.id)).resolves.toEqual([priorXml, priorXls])
  })
})
