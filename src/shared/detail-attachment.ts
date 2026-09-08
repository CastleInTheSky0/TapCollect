import type { TaskConfig } from './types'
import { taskOutputFields } from './output-template'

export const isDetailAttachmentEnabled = (task: TaskConfig): boolean =>
  task.detail.enabled && task.detail.navigationMode === 'link' &&
  task.detail.attachment?.enabled === true

export const detailAttachmentConfigurationIssues = (task: TaskConfig): string[] => {
  if (!isDetailAttachmentEnabled(task)) return []
  const issues: string[] = []
  const fieldPath = task.detail.attachment.fieldPath.trim()
  if (!fieldPath) issues.push('请选择附件链接回填字段')
  else if (!taskOutputFields(task).some((field) => field.path === fieldPath)) {
    issues.push(`附件链接回填字段“${fieldPath}”不在当前输出模板中，请重新选择`)
  }
  if (!task.resources.download.enabled) {
    issues.push('识别并下载附件链接需要在第 5 步“资源处理”中开启“下载资源”')
  }
  return issues
}
