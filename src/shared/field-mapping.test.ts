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
    const raw = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>
    delete raw.mergeSeparator
    delete raw.mergeValues

    expect(normalizeFieldMappingConfig(raw as unknown as typeof legacy)).toMatchObject({
      mergeSeparator: '',
      mergeValues: []
    })
  })
})
