import { basename, dirname, extname, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import chardet from 'chardet'
import iconv from 'iconv-lite'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppSettings,
  PreviewBounds,
  PreviewEvaluateRequest,
  PreviewPickRequest,
  TaskConfig
} from '@shared/types'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { detectPaginationParameters, sanitizeFileName } from '@main/core/url-utils'
import {
  configureXmlRecord,
  detectXmlEncoding,
  inspectXmlTree
} from '@main/core/xml-template'
import type { PreviewService } from './services/preview-service'
import type { RunManager } from './services/run-manager'
import type { TaskStore } from './services/task-store'

const decodeXmlFile = (bytes: Buffer): string => {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 1_024)).toString('latin1')
  const declared = prefix.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i)?.[1]
  const detected = declared || chardet.detect(bytes) || 'utf-8'
  const normalized = detected.toLowerCase() === 'gb2312' ? 'gbk' : detected
  if (!iconv.encodingExists(normalized)) throw new Error(`不支持 XML 模板编码：${detected}`)
  return iconv.decode(bytes, normalized)
}

export const registerIpcHandlers = (
  window: BrowserWindow,
  store: TaskStore,
  runManager: RunManager,
  preview: PreviewService
): void => {
  ipcMain.handle(IPC_CHANNELS.getSettings, () => store.getSettings())
  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, settings: AppSettings) =>
    store.saveSettings(settings)
  )
  ipcMain.handle(IPC_CHANNELS.listTasks, () => store.listTasks())
  ipcMain.handle(IPC_CHANNELS.loadTask, (_event, id: string) => store.loadTask(id))
  ipcMain.handle(IPC_CHANNELS.saveTask, (_event, task: TaskConfig) => store.saveTask(task))
  ipcMain.handle(IPC_CHANNELS.duplicateTask, (_event, id: string) => store.duplicateTask(id))
  ipcMain.handle(IPC_CHANNELS.deleteTask, (_event, id: string) => store.deleteTask(id))
  ipcMain.handle(IPC_CHANNELS.chooseOutputDirectory, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择 XML 输出根目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? '' : (result.filePaths[0] ?? '')
  })
  ipcMain.handle(IPC_CHANNELS.chooseResourceDirectory, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择资源存放根目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? '' : (result.filePaths[0] ?? '')
  })
  ipcMain.handle(IPC_CHANNELS.importXmlTemplate, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '导入 XML 模板',
      properties: ['openFile'],
      filters: [{ name: 'XML 文件', extensions: ['xml'] }]
    })
    if (result.canceled || !result.filePaths[0]) {
      return { cancelled: true, template: null, tree: [] }
    }
    const path = result.filePaths[0]
    const content = decodeXmlFile(await readFile(path))
    const fileName = basename(path)
    const tree = inspectXmlTree(content)
    return {
      cancelled: false,
      template: {
        fileName,
        content,
        encoding: detectXmlEncoding(content),
        recordPath: '',
        fields: [],
        mappings: [],
        importedAt: new Date().toISOString()
      },
      tree
    }
  })
  ipcMain.handle(IPC_CHANNELS.inspectXmlTemplate, (_event, content: string) =>
    inspectXmlTree(content)
  )
  ipcMain.handle(
    IPC_CHANNELS.selectXmlRecord,
    (_event, content: string, fileName: string, recordPath: string) =>
      configureXmlRecord(content, fileName, recordPath)
  )
  ipcMain.handle(IPC_CHANNELS.detectPaginationParameters, (_event, url: string) =>
    detectPaginationParameters(url)
  )
  ipcMain.handle(IPC_CHANNELS.getDetailSamples, async (_event, task: TaskConfig) => {
    const saved = await store.saveTask(task)
    return runManager.getDetailSamples(saved.id)
  })
  ipcMain.handle(IPC_CHANNELS.testTask, (_event, task: TaskConfig) =>
    store.saveTask(task).then((saved) => runManager.testTask(saved.id))
  )
  ipcMain.handle(IPC_CHANNELS.getCheckpoint, (_event, taskId: string) =>
    store.getCheckpoint(taskId)
  )
  ipcMain.handle(IPC_CHANNELS.startRun, (_event, taskId: string, resume: boolean) =>
    runManager.start(taskId, resume)
  )
  ipcMain.handle(IPC_CHANNELS.pauseRun, (_event, runId: string) => runManager.pause(runId))
  ipcMain.handle(IPC_CHANNELS.resumeRun, (_event, runId: string) => runManager.resume(runId))
  ipcMain.handle(IPC_CHANNELS.cancelRun, (_event, runId: string) => runManager.cancel(runId))
  ipcMain.handle(IPC_CHANNELS.openOutputDirectory, async (_event, taskId: string) => {
    const task = await store.loadTask(taskId)
    if (!task) return false
    const error = await shell.openPath(join(task.output.rootDirectory, sanitizeFileName(task.name)))
    return error === ''
  })
  ipcMain.handle(
    IPC_CHANNELS.openErrorLog,
    async (_event, taskId: string, path: string) => {
      const task = await store.loadTask(taskId)
      if (!task) return false
      const outputDirectory = resolve(
        join(task.output.rootDirectory, sanitizeFileName(task.name))
      )
      const resolvedPath = resolve(path)
      if (dirname(resolvedPath) !== outputDirectory || extname(resolvedPath).toLowerCase() !== '.csv') {
        return false
      }
      const error = await shell.openPath(resolvedPath)
      return error === ''
    }
  )
  ipcMain.handle(IPC_CHANNELS.previewOpen, (_event, url: string, bounds: PreviewBounds) =>
    preview.open(url, bounds)
  )
  ipcMain.handle(IPC_CHANNELS.previewNavigate, (_event, url: string) => preview.navigate(url))
  ipcMain.handle(IPC_CHANNELS.previewSetBounds, (_event, bounds: PreviewBounds) =>
    preview.setBounds(bounds)
  )
  ipcMain.handle(IPC_CHANNELS.previewClose, () => preview.close())
  ipcMain.handle(IPC_CHANNELS.previewPick, (_event, request: PreviewPickRequest) =>
    preview.pick(request)
  )
  ipcMain.handle(IPC_CHANNELS.previewEvaluate, (_event, request: PreviewEvaluateRequest) =>
    preview.evaluate(request)
  )

  const removeProgress = runManager.onProgress((progress) =>
    window.webContents.send(IPC_CHANNELS.runProgress, progress)
  )
  const removeLog = runManager.onLog((log) => window.webContents.send(IPC_CHANNELS.runLog, log))
  const removeFinished = runManager.onFinished((result) =>
    window.webContents.send(IPC_CHANNELS.runFinished, result)
  )
  window.once('closed', () => {
    removeProgress()
    removeLog()
    removeFinished()
  })
}
