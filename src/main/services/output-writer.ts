import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import iconv from 'iconv-lite'
import type {
  ExtractedRecord,
  RecordFailure,
  SpreadsheetFormat,
  TaskConfig
} from '@shared/types'
import {
  renderSpreadsheetBatch,
  validateSpreadsheetBatch
} from '@main/core/spreadsheet-template'
import { renderXmlBatch, validateXmlOutput } from '@main/core/xml-template'
import { sanitizeFileName } from '@main/core/url-utils'
import type { TaskStore } from './task-store'

const CSV_COLUMNS = [
  '页码',
  '页面内序号',
  '列表URL',
  '详情URL',
  '失败阶段',
  '字段',
  '原因',
  '重试次数',
  '时间'
]

const atomicWrite = async (path: string, content: Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content)
  try {
    await rename(temporary, path)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    await rm(path, { force: true })
    await rename(temporary, path)
  }
}

const csvCell = (value: string | number): string => `"${String(value).replace(/"/g, '""')}"`

const normalizeOutputEncoding = (encoding: string): string => {
  const value = encoding.trim().toLowerCase()
  if (value === 'utf8') return 'utf-8'
  if (value === 'gb2312') return 'gbk'
  return value || 'utf-8'
}

export type OutputFileExtension = 'xml' | SpreadsheetFormat

export const outputFileExtension = (task: TaskConfig): OutputFileExtension => {
  if (task.output.format === 'spreadsheet') {
    if (!task.spreadsheet) throw new Error('任务尚未配置表格模板')
    return task.spreadsheet.format
  }
  if (!task.xml) throw new Error('任务尚未配置 XML 模板')
  return 'xml'
}

export const renderOutputFile = (
  task: TaskConfig,
  records: ExtractedRecord[]
): Buffer => {
  if (task.output.format === 'spreadsheet') {
    if (!task.spreadsheet) throw new Error('任务尚未配置表格模板')
    const bytes = renderSpreadsheetBatch(task.spreadsheet, records)
    validateSpreadsheetBatch(bytes, task.spreadsheet, records)
    return bytes
  }

  if (!task.xml) throw new Error('任务尚未配置 XML 模板')
  const xml = renderXmlBatch(task.xml, records)
  validateXmlOutput(xml)
  const encoding = normalizeOutputEncoding(task.xml.encoding)
  if (!iconv.encodingExists(encoding)) {
    throw new Error(`不支持 XML 编码：${task.xml.encoding}`)
  }
  const bytes = iconv.encode(xml, encoding)
  validateXmlOutput(iconv.decode(bytes, encoding))
  return bytes
}

export interface CollectorOutputSession {
  readonly outputDirectory: string
  readonly errorLogPath: string
  prepare: (freshRun: boolean) => Promise<void>
  writeBatch: (records: ExtractedRecord[], fileIndex: number) => Promise<string>
  appendFailure: (failure: RecordFailure) => Promise<void>
}

abstract class FileOutputSession implements CollectorOutputSession {
  readonly outputDirectory: string
  readonly errorLogPath: string
  private manifestFiles: string[] = []

  constructor(
    protected readonly task: TaskConfig,
    private readonly store: TaskStore,
    readonly runStamp: string,
    private readonly extension: string,
    errorLogPath = ''
  ) {
    this.outputDirectory = join(task.output.rootDirectory, sanitizeFileName(task.name))
    this.errorLogPath =
      errorLogPath || join(this.outputDirectory, this.buildBaseName('错误日志', 'csv'))
  }

  async prepare(freshRun: boolean): Promise<void> {
    await mkdir(this.outputDirectory, { recursive: true })
    this.manifestFiles = await this.store.getOutputManifest(this.task.id)
    if (freshRun && this.task.output.overwrite) await this.removePreviousOutputFiles()
    if (freshRun) {
      const header = `\uFEFF${CSV_COLUMNS.map(csvCell).join(',')}\r\n`
      await writeFile(this.errorLogPath, header, 'utf8')
    }
  }

