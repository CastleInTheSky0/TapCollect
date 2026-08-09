import { contextBridge, ipcRenderer } from 'electron'
import type {
  CollectorApi,
  RunLog,
  RunProgress,
  RunResult,
  RunSessionSnapshot
} from '@shared/types'
import { IPC_CHANNELS } from '@shared/ipc-channels'

const eventSubscription = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: CollectorApi = {
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings),
  listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.listTasks),
  loadTask: (id) => ipcRenderer.invoke(IPC_CHANNELS.loadTask, id),
  saveTask: (task) => ipcRenderer.invoke(IPC_CHANNELS.saveTask, task),
  duplicateTask: (id) => ipcRenderer.invoke(IPC_CHANNELS.duplicateTask, id),
  deleteTask: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteTask, id),
  chooseOutputDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseOutputDirectory),
  chooseResourceDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseResourceDirectory),
  importXmlTemplate: () => ipcRenderer.invoke(IPC_CHANNELS.importXmlTemplate),
  importSpreadsheetTemplate: () =>
    ipcRenderer.invoke(IPC_CHANNELS.importSpreadsheetTemplate),
  inspectXmlTemplate: (content) => ipcRenderer.invoke(IPC_CHANNELS.inspectXmlTemplate, content),
  selectXmlRecord: (content, fileName, recordPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectXmlRecord, content, fileName, recordPath),
  detectPaginationParameters: (url) =>
    ipcRenderer.invoke(IPC_CHANNELS.detectPaginationParameters, url),
  getDetailSamples: (task) => ipcRenderer.invoke(IPC_CHANNELS.getDetailSamples, task),
  testTask: (task) => ipcRenderer.invoke(IPC_CHANNELS.testTask, task),
  getCheckpoint: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.getCheckpoint, taskId),
  getRunSession: () => ipcRenderer.invoke(IPC_CHANNELS.getRunSession),
  startRun: (taskId, resume) => ipcRenderer.invoke(IPC_CHANNELS.startRun, taskId, resume),
  pauseRun: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.pauseRun, taskId),
  resumeRun: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.resumeRun, taskId),
  cancelRun: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.cancelRun, taskId),
  pauseAllRuns: () => ipcRenderer.invoke(IPC_CHANNELS.pauseAllRuns),
  resumeAllRuns: () => ipcRenderer.invoke(IPC_CHANNELS.resumeAllRuns),
  cancelAllRuns: () => ipcRenderer.invoke(IPC_CHANNELS.cancelAllRuns),
  openOutputDirectory: (taskId) =>
    ipcRenderer.invoke(IPC_CHANNELS.openOutputDirectory, taskId),
  openErrorLog: (taskId, path) =>
    ipcRenderer.invoke(IPC_CHANNELS.openErrorLog, taskId, path),
  previewOpen: (url, bounds) => ipcRenderer.invoke(IPC_CHANNELS.previewOpen, url, bounds),
  previewNavigate: (url) => ipcRenderer.invoke(IPC_CHANNELS.previewNavigate, url),
  previewSetBounds: (bounds) => ipcRenderer.invoke(IPC_CHANNELS.previewSetBounds, bounds),
  previewClose: () => ipcRenderer.invoke(IPC_CHANNELS.previewClose),
  previewPick: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewPick, request),
  previewEvaluate: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewEvaluate, request),
  onRunProgress: (listener) => eventSubscription<RunProgress>(IPC_CHANNELS.runProgress, listener),
  onRunLog: (listener) => eventSubscription<RunLog>(IPC_CHANNELS.runLog, listener),
  onRunFinished: (listener) => eventSubscription<RunResult>(IPC_CHANNELS.runFinished, listener),
  onRunSession: (listener) =>
    eventSubscription<RunSessionSnapshot>(IPC_CHANNELS.runSession, listener)
}

contextBridge.exposeInMainWorld('collector', api)
