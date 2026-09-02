import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import type { ExtractedRecord, SpreadsheetFormat } from '@shared/types'
import {
  importSpreadsheetTemplate,
  readSpreadsheetCell,
  renderSpreadsheetBatch,
  validateSpreadsheetBatch
} from './spreadsheet-template'

const sheetJsDirectory = dirname(createRequire(import.meta.url).resolve('xlsx'))
const biff8PatchMarkers = [
  'TapCollect BIFF8 long-string chunk patch',
  'TapCollect BIFF8 SST part-boundary patch',
  'TapCollect BIFF8 forced-boundary patch'
]

const assertSafeBiff8LongStringWriter = (): void => {
  for (const entry of ['xlsx.js', 'xlsx.mjs']) {
    const source = readFileSync(resolve(sheetJsDirectory, entry), 'utf8')
    if (biff8PatchMarkers.every((marker) => source.includes(marker))) continue
    throw new Error(
      `拒绝运行 XLS 长字符串回归测试：${entry} 未应用 SheetJS BIFF8 补丁。` +
        '请先执行 node scripts/patch-sheetjs-biff8.mjs 或重新安装依赖'
    )
  }
}

const createWorkbook = (
  format: SpreadsheetFormat,
  rows: unknown[][] = [
    ['标题', '标题', '正文'],
    ['模板标题', '模板副标题', '模板正文']
  ]
): Buffer => {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet['!cols'] = [{ wch: 18 }, { wch: 24 }, { wch: 48 }]
  XLSX.utils.book_append_sheet(workbook, sheet, '采集结果')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['说明']]), '说明')
  const bytes = XLSX.write(workbook, {
    type: 'buffer',
    bookType: format === 'xls' ? 'biff8' : 'xlsx'
  })
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
}

const record = (): ExtractedRecord => ({
  sequence: 0,
  collectedAt: '2026-08-09T00:00:00.000Z',
  page: 1,
  itemIndex: 1,
  listUrl: 'https://example.com/list',
  detailUrl: 'https://example.com/detail/1',
  externalUrl: '',
  values: { B: '采集到的副标题' }
})

