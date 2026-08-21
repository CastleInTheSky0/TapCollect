export type TimestampConversionResult =
  | { ok: true; value: string }
  | { ok: false; reason: string }

export const timestampConversionFailureReason = (value: string, reason: string): string =>
  `日期转换失败；原始值：${value ? JSON.stringify(value) : '（空）'}；原因：${reason}`

const TEN_DIGIT_SECONDS = /^\d{10}$/
const THIRTEEN_DIGIT_MILLISECONDS = /^\d{13}$/
const DELIMITED_DATE =
  /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const CHINESE_DATE =
  /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const EXPLICIT_TIMEZONE_ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i
const SHANGHAI_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000

interface DateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

const invalidPartsReason = (parts: DateParts): string => {
  if (parts.year < 1000 || parts.year > 9999) return '年份超出支持范围'
  if (parts.month < 1 || parts.month > 12) return '月份无效'
  if (parts.day < 1 || parts.day > daysInMonth(parts.year, parts.month)) return '日期无效'
  if (parts.hour < 0 || parts.hour > 23) return '小时无效'
  if (parts.minute < 0 || parts.minute > 59) return '分钟无效'
  if (parts.second < 0 || parts.second > 59) return '秒数无效'
  return ''
}

const toParts = (captures: Array<string | undefined>): DateParts => ({
  year: Number(captures[0]),
  month: Number(captures[1]),
  day: Number(captures[2]),
  hour: Number(captures[3] ?? 0),
  minute: Number(captures[4] ?? 0),
  second: Number(captures[5] ?? 0)
})

const convertShanghaiDate = (parts: DateParts): TimestampConversionResult => {
  const invalidReason = invalidPartsReason(parts)
  if (invalidReason) return { ok: false, reason: invalidReason }
  const value =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    SHANGHAI_OFFSET_MILLISECONDS
  return { ok: true, value: String(value) }
}

const convertExplicitTimezoneIso = (
  input: string,
  match: RegExpMatchArray
): TimestampConversionResult => {
  const parts = toParts(match.slice(1, 7))
  const invalidReason = invalidPartsReason(parts)
  if (invalidReason) return { ok: false, reason: invalidReason }

  const timezone = match[7] ?? ''
  if (timezone !== 'Z' && timezone !== 'z') {
    const [offsetHour, offsetMinute] = timezone.slice(1).split(':').map(Number)
    if (
      offsetHour === undefined ||
      offsetMinute === undefined ||
      offsetHour > 23 ||
      offsetMinute > 59
    ) {
      return { ok: false, reason: '时区偏移无效' }
    }
  }

  const parsed = Date.parse(input)
  return Number.isFinite(parsed)
    ? { ok: true, value: String(parsed) }
    : { ok: false, reason: 'ISO 时间无法解析' }
}

export const convertDateToTimestamp = (input: string): TimestampConversionResult => {
  const value = input.trim()
  if (!value) return { ok: false, reason: '日期值为空' }
  if (THIRTEEN_DIGIT_MILLISECONDS.test(value)) return { ok: true, value }
  if (TEN_DIGIT_SECONDS.test(value)) return { ok: true, value: String(Number(value) * 1000) }

  const iso = value.match(EXPLICIT_TIMEZONE_ISO)
  if (iso) return convertExplicitTimezoneIso(value, iso)

  const delimited = value.match(DELIMITED_DATE)
  if (delimited) {
    return convertShanghaiDate(
      toParts([
        delimited[1],
        delimited[3],
        delimited[4],
        delimited[5],
        delimited[6],
        delimited[7]
      ])
    )
  }

  const chinese = value.match(CHINESE_DATE)
  if (chinese) return convertShanghaiDate(toParts(chinese.slice(1, 7)))
  return { ok: false, reason: '不支持的日期格式' }
}
