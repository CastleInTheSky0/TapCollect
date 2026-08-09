import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { registerIpcHandlers } from '@main/ipc'
import { PreviewService } from '@main/services/preview-service'
import { RunManager } from '@main/services/run-manager'
import { TaskStore } from '@main/services/task-store'

interface PreloadSmokeResult {
  hasCollector: boolean
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
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: taskBundlePath })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [taskBundlePath] })
    registerIpcHandlers(window, store, runManager, preview)

    await window.loadFile(join(__dirname, '../renderer/index.html'))
    writeStage('renderer-loaded')
    await new Promise<void>((resolve) => setTimeout(resolve, 300))

    const result = (await window.webContents.executeJavaScript(`
      (async () => {
        const api = window.collector
        if (!api) {
          return {
            hasCollector: false,
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
            taskConfigImportWorks: false
          }
        }
        const unsubscribe = api.onRunProgress(() => undefined)
        const unsubscribeSession = api.onRunSession(() => undefined)
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
        unsubscribeSession()
        return result
      })()
    `)) as Omit<PreloadSmokeResult, 'consoleErrors'>
    writeStage('renderer-evaluated')

    return { ...result, consoleErrors }
  } finally {
    writeStage('cleanup')
    preview?.close()
    window?.destroy()
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
