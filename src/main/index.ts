import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import { registerIpcHandlers } from './ipc'
import { PreviewService } from './services/preview-service'
import { ElectronDynamicPageProvider } from './services/dynamic-page-service'
import { prepareDataDirectory } from './services/data-directory'
import { RunManager } from './services/run-manager'
import { TaskStore } from './services/task-store'

const APP_NAME = 'TapCollect'
const APP_ID = 'cn.local.tapcollect'
const IS_DEVELOPMENT_PREVIEW =
  !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)

let mainWindow: BrowserWindow | null = null

const createWindow = async (): Promise<void> => {
  const windowOptions: BrowserWindowConstructorOptions = {
    title: APP_NAME,
    width: 1500,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    autoHideMenuBar: !IS_DEVELOPMENT_PREVIEW,
    backgroundColor: '#f3f4f6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  }
  if (!app.isPackaged) windowOptions.icon = join(app.getAppPath(), 'build', 'icon.png')
  const window = new BrowserWindow(windowOptions)
  if (!IS_DEVELOPMENT_PREVIEW) window.removeMenu()
  mainWindow = window
  const dataDirectory = await prepareDataDirectory({
    isPackaged: app.isPackaged,
    platform: process.platform,
    appPath: app.getAppPath(),
    executablePath: app.getPath('exe'),
    legacyRootDirectory: join(app.getPath('userData'), 'collector-data')
  })
  if (dataDirectory.warning) console.warn(dataDirectory.warning)
  const store = new TaskStore(dataDirectory.rootDirectory)
  await store.initialize()
  const runManager = new RunManager(store, new ElectronDynamicPageProvider(window))
  await runManager.initialize()
  const preview = new PreviewService(window)
  registerIpcHandlers(window, store, runManager, preview)

  let confirmedClose = false
  window.on('close', (event) => {
    if (confirmedClose || !runManager.hasActiveRun()) return
    event.preventDefault()
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        title: '任务仍在运行',
        message: '退出前会保存当前检查点，下次可以继续。确定退出吗？',
        buttons: ['取消', '保存并退出'],
        defaultId: 0,
        cancelId: 0
      })
      .then(async (result) => {
        if (result.response !== 1) return
        await runManager.prepareForShutdown()
        confirmedClose = true
        preview.close()
        window.close()
      })
  })
  window.on('closed', () => {
    preview.close()
    if (mainWindow === window) mainWindow = null
  })

  window.once('ready-to-show', () => window.show())
  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setName(APP_NAME)

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    if (!IS_DEVELOPMENT_PREVIEW) Menu.setApplicationMenu(null)
    await createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
