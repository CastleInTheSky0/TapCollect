import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTask } from '@shared/defaults'
import { configureXmlRecord } from '@main/core/xml-template'
import type { ExtractedRecord } from '@shared/types'
import { XmlOutputSession, readOutputXml } from './output-writer'
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
