import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, net, shell } from 'electron'
import type { UpdateInstallResult } from '@shared/types'
import type { BrowserWindowConstructorOptions } from 'electron'
import { registerIpcHandlers } from './ipc'
import { PreviewService } from './services/preview-service'
import { ElectronDynamicPageProvider } from './services/dynamic-page-service'
import { prepareDataDirectory } from './services/data-directory'
import { RunManager } from './services/run-manager'
import { TaskStore } from './services/task-store'
import { UpdateService } from './services/update-service'

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
    platform: process.platform,
    userDataDirectory: app.getPath('userData')
  })
  const store = new TaskStore(dataDirectory.rootDirectory)
  await store.initialize()
  const runManager = new RunManager(store, new ElectronDynamicPageProvider(window))
  await runManager.initialize()
  const preview = new PreviewService(window)
  let confirmedClose = false
  const updateService = new UpdateService({
    appName: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
    developmentPreview: IS_DEVELOPMENT_PREVIEW,
    temporaryDirectory: app.getPath('temp'),
    fetcher: net.fetch as typeof fetch,
    openPath: (path) => shell.openPath(path),
    openExternal: (url) => shell.openExternal(url)
  })
  const installUpdate = async (downloadId: string): Promise<UpdateInstallResult> => {
    if (IS_DEVELOPMENT_PREVIEW) {
      throw new Error('本地开发预览只检查更新，不启动安装包')
    }
    const download = updateService.getDownloadedUpdate(downloadId)
    if (!download) throw new Error('找不到已验证的更新安装包，请重新下载')
    await updateService.verifyDownloaded(downloadId)
    const hasActiveRun = runManager.hasActiveRun()
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: '安装 TapCollect 更新',
      message: hasActiveRun
        ? '当前有采集或测试任务正在运行、排队或暂停。继续后会先保存安全检查点，再退出应用并打开安装包。'
        : 'TapCollect 将退出并打开安装包，是否继续？',
      detail: `${download.fileName}\n安装完成后请重新打开 TapCollect。`,
      buttons: ['取消', hasActiveRun ? '保存并安装' : '立即安装'],
      defaultId: 0,
      cancelId: 0
    })
    if (result.response !== 1) {
      return { started: false, cancelled: true, message: '已取消安装' }
    }
    const shutdownSnapshot = await runManager.prepareForShutdown()
    try {
      await updateService.installDownloaded(downloadId)
    } catch (error) {
      await runManager.restoreAfterFailedShutdown(shutdownSnapshot)
      throw error
    }
    confirmedClose = true
    preview.close()
    setTimeout(() => app.quit(), 100)
    return { started: true, cancelled: false, message: '安装包已打开' }
  }
  registerIpcHandlers(
    window,
    store,
    runManager,
    preview,
    updateService,
    installUpdate
  )

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