  abstract writeBatch(records: ExtractedRecord[], fileIndex: number): Promise<string>

  async appendFailure(failure: RecordFailure): Promise<void> {
    const row = [
      failure.page,
      failure.itemIndex,
      failure.listUrl,
      failure.detailUrl,
      failure.stage,
      failure.fieldPath,
      failure.reason,
      failure.retries,
      failure.time
    ]
      .map(csvCell)
      .join(',')
    await appendFile(this.errorLogPath, `${row}\r\n`, 'utf8')
  }

  protected assertBatchSize(records: ExtractedRecord[]): void {
    if (records.length === 0) throw new Error('不能写入空输出批次')
    if (records.length > this.task.output.recordsPerFile || records.length > 200) {
      throw new Error('输出批次记录数超过配置上限')
    }
  }

  protected async commitBatch(bytes: Buffer, fileIndex: number): Promise<string> {
    const path = join(this.outputDirectory, this.buildOutputFileName(fileIndex))
    await atomicWrite(path, bytes)
    this.manifestFiles = [...new Set([...this.manifestFiles, path])]
    await this.store.saveOutputManifest(this.task.id, this.manifestFiles)
    return path
  }

  private buildOutputFileName(fileIndex: number): string {
    const taskName = sanitizeFileName(this.task.name)
    const index = String(fileIndex).padStart(3, '0')
    return this.task.output.overwrite
      ? `${taskName}_${index}.${this.extension}`
      : `${taskName}_${this.runStamp}_${index}.${this.extension}`
  }

  private buildBaseName(label: string, extension: string): string {
    const taskName = sanitizeFileName(this.task.name)
    return this.task.output.overwrite
      ? `${taskName}_${label}.${extension}`
      : `${taskName}_${label}_${this.runStamp}.${extension}`
  }

  private async removePreviousOutputFiles(): Promise<void> {
    const expectedDirectory = resolve(this.outputDirectory)
    const expectedExtension = `.${this.extension.toLowerCase()}`
    const retained: string[] = []
    for (const path of this.manifestFiles) {
      const resolvedPath = resolve(path)
      if (
        dirname(resolvedPath) === expectedDirectory &&
        extname(resolvedPath).toLowerCase() === expectedExtension
      ) {
        await rm(resolvedPath, { force: true })
      } else {
        retained.push(path)
      }
    }
    this.manifestFiles = retained
    await this.store.saveOutputManifest(this.task.id, retained)
  }
}

export class XmlOutputSession extends FileOutputSession {
  constructor(task: TaskConfig, store: TaskStore, runStamp: string, errorLogPath = '') {
    super(task, store, runStamp, 'xml', errorLogPath)
  }

  async writeBatch(records: ExtractedRecord[], fileIndex: number): Promise<string> {
    this.assertBatchSize(records)
    return this.commitBatch(renderOutputFile(this.task, records), fileIndex)
  }
}

export class SpreadsheetOutputSession extends FileOutputSession {
  constructor(task: TaskConfig, store: TaskStore, runStamp: string, errorLogPath = '') {
    super(task, store, runStamp, task.spreadsheet?.format ?? 'xlsx', errorLogPath)
  }

  async writeBatch(records: ExtractedRecord[], fileIndex: number): Promise<string> {
    this.assertBatchSize(records)
    return this.commitBatch(renderOutputFile(this.task, records), fileIndex)
  }
}

export const createOutputSession = (
  task: TaskConfig,
  store: TaskStore,
  runStamp: string,
  errorLogPath = ''
): CollectorOutputSession =>
  task.output.format === 'spreadsheet'
    ? new SpreadsheetOutputSession(task, store, runStamp, errorLogPath)
    : new XmlOutputSession(task, store, runStamp, errorLogPath)

export const readOutputXml = async (path: string, encoding: string): Promise<string> =>
  iconv.decode(await readFile(path), normalizeOutputEncoding(encoding))