describe('spreadsheet template', () => {
  it('uses the first worksheet and distinguishes duplicate headers by column', () => {
    const template = importSpreadsheetTemplate(
      createWorkbook('xlsx'),
      '新闻模板.xlsx',
      '2026-08-09T00:00:00.000Z'
    )

    expect(template).toMatchObject({
      fileName: '新闻模板.xlsx',
      format: 'xlsx',
      sheetName: '采集结果',
      importedAt: '2026-08-09T00:00:00.000Z'
    })
    expect(template.fields).toEqual([
      { path: 'A', name: '标题', column: 'A', columnIndex: 0, sampleValue: '模板标题' },
      { path: 'B', name: '标题', column: 'B', columnIndex: 1, sampleValue: '模板副标题' },
      { path: 'C', name: '正文', column: 'C', columnIndex: 2, sampleValue: '模板正文' }
    ])
    expect(template.mappings.map((mapping) => mapping.fieldPath)).toEqual(['A', 'B', 'C'])
  })

  it.each<SpreadsheetFormat>(['xlsx', 'xls'])(
    'writes mapped string values and validates %s output without formulas',
    (format) => {
      const template = importSpreadsheetTemplate(
        createWorkbook(format),
        `新闻模板.${format}`
      )
      const [title, subtitle, body] = template.mappings
      title!.mode = 'fixed'
      title!.fixedValue = '=SUM(1,2)'
      subtitle!.mode = 'page'
      subtitle!.selector = '.subtitle'
      body!.mode = 'preserve'

      const bytes = renderSpreadsheetBatch(template, [record()])

      expect(() => validateSpreadsheetBatch(bytes, template, [record()])).not.toThrow()
      expect(readSpreadsheetCell(bytes, '采集结果', 'A2')).toMatchObject({
        t: 's',
        v: '=SUM(1,2)'
      })
      expect(readSpreadsheetCell(bytes, '采集结果', 'A2')?.f).toBeUndefined()
      expect(readSpreadsheetCell(bytes, '采集结果', 'B2')?.v).toBe('采集到的副标题')
      expect(readSpreadsheetCell(bytes, '采集结果', 'C2')?.v).toBe('模板正文')
      expect(readSpreadsheetCell(bytes, '说明', 'A1')?.v).toBe('说明')
    }
  )

  it('drops unsupported WPS OLE system properties when writing XLS output', () => {
    const workbook = XLSX.utils.book_new()
    const unsupportedSystemProperties = {
      Locale: 2052,
      Behavior: 1,
      undefined: 2052
    }
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['标题'], ['模板标题']]),
      '数据'
    )
    workbook.Custprops = {
      ...unsupportedSystemProperties,
      CustomLabel: 'kept'
    }
    const source = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    const template = importSpreadsheetTemplate(
      Buffer.isBuffer(source) ? source : Buffer.from(source),
      'WPS 模板.xls'
    )
    template.mappings[0]!.mode = 'fixed'
    template.mappings[0]!.fixedValue = '采集标题'

    const bytes = renderSpreadsheetBatch(template, [record()])
    const output = XLSX.read(bytes, { type: 'buffer' })
    const standardProperties = output.Props as Record<string, unknown> | undefined
    const customProperties = output.Custprops as Record<string, unknown> | undefined

    expect(readSpreadsheetCell(bytes, '数据', 'A2')?.v).toBe('采集标题')
    for (const key of Object.keys(unsupportedSystemProperties)) {
      expect(standardProperties?.[key]).toBeUndefined()
      expect(customProperties?.[key]).toBeUndefined()
    }
    expect(standardProperties?.CustomLabel ?? customProperties?.CustomLabel).toBe('kept')
  })

  it.each(['=SUM(1,2)', '+100', '-100', '@value'])(
    'keeps formula-like collected text as a string: %s',
    (value) => {
      const template = importSpreadsheetTemplate(createWorkbook('xlsx'), '新闻模板.xlsx')
      const [title, subtitle, body] = template.mappings
      title!.mode = 'fixed'
      title!.fixedValue = value
      subtitle!.mode = 'empty'
      body!.mode = 'empty'

      const bytes = renderSpreadsheetBatch(template, [record()])
      const cell = readSpreadsheetCell(bytes, '采集结果', 'A2')

      expect(cell).toMatchObject({ t: 's', v: value })
      expect(cell?.f).toBeUndefined()
      expect(() => validateSpreadsheetBatch(bytes, template, [record()])).not.toThrow()
    }
  )

  it.each<SpreadsheetFormat>(['xlsx', 'xls'])(
    'writes long HTML markup as literal text without truncating %s cells',
    (format) => {
      // Stock SheetJS 0.20.3 loops without advancing here and can exhaust host memory.
      if (format === 'xls') assertSafeBiff8LongStringWriter()
      const template = importSpreadsheetTemplate(
        createWorkbook(format),
        `新闻模板.${format}`
      )
      const [title, subtitle, body] = template.mappings
      title!.mode = 'empty'
      subtitle!.mode = 'empty'
      body!.mode = 'page'
      body!.pageSource = 'detail'
      body!.selector = '#content'
      body!.extraction = 'html'
      const htmlRecords = Array.from({ length: 10 }, (_, index) => {
        const htmlRecord = record()
        htmlRecord.sequence = index
        htmlRecord.itemIndex = index + 1
        htmlRecord.values.C =
          index === 0
            ? `<div>${'中'.repeat(4104)}🙂${'尾'.repeat(32)}</div>`
            : `<div class="content"><h2>第${index + 1}条</h2>${'<p>带格式正文内容🙂</p>'.repeat(320)}</div>`
        return htmlRecord
      })

      const bytes = renderSpreadsheetBatch(template, htmlRecords)

      htmlRecords.forEach((htmlRecord, index) => {
        const html = htmlRecord.values.C ?? ''
        const cell = readSpreadsheetCell(bytes, '采集结果', `C${index + 2}`)
        expect(Buffer.byteLength(html, 'utf16le')).toBeGreaterThan(8224)
        expect(cell).toMatchObject({ t: 's', v: html })
        expect(cell?.f).toBeUndefined()
      })
      expect(() => validateSpreadsheetBatch(bytes, template, htmlRecords)).not.toThrow()
    }
  )

  it('rejects unsupported files and templates without a first-row header', () => {
    expect(() => importSpreadsheetTemplate(createWorkbook('xlsx'), '模板.csv')).toThrow(
      '只支持 XLSX 或 XLS 表格模板'
    )
    expect(() =>
      importSpreadsheetTemplate(createWorkbook('xlsx', [[], ['第二行']]), '模板.xlsx')
    ).toThrow('第一行没有非空列名')
  })
})
