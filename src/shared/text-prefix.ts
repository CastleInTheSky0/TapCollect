const normalizePrefix = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/[：:]\s*$/, '').trim() : ''

export const normalizeTextPrefix = (value: unknown): string => normalizePrefix(value)

/**
 * 识别“标签：值”形式的短标签。函数保持自包含，以便序列化到隔离预览页执行。
 */
export function detectTextPrefix(value: string): string {
  const source = String(value ?? '').trimStart()
  const separatorIndex = source.search(/[：:]/)
  if (separatorIndex < 1 || separatorIndex > 20) return ''

  const prefix = source.slice(0, separatorIndex).trim()
  const remainder = source.slice(separatorIndex + 1)
  const content = remainder.trim()
  if (
    !prefix ||
    !content ||
    /^\/\//.test(remainder) ||
    /^\d+$/.test(prefix) ||
    /[\r\n<>/\\]/.test(prefix)
  ) {
    return ''
  }
  return prefix
}

/**
 * 判断节点文字是否以指定“标签 + 中英文冒号”开头。函数保持自包含。
 */
export function textMatchesPrefix(value: string, textPrefix: string): boolean {
  const prefix = String(textPrefix ?? '').trim().replace(/[：:]\s*$/, '').trim()
  if (!prefix) return true

  const source = String(value ?? '')
  let index = source.indexOf(prefix)
  while (index >= 0) {
    const startsSegment = index === 0 || /\s/.test(source[index - 1] || '')
    const remainder = source.slice(index + prefix.length)
    if (startsSegment && /^\s*[：:](?!\/\/)/.test(remainder)) return true
    index = source.indexOf(prefix, index + 1)
  }
  return false
}

/**
 * 删除开头的“标签 + 冒号 + 空白”，不匹配时保留原值。函数保持自包含。
 */
export function stripTextPrefix(value: string, textPrefix: string): string {
  const prefix = String(textPrefix ?? '').trim().replace(/[：:]\s*$/, '').trim()
  if (!prefix) return value

  const source = String(value ?? '')
  let index = source.indexOf(prefix)
  while (index >= 0) {
    const startsSegment = index === 0 || /\s/.test(source[index - 1] || '')
    const remainder = source.slice(index + prefix.length)
    const separator = remainder.match(/^\s*[：:](?!\/\/)\s*/)?.[0]
    if (startsSegment && separator) {
      const content = remainder.slice(separator.length).trimStart()
      const nextField = content.match(
        /(?:\r?\n|[ \t]+)\s*([\p{L}_][\p{L}\p{N}_-]{0,19})\s*[：:](?!\/\/)/u
      )
      return (nextField?.index === undefined
        ? content
        : content.slice(0, nextField.index)
      ).trimEnd()
    }
    index = source.indexOf(prefix, index + 1)
  }
  return value
}
