import type { TaskConfig } from '@shared/types'

export const snapshotForIpc = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T

export const snapshotTaskForIpc = (task: TaskConfig): TaskConfig =>
  snapshotForIpc(task)

export const taskDraftFingerprint = (task: TaskConfig): string =>
  JSON.stringify(snapshotTaskForIpc(task))
