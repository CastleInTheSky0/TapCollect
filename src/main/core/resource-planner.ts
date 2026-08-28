import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { normalizeResourceUrlPrefix } from '@shared/resource-config'
import type { ResourceKind, ResourcePlan } from '@shared/types'
import { hasSameHostname, resolveHttpUrl, sanitizeFileName } from './url-utils'

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp'
])
const AUDIO_EXTENSIONS = new Set([
  '.aac', '.flac', '.m4a', '.mid', '.midi', '.mp3', '.ogg', '.opus', '.wav', '.wma'
])
const VIDEO_EXTENSIONS = new Set([
  '.3gp', '.avi', '.flv', '.m2ts', '.m3u8', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg',
  '.mpg', '.mts', '.ogv', '.rm', '.rmvb', '.ts', '.webm', '.wmv'
])
const ATTACHMENT_EXTENSIONS = new Set([
  '.7z', '.apk', '.bz2', '.csv', '.dmg', '.doc', '.docm', '.docx', '.dot', '.dotx',
  '.epub', '.exe', '.gz', '.iso', '.json', '.msi', '.odf', '.odg', '.odp', '.ods',
  '.odt', '.pdf', '.pkg', '.ppt', '.pptm', '.pptx', '.rar', '.rtf', '.tar', '.txt',
  '.xls', '.xlsb', '.xlsm', '.xlsx', '.xml', '.xz', '.zip'
])

export interface ResourceReferenceContext {
  tagName: string
  parentTagName?: string
  attributeName: string
  hasDownloadAttribute?: boolean
  customAttribute?: boolean
  styleUrl?: boolean
}

export interface ResourceMirrorPath {
  normalizedUrl: string
  sourceUrl: string
  relativePath: string
  encodedPath: string
}

const extensionFromUrl = (value: string): string => {
  try {
    const pathname = new URL(value).pathname.toLowerCase()
    const fileName = pathname.split('/').at(-1) ?? ''
    const dotIndex = fileName.lastIndexOf('.')
    return dotIndex > 0 ? fileName.slice(dotIndex) : ''
  } catch {
    return ''
  }
}

const kindFromExtension = (extension: string): ResourceKind | null => {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (ATTACHMENT_EXTENSIONS.has(extension)) return 'attachment'
  return null
}

export const classifyResourceReference = (
  absoluteUrl: string,
  context: ResourceReferenceContext
): ResourceKind | null => {
  const tagName = context.tagName.toLowerCase()
  const parentTagName = context.parentTagName?.toLowerCase() ?? ''
  const attributeName = context.attributeName.toLowerCase()
  const extensionKind = kindFromExtension(extensionFromUrl(absoluteUrl))

  if (context.styleUrl) return extensionKind ?? 'other'
  if (attributeName === 'poster') return 'image'
  if (tagName === 'img' || tagName === 'image' || parentTagName === 'picture') return 'image'
  if (tagName === 'audio' || parentTagName === 'audio') return 'audio'
  if (tagName === 'video' || parentTagName === 'video') return 'video'
  if (tagName === 'source') return extensionKind ?? 'other'
  if (attributeName === 'href') {
    if (context.hasDownloadAttribute) return extensionKind ?? 'attachment'
    return extensionKind
  }
  if (context.customAttribute || ['data-src', 'data-original'].includes(attributeName)) {
    return extensionKind ?? 'other'
  }
  return extensionKind
}

const safeDecodeSegment = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const formatResourcePath = (value: string, encodeUrls: boolean): string => {
  if (!encodeUrls) {
    try {
      return decodeURI(value)
    } catch {
      return value
    }
  }
  return value
    .split('/')
    .map((segment) => encodeURIComponent(safeDecodeSegment(segment)))
    .join('/')
}

const formattedAbsoluteResourceUrl = (
  url: URL,
  encodeUrls: boolean,
  protocolRelative: boolean
): string => {
  const authentication =
    url.username || url.password
      ? `${url.username}${url.password ? `:${url.password}` : ''}@`
      : ''
  const authority = `${authentication}${url.host}`
  const protocol = protocolRelative ? '//' : `${url.protocol}//`
  return `${protocol}${authority}${formatResourcePath(url.pathname, encodeUrls)}${url.search}${url.hash}`
}

