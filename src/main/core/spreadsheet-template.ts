import { extname } from 'node:path'
import * as XLSX from 'xlsx'
import { createFieldMapping } from '@shared/defaults'
import type {
  ExtractedRecord,
  SpreadsheetFieldDefinition,
  SpreadsheetFormat,
  SpreadsheetTemplateConfig
} from '@shared/types'
import { resolveFieldValue } from './field-values'

type StyledCell = XLSX.CellObject & { s?: unknown }

const UNSUPPORTED_BIFF8_PROPERTY_KEYS = ['Locale', 'Behavior', 'undefined'] as const

const sanitizeBiff8Properties = (workbook: XLSX.WorkBook): void => {
  // WPS emits OLE system properties that SheetJS 0.20.3 can read but cannot write.
  for (const properties of [workbook.Props, workbook.Custprops]) {
    if (!properties) continue
    const values = properties as Record<string, unknown>
    for (const key of UNSUPPORTED_BIFF8_PROPERTY_KEYS) delete values[key]
  }
}

const spreadsheetFormat = (fileName: string): SpreadsheetFormat => {
  const extension = extname(fileName).toLowerCase()
  if (extension === '.xlsx') return 'xlsx'
  if (extension === '.xls') return 'xls'
  throw new Error('只支持 XLSX 或 XLS 表格模板')
}

const readWorkbook = (bytes: Buffer): XLSX.WorkBook => {
  try {
    return XLSX.read(bytes, {
      type: 'buffer',
      cellDates: false,
      cellNF: true,
      cellStyles: true
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取表格模板：${message}`)
  }
}

const cellText = (cell: XLSX.CellObject | undefined): string => {
  if (!cell) return ''
  return XLSX.utils.format_cell(cell).trim()
}

const inspectFields = (
  sheet: XLSX.WorkSheet,
  sheetName: string
): SpreadsheetFieldDefinition[] => {
  if (!sheet['!ref']) throw new Error(`工作表“${sheetName}”没有可识别的内容`)
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const fields: SpreadsheetFieldDefinition[] = []
  for (let columnIndex = 0; columnIndex <= range.e.c; columnIndex += 1) {
    const column = XLSX.utils.encode_col(columnIndex)
    const name = cellText(sheet[XLSX.utils.encode_cell({ c: columnIndex, r: 0 })])
    if (!name) continue
    fields.push({
      path: column,
      name,
      column,
      columnIndex,
      sampleValue: cellText(sheet[XLSX.utils.encode_cell({ c: columnIndex, r: 1 })])
    })
  }
  if (fields.length === 0) {
    throw new Error(`工作表“${sheetName}”第一行没有非空列名`)
  }
  return fields
}

export const importSpreadsheetTemplate = (
  bytes: Buffer,
  fileName: string,
  importedAt = new Date().toISOString()
): SpreadsheetTemplateConfig => {
  const format = spreadsheetFormat(fileName)
  const workbook = readWorkbook(bytes)
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new Error('表格模板至少需要一个工作表')
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error(`无法读取工作表“${sheetName}”`)
  const fields = inspectFields(sheet, sheetName)
  return {
    fileName,
    contentBase64: bytes.toString('base64'),
    format,
    sheetName,
    fields,
    mappings: fields.map(createFieldMapping),
    importedAt
  }
}

const clearDataRows = (sheet: XLSX.WorkSheet): void => {
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue
    try {
      if (XLSX.utils.decode_cell(key).r >= 1) delete sheet[key]
    } catch {
      // Non-cell metadata is kept unchanged.
    }
  }
  if (sheet['!merges']) {
    sheet['!merges'] = sheet['!merges'].filter((range) => range.e.r < 1)
  }
}

const cloneStyle = (cell: StyledCell | undefined): unknown => {
  if (!cell?.s) return undefined
  return JSON.parse(JSON.stringify(cell.s)) as unknown
}

export const renderSpreadsheetBatch = (
  template: SpreadsheetTemplateConfig,
  records: ExtractedRecord[]
): Buffer => {
  if (records.length === 0) throw new Error('不能生成空表格批次')
  if (template.fields.length === 0) throw new Error('表格模板没有可写入的列')
  const workbook = readWorkbook(Buffer.from(template.contentBase64, 'base64'))
  const sheet = workbook.Sheets[template.sheetName]
  if (!sheet) throw new Error(`表格模板缺少工作表“${template.sheetName}”`)

  const rowStyles = new Map<number, unknown>()
  for (const field of template.fields) {
    const cell = sheet[XLSX.utils.encode_cell({ c: field.columnIndex, r: 1 })] as
      | StyledCell
      | undefined
    const style = cloneStyle(cell)
    if (style) rowStyles.set(field.columnIndex, style)
  }
  clearDataRows(sheet)

  records.forEach((record, recordIndex) => {
    for (const field of template.fields) {
      const mapping = template.mappings.find((candidate) => candidate.fieldPath === field.path)
      if (!mapping) throw new Error(`表格列 ${field.column}（${field.name}）尚未配置`)
      const cell: StyledCell = {
        t: 's',
        v: resolveFieldValue(mapping, field, record)
      }
      const style = rowStyles.get(field.columnIndex)
      if (style) cell.s = style
      sheet[XLSX.utils.encode_cell({ c: field.columnIndex, r: recordIndex + 1 })] = cell
    }
  })

  const lastColumn = Math.max(...template.fields.map((field) => field.columnIndex))
  sheet['!ref'] = XLSX.utils.encode_range({
    s: { c: 0, r: 0 },
    e: { c: lastColumn, r: records.length }
  })
  if (sheet['!autofilter']) sheet['!autofilter'].ref = sheet['!ref']

  if (template.format === 'xls') sanitizeBiff8Properties(workbook)

  const bytes = XLSX.write(workbook, {
    type: 'buffer',
    bookType: template.format === 'xls' ? 'biff8' : 'xlsx',
    cellStyles: true,
    bookSST: template.format === 'xls'
  })
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
}

export const validateSpreadsheetBatch = (
  bytes: Buffer,
  template: SpreadsheetTemplateConfig,
  records: ExtractedRecord[]
): void => {
  const workbook = readWorkbook(bytes)
  const sheet = workbook.Sheets[template.sheetName]
  if (!sheet) throw new Error(`生成的表格缺少工作表“${template.sheetName}”`)
  for (const [recordIndex, record] of records.entries()) {
    for (const field of template.fields) {
      const mapping = template.mappings.find((candidate) => candidate.fieldPath === field.path)
      if (!mapping) throw new Error(`表格列 ${field.column}（${field.name}）尚未配置`)
      const expected = resolveFieldValue(mapping, field, record)
      const cell = sheet[XLSX.utils.encode_cell({ c: field.columnIndex, r: recordIndex + 1 })]
      const actual = cell?.v === undefined || cell.v === null ? '' : String(cell.v)
      if (actual !== expected) {
        throw new Error(`表格写入校验失败：${field.column} 列第 ${recordIndex + 2} 行内容不一致`)
      }
      if ((cell as XLSX.CellObject | undefined)?.f) {
        throw new Error(`表格写入校验失败：${field.column} 列第 ${recordIndex + 2} 行被解释为公式`)
      }
    }
  }
}

export const readSpreadsheetCell = (
  bytes: Buffer,
  sheetName: string,
  address: string
): XLSX.CellObject | undefined => readWorkbook(bytes).Sheets[sheetName]?.[address]
