import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { app, net } from 'electron'
import type { TaskConfig } from '@shared/types'
import { analyzeTaskListPageRules } from '@shared/list-page-rules'
import { CollectorEngine, CollectorRunControl } from '@main/core/collector-engine'
import { HttpClient } from '@main/core/http-client'
import { validateXmlOutput } from '@main/core/xml-template'
import { TaskStore } from '@main/services/task-store'

const taskConfigPath = (): string => {
  const configuredPath = process.argv[2] || process.env.TAPCOLLECT_SMOKE_TASK
  if (!configuredPath?.trim()) {
    throw new Error(
      '请通过命令参数或 TAPCOLLECT_SMOKE_TASK 提供一个未提交的本地 task.json 路径'
    )
  }
  return resolve(configuredPath)
}

const loadSmokeTask = async (path: string, temporaryRoot: string): Promise<TaskConfig> => {
  const task = JSON.parse(await readFile(path, 'utf8')) as TaskConfig
  const firstUrl = analyzeTaskListPageRules(task).firstUrl
  if (!firstUrl) throw new Error('本地任务没有可用于冒烟验证的列表页地址')

  task.id = 'live-smoke'
  task.name = `冒烟验证-${task.name || '未命名任务'}`
  task.listUrl = firstUrl
  task.listPageRules = [firstUrl]
  task.pagination.urlTemplate = ''
  task.pagination.startPage = 1
  task.pagination.step = 1
  task.pagination.maxPages = 1
  task.request.delayMs = 0
  task.output.rootDirectory = join(temporaryRoot, 'output')
  task.output.recordsPerFile = Math.min(3, Math.max(1, task.output.recordsPerFile))
  task.output.overwrite = true
  return task
}

const run = async (): Promise<void> => {
  const sourcePath = taskConfigPath()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'tapcollect-live-smoke-'))
  try {
    const store = new TaskStore(join(temporaryRoot, 'data'))
    const task = await store.saveTask(await loadSmokeTask(sourcePath, temporaryRoot))
    const engine = new CollectorEngine(store, new HttpClient(net.fetch as typeof fetch))
    const tested = await engine.testTask(task)
    if (tested.listItemCount === 0 || tested.records.length === 0) {
      throw new Error('本地任务未采集到列表或详情记录')
    }
    validateXmlOutput(tested.xmlPreview)

    const result = await engine.run(task, null, new CollectorRunControl(), {
      progress: () => undefined,
      log: () => undefined
    })
    if (result.status !== 'completed' || result.outputFiles.length === 0) {
      throw new Error(`本地任务正式采集失败：${result.message}`)
    }

    for (const outputFile of result.outputFiles) {
      validateXmlOutput(await readFile(outputFile, 'utf8'))
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          sourceTask: basename(sourcePath),
          listItems: tested.listItemCount,
          testedRecords: tested.records.length,
          outputRecords: result.counters.succeeded,
          outputFiles: result.outputFiles.length,
          xmlEncoding: task.xml?.encoding ?? ''
        },
        null,
        2
      )}\n`
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

app.whenReady().then(async () => {
  try {
    await run()
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
