import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, WebContentsView } from 'electron'
import { registerIpcHandlers } from '@main/ipc'
import { PreviewService } from '@main/services/preview-service'
import { RunManager } from '@main/services/run-manager'
import { TaskStore } from '@main/services/task-store'
import { UpdateService } from '@main/services/update-service'
import type { PreviewPickResult } from '@shared/types'

interface PreloadSmokeResult {
  hasCollector: boolean
  hasUpdateApi: boolean
  hasRunSubscription: boolean
  hasTaskConfigTransfer: boolean
  settingsDirectory: string
  maxConcurrentRuns: number
  runSessionCapacity: number
  initialTaskCount: number
  savedTaskCount: number
  finalTaskCount: number
  uiReady: boolean
  taskConfigControlsReady: boolean
  createTaskWorks: boolean
  saveTaskWorks: boolean
  deleteTaskWorks: boolean
  taskConfigExportWorks: boolean
  taskConfigImportWorks: boolean
  previewPickWorks: boolean
  consoleErrors: string[]
}

type PreloadSmokeOutput =
  | { ok: true; result: PreloadSmokeResult }
  | { ok: false; error: string }

const resultPath = process.env.TAPCOLLECT_PRELOAD_SMOKE_RESULT?.trim() ?? ''
const stagePath = resultPath ? `${resultPath}.stage` : ''

const writeStage = (stage: string): void => {
  if (stagePath) writeFileSync(stagePath, stage, 'utf8')
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const listen = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()))

const withTimeout = async <T>(promise: Promise<T>, message: string): Promise<T> =>
  Promise.race([
    promise,
    delay(5_000).then(() => {
      throw new Error(message)
    })
  ])

const rejectionMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const verifyPreviewPick = async (
  window: BrowserWindow,
  preview: PreviewService,
  url: string
): Promise<boolean> => {
  const opened = await window.webContents.executeJavaScript(`
    window.collector.previewOpen(${JSON.stringify(url)}, {
      x: 0, y: 0, width: 960, height: 640
    })
  `)
  if (!opened) return false

  try {
    const previewView = window.contentView.children.find(
      (child): child is WebContentsView =>
        child instanceof WebContentsView && child.webContents.getURL() === url
    )
    if (!previewView) throw new Error('Electron 预览点选冒烟未找到 WebContentsView')

    const waitForPicker = async (): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const ready = await previewView.webContents.executeJavaScript(
          "Boolean(document.querySelector('[data-tapcollect-preview-picker]'))",
          true
        )
        if (ready) return
        await delay(25)
      }
      throw new Error('Electron 预览点选器未完成初始化')
    }

    const pickPromise = window.webContents.executeJavaScript(`
      window.collector.previewPick({ selectorType: 'css', scopeSelector: '' })
    `) as Promise<PreviewPickResult>
    await waitForPicker()

    await previewView.webContents.executeJavaScript(`
      (() => {
        const target = document.querySelector('#preview-smoke-list li:nth-child(2) a');
        if (!target) throw new Error('预览点选冒烟目标不存在');
        target.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window
        }));
        return true;
      })()
    `, true)

    const result = await withTimeout(pickPromise, 'Electron 预览点选结果等待超时')
    const successWorks =
      result.cancelled === false &&
      result.selector === '#preview-smoke-list > li' &&
      result.selectorType === 'css' &&
      result.matchCount === 3 &&
      result.sample === '冒烟标题二'

    const cancelPromise = preview.pick({ selectorType: 'css', scopeSelector: '' })
    await waitForPicker()
    await previewView.webContents.executeJavaScript(`
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      }));
      true;
    `, true)
    const cancelled = await withTimeout(cancelPromise, 'Electron 预览点选取消等待超时')
    const cancelWorks =
      cancelled.cancelled &&
      cancelled.selector === '' &&
      cancelled.matchCount === 0 &&
      cancelled.sample === ''

    const resolverErrorPromise = preview
      .pick({ selectorType: 'css', scopeSelector: '#missing-list-scope' })
      .then(() => '', rejectionMessage)
    await waitForPicker()
    await previewView.webContents.executeJavaScript(`
      document.querySelector('#preview-smoke-list li a').dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      }));
      true;
    `, true)
    const resolverError = await withTimeout(
      resolverErrorPromise,
      'Electron 预览点选错误等待超时'
    )

    const navigationErrorPromise = preview
      .pick({ selectorType: 'css', scopeSelector: '' })
      .then(() => '', rejectionMessage)
    await waitForPicker()
    await preview.navigate(`${url}?reloaded=1`)
    const navigationError = await withTimeout(
      navigationErrorPromise,
      'Electron 预览点选跳转等待超时'
    )

    const closeErrorPromise = preview
      .pick({ selectorType: 'css', scopeSelector: '' })
      .then(() => '', rejectionMessage)
    await waitForPicker()
    preview.close()
    const closeError = await withTimeout(closeErrorPromise, 'Electron 预览关闭等待超时')

    const checks = {
      successWorks,
      cancelWorks,
      resolverError,
      navigationError,
      closeError
    }
    if (
      !successWorks ||
      !cancelWorks ||
      !resolverError.includes('当前点击位置不在已配置的列表项范围内') ||
      !navigationError.includes('预览页面已刷新或跳转') ||
      !closeError.includes('网页预览已关闭')
    ) {
      throw new Error(`Electron 预览点选分支验证失败：${JSON.stringify(checks)}`)
    }
    return true
  } finally {
    await window.webContents.executeJavaScript('window.collector.previewClose()')
  }
}

