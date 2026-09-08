import type { ResourceKind, TaskConfig, ExtractedRecord } from '@shared/types'
import { isDetailAttachmentEnabled } from '@shared/detail-attachment'
import { candidateToRecord, type ListCandidate } from './extraction'
import { classifyResourceReference, createResourcePlan } from './resource-planner'

export const detailAttachmentKind = (url: string): ResourceKind | null =>
  classifyResourceReference(url, { tagName: 'a', attributeName: 'href' })

export const detailResponseAttachmentKind = (url: string, headers: Headers): ResourceKind | null => {
  const type = (headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const disposition = headers.get('content-disposition') ?? ''
  if (/^\s*attachment\b/i.test(disposition)) return detailAttachmentKind(url) ?? 'attachment'
  // HTML 响应仍交给网页提取和站点保护识别，不能仅凭文件名保存登录页。
  if (type === 'text/html' || type === 'application/xhtml+xml') return null
  const kind = detailAttachmentKind(url)
  if (kind) return kind
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  if (
    /^application\/(?:pdf|octet-stream|zip|x-zip-compressed|gzip|x-gzip|x-7z-compressed|x-rar-compressed|vnd\.rar|msword|rtf)$/.test(type) ||
    /^application\/vnd\.(?:openxmlformats-officedocument\.|ms-excel|ms-powerpoint|ms-word|oasis\.opendocument\.)/.test(type) ||
    type === 'text/csv'
  ) return 'attachment'
  return null
}

// 回填目标的列表必填检查推迟到识别完成后；其余列表必填仍提前检查。
export const immediateMissingListFields = (task: TaskConfig, candidate: ListCandidate): string[] =>
  candidate.missingListFields.filter((path) =>
    !isDetailAttachmentEnabled(task) || path !== task.detail.attachment.fieldPath
  )

export const createDetailAttachmentRecord = (
  task: TaskConfig,
  candidate: ListCandidate,
  url: string,
  kind: ResourceKind
): ExtractedRecord => {
  const plan = createResourcePlan(
    url, candidate.listUrl, candidate.listUrl,
    task.resources.download.rootDirectory, task.resources.download.urlPrefix,
    kind, task.resources.encodeUrls
  )
  if (!plan) throw new Error('详情附件地址必须与列表页主机名相同')
  const record = candidateToRecord(candidate)
  record.detailUrl = url
  record.detailAttachment = { fieldPath: task.detail.attachment.fieldPath, url: plan.xmlUrl }
  record.values[task.detail.attachment.fieldPath] = plan.xmlUrl
  record.resources = [...candidate.resources, plan]
  return record
}
