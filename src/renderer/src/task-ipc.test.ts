import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { createFieldMapping, createTask } from '@shared/defaults'
import { createMergeValue } from '@shared/field-mapping'
import { snapshotTaskForIpc } from './task-ipc'

describe('snapshotTaskForIpc', () => {
  it('converts a Vue reactive task into an Electron-cloneable JSON value', () => {
    const task = reactive(createTask('reactive-task'))
    task.listItem.selector = '.ListItem'
    task.pagination.mode = 'click'
    task.pagination.nextButton = { selectorType: 'xpath', selector: '//a[@title="下页"]' }
    task.request.headers.push({ id: 'referer', key: 'Referer', value: 'https://example.com' })
    task.resources.addressMode = 'prefix'
    task.resources.urlPrefix = '/resources'
    task.resources.download = {
      enabled: true,
      rootDirectory: 'D:/resources',
      urlPrefix: 'https://static.example.com/resources'
    }
    const field = {
      path: 'text',
      name: 'text',
      kind: 'element' as const,
      cdata: true,
      sampleValue: ''
    }
    const mapping = createFieldMapping(field)
    const mergeValue = createMergeValue('body')
    mergeValue.pageSource = 'detail'
    mergeValue.selector = '#content'
    mergeValue.replacements.push({ id: 'cleanup', from: '旧值', to: '新值' })
    mapping.mode = 'merge'
    mapping.mergeValues = [mergeValue]
    task.xml = {
      fileName: 'sample.xml',
      content: '<book><article><text/></article></book>',
      encoding: 'UTF-8',
      recordPath: '/book/article',
      fields: [field],
      mappings: [mapping],
      importedAt: '2026-08-07T00:00:00.000Z'
    }

    expect(() => structuredClone(task)).toThrow()

    const snapshot = snapshotTaskForIpc(task)

    expect(snapshot).toEqual(task)
    expect(snapshot).not.toBe(task)
    expect(snapshot.request).not.toBe(task.request)
    expect(snapshot.pagination.nextButton).toEqual({
      selectorType: 'xpath',
      selector: '//a[@title="下页"]'
    })
    expect(snapshot.resources).toEqual({
      addressMode: 'prefix',
      urlPrefix: '/resources',
      download: {
        enabled: true,
        rootDirectory: 'D:/resources',
        urlPrefix: 'https://static.example.com/resources'
      }
    })
    expect(snapshot.resources).not.toBe(task.resources)
    expect(snapshot.xml?.mappings[0]?.mergeValues[0]?.replacements[0]).toEqual({
      id: 'cleanup',
      from: '旧值',
      to: '新值'
    })
    expect(() => structuredClone(snapshot)).not.toThrow()
  })
})