export const formatResourceReferenceUrl = (value: string, encodeUrls: boolean): string => {
  try {
    if (/^https?:\/\//i.test(value)) {
      return formattedAbsoluteResourceUrl(new URL(value), encodeUrls, false)
    }
    if (value.startsWith('//')) {
      return formattedAbsoluteResourceUrl(new URL(`https:${value}`), encodeUrls, true)
    }
  } catch {
    return value
  }

  const queryIndex = value.indexOf('?')
  const hashIndex = value.indexOf('#')
  const suffixIndex = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), value.length)
  return `${formatResourcePath(value.slice(0, suffixIndex), encodeUrls)}${value.slice(suffixIndex)}`
}

const sanitizeResourceSegment = (value: string): string => {
  const decoded = safeDecodeSegment(value)
  if (!decoded || decoded === '.' || decoded === '..') return '_'
  const sanitized = sanitizeFileName(decoded)
  return sanitized === '未命名任务' ? 'resource' : sanitized
}

const canonicalResourceUrl = (value: string): string => {
  const url = new URL(value)
  url.hash = ''
  const compare = (left: string, right: string): number =>
    left === right ? 0 : left < right ? -1 : 1
  const entries = Array.from(url.searchParams.entries()).sort(
    ([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = compare(leftKey, rightKey)
      return keyOrder === 0 ? compare(leftValue, rightValue) : keyOrder
    }
  )
  url.search = ''
  for (const [key, entryValue] of entries) url.searchParams.append(key, entryValue)
  return url.toString()
}

const withQueryHash = (fileName: string, normalizedUrl: string): string => {
  const search = new URL(normalizedUrl).search
  if (!search) return fileName
  const hash = createHash('sha256').update(search).digest('hex').slice(0, 8)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex > 0
    ? `${fileName.slice(0, dotIndex)}__${hash}${fileName.slice(dotIndex)}`
    : `${fileName}__${hash}`
}

export const buildResourceMirrorPath = (
  absoluteUrl: string,
  includeQueryHash: boolean
): ResourceMirrorPath => {
  const source = new URL(absoluteUrl)
  source.hash = ''
  const normalizedUrl = canonicalResourceUrl(source.toString())
  const segments = source.pathname
    .split('/')
    .filter(Boolean)
    .map(sanitizeResourceSegment)
  if (segments.length === 0 || source.pathname.endsWith('/')) segments.push('resource')
  if (includeQueryHash) {
    const lastIndex = segments.length - 1
    segments[lastIndex] = withQueryHash(segments[lastIndex]!, normalizedUrl)
  }
  return {
    normalizedUrl,
    sourceUrl: source.toString(),
    relativePath: segments.join('/'),
    encodedPath: formatResourcePath(segments.join('/'), true)
  }
}

export const joinResourcePrefix = (prefix: string, encodedPath: string): string => {
  const normalizedPrefix = normalizeResourceUrlPrefix(prefix)
  if (normalizedPrefix === '/') return `/${encodedPath}`
  return `${normalizedPrefix}/${encodedPath}`
}

export const rewriteInternalResourceWithPrefix = (
  absoluteUrl: string,
  ownerPageUrl: string,
  prefix: string,
  encodeUrls = false
): string => {
  if (!hasSameHostname(ownerPageUrl, absoluteUrl)) return absoluteUrl
  const pathname = new URL(absoluteUrl).pathname.replace(/^\/+/, '')
  return joinResourcePrefix(prefix, formatResourcePath(pathname, encodeUrls))
}

export const createResourcePlan = (
  sourceValue: string,
  resolutionBaseUrl: string,
  ownerPageUrl: string,
  rootDirectory: string,
  urlPrefix: string,
  kind: ResourceKind,
  encodeUrls = false
): ResourcePlan | null => {
  const absoluteUrl = resolveHttpUrl(sourceValue, resolutionBaseUrl)
  if (!absoluteUrl || !hasSameHostname(ownerPageUrl, absoluteUrl)) return null
  const mirror = buildResourceMirrorPath(absoluteUrl, true)
  const root = resolve(rootDirectory)
  const localPath = resolve(root, ...mirror.relativePath.split('/'))
  const relativeTarget = relative(root, localPath)
  if (
    !relativeTarget ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`资源路径超出存放目录：${absoluteUrl}`)
  }
  return {
    normalizedUrl: mirror.normalizedUrl,
    sourceUrl: mirror.sourceUrl,
    sourcePageUrl: ownerPageUrl,
    relativePath: mirror.relativePath,
    localPath,
    xmlUrl: joinResourcePrefix(urlPrefix, formatResourcePath(mirror.encodedPath, encodeUrls)),
    kind
  }
}
