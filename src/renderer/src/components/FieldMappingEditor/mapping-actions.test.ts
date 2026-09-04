import { describe, expect, it } from 'vitest'
import { createFieldMapping } from '@shared/defaults'
import { setAllMappingsEmpty } from './mapping-actions'

const createMapping = (fieldPath: string) =>
  createFieldMapping({
    path: fieldPath,
    name: fieldPath,
    kind: 'element',
    cdata: false,
    sampleValue: ''
  })

describe('field mapping batch actions', () => {
  it('sets every mapping to empty without clearing its existing configuration', () => {
    const pageMapping = createMapping('title')
    pageMapping.mode = 'page'
    pageMapping.selector = '.title'

    const fixedMapping = createMapping('source')
    fixedMapping.mode = 'fixed'
    fixedMapping.fixedValue = '官网'

    setAllMappingsEmpty([pageMapping, fixedMapping])

    expect(pageMapping).toMatchObject({ mode: 'empty', selector: '.title' })
    expect(fixedMapping).toMatchObject({ mode: 'empty', fixedValue: '官网' })
  })
})

