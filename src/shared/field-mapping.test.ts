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
  it('requires a configured locator only for page values inside a merge', () => {
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

  it('requires both literal boundaries instead of a selector in marker mode', () => {
    const value = mapping()
    value.mode = 'page'
    value.selectorType = 'markers'
    value.selector = ''

    expect(isFieldMappingConfigured(value)).toBe(false)
    value.startMarker = '<main>'
    expect(isFieldMappingConfigured(value)).toBe(false)
    value.endMarker = '</main>'
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
    delete raw.startMarker
    delete raw.endMarker
    delete raw.includeMarkers
    const rawMergeValue = (raw.mergeValues as Array<Record<string, unknown>>)[0]!
    delete rawMergeValue.convertToTimestamp
    delete rawMergeValue.contentFilterSelectors
    delete rawMergeValue.textPrefix
    delete rawMergeValue.startMarker
    delete rawMergeValue.endMarker
    delete rawMergeValue.includeMarkers

    expect(normalizeFieldMappingConfig(raw as unknown as typeof legacy)).toMatchObject({
      mergeSeparator: '',
      convertToTimestamp: false,
      contentFilterSelectors: [],
      textPrefix: '',
      startMarker: '',
      endMarker: '',
      includeMarkers: false,
      mergeValues: [
        {
          id: 'legacy-page',
          convertToTimestamp: false,
          contentFilterSelectors: [],
          textPrefix: '',
          startMarker: '',
          endMarker: '',
          includeMarkers: false
        }
      ]
    })
  })

  it('preserves marker text exactly while normalizing its switch', () => {
    const value = mapping()
    value.selectorType = 'markers'
    value.startMarker = '  <div>\n'
    value.endMarker = '\n</div>  '
    value.includeMarkers = true

    expect(normalizeFieldMappingConfig(value)).toMatchObject({
      selectorType: 'markers',
      startMarker: '  <div>\n',
      endMarker: '\n</div>  ',
      includeMarkers: true
    })
  })

  it('normalizes unsupported marker attribute extraction to HTML for fields and merge children', () => {
    const value = mapping()
    value.selectorType = 'markers'
    value.extraction = 'attribute'
    const child = createMergeValue('marker-child')
    child.selectorType = 'markers'
    child.extraction = 'attribute'
    value.mergeValues = [child]

    expect(normalizeFieldMappingConfig(value)).toMatchObject({
      extraction: 'html',
      mergeValues: [{ id: 'marker-child', extraction: 'html' }]
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
