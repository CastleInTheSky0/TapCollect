import type { FieldMapping } from '@shared/types'

export const setAllMappingsEmpty = (mappings: FieldMapping[]): void => {
  for (const mapping of mappings) mapping.mode = 'empty'
}

