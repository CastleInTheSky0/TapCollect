import type {
  FieldMapping,
  OutputFieldDefinition,
  OutputFormat,
  TaskConfig
} from './types'

export interface TaskOutputTemplate {
  format: OutputFormat
  fileName: string
  fields: OutputFieldDefinition[]
  mappings: FieldMapping[]
}

export const xmlRecordPathIssue = (recordPath: string): string | null => {
  const depth = recordPath.trim().split('/').filter(Boolean).length
  if (depth === 0) return '请在 XML 模板中选择记录节点'
  if (depth === 1) {
    return 'XML 根节点不能作为记录节点，请在第 4 步“模板映射”的 XML 树中选择单条子记录节点'
  }
  return null
}

export const taskOutputTemplate = (task: TaskConfig): TaskOutputTemplate | null => {
  if (task.output.format === 'spreadsheet') {
    if (!task.spreadsheet) return null
    return {
      format: 'spreadsheet',
      fileName: task.spreadsheet.fileName,
      fields: task.spreadsheet.fields,
      mappings: task.spreadsheet.mappings
    }
  }
  if (!task.xml) return null
  return {
    format: 'xml',
    fileName: task.xml.fileName,
    fields: task.xml.fields,
    mappings: task.xml.mappings
  }
}

export const taskOutputFields = (task: TaskConfig): OutputFieldDefinition[] =>
  taskOutputTemplate(task)?.fields ?? []

export const taskOutputMappings = (task: TaskConfig): FieldMapping[] =>
  taskOutputTemplate(task)?.mappings ?? []
