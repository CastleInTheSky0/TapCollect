import type { TaskConfig } from '@shared/types'

export const snapshotTaskForIpc = (task: TaskConfig): TaskConfig =>
  JSON.parse(JSON.stringify(task)) as TaskConfig
