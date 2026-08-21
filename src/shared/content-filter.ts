export const CONTENT_FILTER_SELECTOR_PRESETS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'font',
  'script',
  'style',
  'iframe',
  'form',
  'button',
  'img',
  'video',
  'audio',
  'nav',
  'aside',
  'header',
  'footer'
] as const

export const normalizeContentFilterSelectors = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const selectors: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const selector = candidate.trim()
    if (!selector || seen.has(selector)) continue
    seen.add(selector)
    selectors.push(selector)
  }
  return selectors
}

export const splitContentFilterInput = (
  value: string
): { selectors: string[]; pending: string } => {
  const parts = value.split(',')
  if (parts.length === 1) return { selectors: [], pending: value }
  const pending = parts.pop() ?? ''
  return {
    selectors: normalizeContentFilterSelectors(parts),
    pending: pending.trimStart()
  }
}