writeStage('module-loaded')
app.on('window-all-closed', () => undefined)

const writeResult = async (output: PreloadSmokeOutput): Promise<void> => {
  const serialized = `${JSON.stringify(output, null, 2)}\n`
  if (resultPath) {
    await writeFile(resultPath, serialized, 'utf8')
    return
  }
  process.stdout.write(serialized)
}

const run = async (): Promise<PreloadSmokeResult> => {
  writeStage('waiting-for-ready')
  await app.whenReady()
  writeStage('app-ready')
  const dataRoot = await mkdtemp(join(tmpdir(), 'tapcollect-preload-smoke-'))
  let window: BrowserWindow | null = null
  let preview: PreviewService | null = null
  let previewServer: Server | null = null
  const taskBundlePath = join(dataRoot, 'task-config-bundle.json')
  const originalShowOpenDialog = dialog.showOpenDialog
  const originalShowSaveDialog = dialog.showSaveDialog
  const consoleErrors: string[] = []

  try {
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    writeStage('window-created')
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) consoleErrors.push(message)
    })
    const store = new TaskStore(dataRoot)
    await store.initialize()
    const runManager = new RunManager(store)
    await runManager.initialize()
    preview = new PreviewService(window)
    const updateService = new UpdateService({
      appName: 'TapCollect',
      version: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      developmentPreview: true,
      temporaryDirectory: dataRoot,
      fetcher: async () => new Response('', { status: 503 }),
      openPath: async () => '',
      openExternal: async () => undefined
    })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: taskBundlePath })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [taskBundlePath] })
    registerIpcHandlers(window, store, runManager, preview, updateService, async () => ({
      started: false,
      cancelled: true,
      message: '冒烟测试不执行安装'
    }))

    previewServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <html lang="zh-CN"><body>
          <ul id="preview-smoke-list">
            <li><a href="/one">冒烟标题一</a></li>
            <li><a href="/two">冒烟标题二</a></li>
            <li><a href="/three">冒烟标题三</a></li>
          </ul>
        </body></html>`)
    })
    await listen(previewServer)
    const previewAddress = previewServer.address() as AddressInfo | null
    if (!previewAddress) throw new Error('Electron 预览点选冒烟服务启动失败')
    const previewUrl = `http://127.0.0.1:${previewAddress.port}/`

    await window.loadFile(join(__dirname, '../renderer/index.html'))
    writeStage('renderer-loaded')
    await new Promise<void>((resolve) => setTimeout(resolve, 300))

    const result = (await window.webContents.executeJavaScript(`
      (async () => {
        const api = window.collector
        if (!api) {
          return {
            hasCollector: false,
            hasUpdateApi: false,
            hasRunSubscription: false,
            hasTaskConfigTransfer: false,
            settingsDirectory: '',
            maxConcurrentRuns: -1,
            runSessionCapacity: -1,
            initialTaskCount: -1,
            savedTaskCount: -1,
            finalTaskCount: -1,
            uiReady: false,
            taskConfigControlsReady: false,
            createTaskWorks: false,
            saveTaskWorks: false,
            deleteTaskWorks: false,
            taskConfigExportWorks: false,
            taskConfigImportWorks: false,
            previewPickWorks: false
          }
        }
        const unsubscribe = api.onRunProgress(() => undefined)
        const unsubscribeUpdate = api.onUpdateDownloadProgress(() => undefined)
        const unsubscribeSession = api.onRunSession(() => undefined)
        const runtimeInfo = await api.getAppRuntimeInfo()
        const settings = await api.getSettings()
        const runSession = await api.getRunSession()
        const initialTasks = await api.listTasks()
        const taskConfigToolsButton = document.querySelector(
          'button[aria-label="任务配置工具"]'
        )
        taskConfigToolsButton?.click()
        await new Promise((resolve) => setTimeout(resolve, 100))
        const taskConfigControlsReady =
          document.body.textContent?.includes('导入任务配置') === true &&
          document.body.textContent?.includes('导出全部任务配置') === true
        taskConfigToolsButton?.click()
        const createButton = [...document.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('新建任务')
        )
        createButton?.click()
        await new Promise((resolve) => setTimeout(resolve, 100))

        const taskNameInput = document.querySelector('input[placeholder="例如：图片新闻"]')
        const listUrlInput = document.querySelector(
          'textarea[placeholder*="包含 {page} 的模板"]'
        )
        const createTaskWorks = Boolean(taskNameInput && listUrlInput)

        const setInputValue = (element, value) => {
          const setter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(element),
            'value'
          )?.set
          setter?.call(element, value)
          element.dispatchEvent(new Event('input', { bubbles: true }))
        }

        if (taskNameInput && listUrlInput) {
          setInputValue(taskNameInput, 'Preload Smoke')
          setInputValue(listUrlInput, 'https://example.com/list.html')
        }

        const saveButton = [...document.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('保存草稿')
        )
        saveButton?.click()

        let savedTasks = initialTasks
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          savedTasks = await api.listTasks()
          if (savedTasks.some((task) => task.name === 'Preload Smoke')) break
        }

        const savedTask = savedTasks.find((task) => task.name === 'Preload Smoke')
        const exportResult = savedTask
          ? await api.exportTaskConfigs()
          : { cancelled: true, taskCount: 0, filePath: '' }
        const importResult = savedTask
          ? await api.importTaskConfigs()
          : { cancelled: true, imported: [], skipped: [] }
        const importedTask = importResult.imported[0]
        if (savedTask) await api.deleteTask(savedTask.id)
        if (importedTask) await api.deleteTask(importedTask.id)
        const finalTasks = await api.listTasks()

        const result = {
          hasCollector: typeof api.getSettings === 'function',
          hasUpdateApi:
            typeof api.checkForUpdates === 'function' &&
            typeof api.downloadUpdate === 'function' &&
            typeof api.installUpdate === 'function' &&
            typeof api.openUpdateRelease === 'function' &&
            typeof unsubscribeUpdate === 'function' &&
            runtimeInfo.appName === 'TapCollect',
          hasRunSubscription:
            typeof unsubscribe === 'function' && typeof unsubscribeSession === 'function',
          hasTaskConfigTransfer:
            typeof api.importTaskConfigs === 'function' &&
            typeof api.exportTaskConfigs === 'function',
          settingsDirectory: settings.defaultOutputDirectory,
          maxConcurrentRuns: settings.maxConcurrentRuns,
          runSessionCapacity: runSession.maxConcurrentRuns,
          initialTaskCount: initialTasks.length,
          savedTaskCount: savedTasks.length,
          finalTaskCount: finalTasks.length,
          uiReady: Boolean(createButton),
          taskConfigControlsReady,
          createTaskWorks,
          saveTaskWorks: Boolean(savedTask),
          deleteTaskWorks:
            Boolean(savedTask) &&
            !finalTasks.some((task) => task.id === savedTask.id || task.id === importedTask?.id),
          taskConfigExportWorks:
            !exportResult.cancelled && exportResult.taskCount === 1 && Boolean(exportResult.filePath),
          taskConfigImportWorks:
            !importResult.cancelled &&
            importResult.imported.length === 1 &&
            importResult.skipped.length === 0 &&
            importedTask?.id !== savedTask?.id
        }
        unsubscribe()
        unsubscribeUpdate()
        unsubscribeSession()
        return result
      })()
    `)) as Omit<PreloadSmokeResult, 'consoleErrors' | 'previewPickWorks'>
    writeStage('renderer-evaluated')

    const previewPickWorks = await verifyPreviewPick(window, preview, previewUrl)
    writeStage('preview-picker-verified')

    return { ...result, previewPickWorks, consoleErrors }
  } finally {
    writeStage('cleanup')
    preview?.close()
    window?.destroy()
    if (previewServer) await closeServer(previewServer)
    dialog.showOpenDialog = originalShowOpenDialog
    dialog.showSaveDialog = originalShowSaveDialog
    await rm(dataRoot, { recursive: true, force: true })
  }
}

const main = async (): Promise<void> => {
  try {
    const result = await run()
    if (
      !result.hasCollector ||
      !result.hasUpdateApi ||
      !result.hasRunSubscription ||
      !result.hasTaskConfigTransfer ||
      result.settingsDirectory !== '' ||
      result.maxConcurrentRuns !== 3 ||
      result.runSessionCapacity !== 3 ||
      result.initialTaskCount !== 0 ||
      result.savedTaskCount !== 1 ||
      result.finalTaskCount !== 0 ||
      !result.uiReady ||
      !result.taskConfigControlsReady ||
      !result.createTaskWorks ||
      !result.saveTaskWorks ||
      !result.deleteTaskWorks ||
      !result.taskConfigExportWorks ||
      !result.taskConfigImportWorks ||
      !result.previewPickWorks ||
      result.consoleErrors.some((message) =>
        /onRunProgress|Cannot read properties of undefined|Uncaught/i.test(message)
      )
    ) {
      throw new Error(`Electron preload 冒烟失败：${JSON.stringify(result)}`)
    }
    await writeResult({ ok: true, result })
    app.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    await writeResult({ ok: false, error: message })
    process.stderr.write(`${message}\n`)
    app.exit(1)
  }
}

void main()
