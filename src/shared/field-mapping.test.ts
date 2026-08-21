import { describe, expect, it } from 'vitest'
import { createFieldMapping } from './defaults'
import {
  createMergeValue,
  isFieldMappingConfigured,
  normalizeFieldMappingConfig
} from './field-mapping'

const mapping = () =>
  createFieldMapping({
    path: 'title',
    name: 'title',
    kind: 'element',
    cdata: false,
    sampleValue: ''
  })

describe('field mapping configuration', () => {
  it('requires selectors only for page values inside a merge', () => {
    const value = mapping()
    value.mode = 'merge'
    expect(isFieldMappingConfigured(value)).toBe(false)

    const page = createMergeValue('page')
    value.mergeValues = [page]
    expect(isFieldMappingConfigured(value)).toBe(false)

    page.selector = '.title'
    expect(isFieldMappingConfigured(value)).toBe(true)

    const fixed = createMergeValue('fixed')
    fixed.mode = 'fixed'
    fixed.fixedValue = ''
    value.mergeValues = [fixed]
    expect(isFieldMappingConfigured(value)).toBe(true)
  })

  it('normalizes missing merge properties from legacy mappings', () => {
    const legacy = mapping()
    const mergeValue = createMergeValue('legacy-page')
    legacy.mode = 'merge'
    legacy.mergeValues = [mergeValue]
    const raw = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>
    delete raw.mergeSeparator
    delete raw.convertToTimestamp
    delete raw.contentFilterSelectors
    delete raw.textPrefix
    const rawMergeValue = (raw.mergeValues as Array<Record<string, unknown>>)[0]!
    delete rawMergeValue.convertToTimestamp
    delete rawMergeValue.contentFilterSelectors
    delete rawMergeValue.textPrefix

    expect(normalizeFieldMappingConfig(raw as unknown as typeof legacy)).toMatchObject({
      mergeSeparator: '',
      convertToTimestamp: false,
      contentFilterSelectors: [],
      textPrefix: '',
      mergeValues: [
        {
          id: 'legacy-page',
          convertToTimestamp: false,
          contentFilterSelectors: [],
          textPrefix: ''
        }
      ]
    })
  })

  it('normalizes content filters independently for a field and merge child', () => {
    const value = mapping()
    value.contentFilterSelectors = [' h1 ', '.share', 'h1']
    const child = createMergeValue('body')
    child.contentFilterSelectors = [' font ', '#advertisement', 'font']
    value.mergeValues = [child]

    expect(normalizeFieldMappingConfig(value)).toMatchObject({
      contentFilterSelectors: ['h1', '.share'],
      mergeValues: [
        { id: 'body', contentFilterSelectors: ['font', '#advertisement'] }
      ]
    })
  })
})
