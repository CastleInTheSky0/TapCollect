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
