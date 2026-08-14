import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  AppPlatform,
  AppRuntimeInfo,
  DownloadedUpdate,
  UpdateAsset,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateRelease
} from '@shared/types'

const GITHUB_OWNER = 'CastleInTheSky0'
const GITHUB_REPOSITORY = 'TapCollect'
const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases`
const LATEST_RELEASE_API =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/latest`
const RELEASE_DOWNLOAD_PREFIX =
  `https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases/download/`
const RELEASE_SUMMARY_LIMIT = 600
const UPDATE_EVENT = 'download-progress'

type UpdateFetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface UpdateServiceOptions {
  appName: string
  version: string
  platform: NodeJS.Platform
  architecture: string
  developmentPreview: boolean
  temporaryDirectory: string
  fetcher: UpdateFetcher
  openPath: (path: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
}

interface GitHubAsset {
  id: number
  name: string
  size: number
  digest: string
  downloadUrl: string
}

interface GitHubRelease {
  id: number
  version: string
  tagName: string
  title: string
  body: string
  releaseUrl: string
  publishedAt: string
  assets: GitHubAsset[]
}

interface CheckedRelease {
  result: UpdateCheckResult
  asset: GitHubAsset | null
}

interface VerifiedDownload {
  info: DownloadedUpdate
  path: string
  digest: string
}

interface VersionIdentifier {
  numeric: number[]
  prerelease: string[]
}

const readString = (value: unknown): string => (typeof value === 'string' ? value : '')

const readFiniteNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const isTrustedReleaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith(`/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases`)
    )
  } catch {
    return false
  }
}

const isTrustedDownloadUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.href.startsWith(RELEASE_DOWNLOAD_PREFIX)
    )
  } catch {
    return false
  }
}

const versionIdentifier = (value: string): VersionIdentifier => {
  const normalized = value.trim().replace(/^v/i, '').split('+', 1)[0] ?? ''
  const prereleaseSeparator = normalized.indexOf('-')
  const numericPart = prereleaseSeparator < 0
    ? normalized
    : normalized.slice(0, prereleaseSeparator)
  const prereleasePart = prereleaseSeparator < 0
    ? ''
    : normalized.slice(prereleaseSeparator + 1)
  const numericTokens = numericPart.split('.')
  if (
    numericTokens.length === 0 ||
    numericTokens.some((token) => !/^\d+$/.test(token))
  ) {
    throw new Error(`无法识别版本号：${value}`)
  }
  return {
    numeric: numericTokens.map(Number),
    prerelease: prereleasePart ? prereleasePart.split('.') : []
  }
}

export const normalizeVersion = (value: string): string =>
  value.trim().replace(/^v/i, '').split('+', 1)[0] ?? ''

export const compareVersions = (left: string, right: string): number => {
  const leftVersion = versionIdentifier(left)
  const rightVersion = versionIdentifier(right)
  const numericLength = Math.max(leftVersion.numeric.length, rightVersion.numeric.length)
  for (let index = 0; index < numericLength; index += 1) {
    const difference = (leftVersion.numeric[index] ?? 0) - (rightVersion.numeric[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) return 0
  if (leftVersion.prerelease.length === 0) return 1
  if (rightVersion.prerelease.length === 0) return -1
  const prereleaseLength = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length
  )
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftToken = leftVersion.prerelease[index]
    const rightToken = rightVersion.prerelease[index]
    if (leftToken === undefined) return -1
    if (rightToken === undefined) return 1
    if (leftToken === rightToken) continue
    const leftNumeric = /^\d+$/.test(leftToken)
    const rightNumeric = /^\d+$/.test(rightToken)
    if (leftNumeric && rightNumeric) return Number(leftToken) > Number(rightToken) ? 1 : -1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftToken.localeCompare(rightToken, 'en-US') > 0 ? 1 : -1
  }
  return 0
}

export const resolveAppPlatform = (platform: NodeJS.Platform): AppPlatform => {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  return 'unsupported'
}

export const platformLabel = (platform: AppPlatform): string => ({
  windows: 'Windows',
  macos: 'macOS',
  linux: 'UOS / Linux',
  unsupported: '暂不支持的系统'
})[platform]

export const architectureLabel = (architecture: string): string => ({
  x64: 'x64（Intel / AMD 64 位）',
  arm64: 'ARM64'
})[architecture] ?? architecture.toUpperCase()

export const supportsUpdatePackage = (
  platform: AppPlatform,
  architecture: string
): boolean =>
  (platform === 'windows' && architecture === 'x64') ||
  (platform === 'linux' && architecture === 'arm64') ||
  (platform === 'macos' && ['x64', 'arm64'].includes(architecture))

export const createAppRuntimeInfo = (
  options: Pick<
    UpdateServiceOptions,
    'appName' | 'version' | 'platform' | 'architecture' | 'developmentPreview'
  >
): AppRuntimeInfo => {
  const platform = resolveAppPlatform(options.platform)
  return {
    appName: options.appName,
    version: options.version,
    platform,
    platformLabel: platformLabel(platform),
    architecture: options.architecture,
    architectureLabel: architectureLabel(options.architecture),
    developmentPreview: options.developmentPreview,
    updateInstallSupported:
      !options.developmentPreview && supportsUpdatePackage(platform, options.architecture)
  }
}

const architecturePattern = (architecture: string): RegExp =>
  new RegExp(`(?:^|[-_.])${architecture.replace(/[^a-z0-9]/gi, '')}(?:[-_.]|$)`, 'i')

export const selectReleaseAsset = (
  assets: readonly GitHubAsset[],
  platform: AppPlatform,
  architecture: string
): GitHubAsset | null => {
  const architectureToken = architecturePattern(architecture)
  return assets.find((asset) => {
    const name = asset.name.toLowerCase()
    if (!name.startsWith('tapcollect-') || !architectureToken.test(name)) return false
    if (platform === 'windows' && architecture === 'x64') return name.endsWith('.exe')
    if (platform === 'linux' && architecture === 'arm64') return name.endsWith('.deb')
    if (platform === 'macos' && ['x64', 'arm64'].includes(architecture)) {
      return name.endsWith('.dmg') && name.includes('mac-')
    }
    return false
  }) ?? null
}

const decodeMarkdownEntities = (value: string): string => value
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/gi, "'")

export const cleanReleaseSummary = (
  body: string,
  limit = RELEASE_SUMMARY_LIMIT
): { summary: string; hasSummary: boolean; truncated: boolean } => {
  const meaningfulLines = body
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (/^(?:\*\*)?full changelog(?:\*\*)?\s*:\s*https?:\/\/\S+$/i.test(trimmed)) {
        return false
      }
      return !/^https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/\S+$/i.test(trimmed)
    })

  const plainText = decodeMarkdownEntities(meaningfulLines.join('\n'))
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s|\d+\.\s)\s*/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!plainText) return { summary: '', hasSummary: false, truncated: false }
  const codePoints = [...plainText]
  if (codePoints.length <= limit) {
    return { summary: plainText, hasSummary: true, truncated: false }
  }
  return {
    summary: `${codePoints.slice(0, Math.max(1, limit - 1)).join('').trimEnd()}…`,
    hasSummary: true,
    truncated: true
  }
}

const parseGitHubRelease = (value: unknown): GitHubRelease => {
  if (!value || typeof value !== 'object') throw new Error('GitHub 返回了无效的版本信息')
  const record = value as Record<string, unknown>
  const tagName = readString(record.tag_name)
  const releaseUrl = readString(record.html_url)
  if (!tagName || !isTrustedReleaseUrl(releaseUrl)) {
    throw new Error('GitHub 版本信息缺少可信的版本号或页面地址')
  }
  const rawAssets = Array.isArray(record.assets) ? record.assets : []
  const assets = rawAssets.flatMap((entry): GitHubAsset[] => {
    if (!entry || typeof entry !== 'object') return []
    const asset = entry as Record<string, unknown>
    const id = readFiniteNumber(asset.id)
    const name = readString(asset.name)
    const size = readFiniteNumber(asset.size)
    const downloadUrl = readString(asset.browser_download_url)
    if (
      id <= 0 ||
      !name ||
      size <= 0 ||
      !isTrustedDownloadUrl(downloadUrl)
    ) return []
    return [{
      id,
      name,
      size,
      digest: readString(asset.digest),
      downloadUrl
    }]
  })
  return {
    id: readFiniteNumber(record.id),
    version: normalizeVersion(tagName),
    tagName,
    title: readString(record.name) || `TapCollect ${tagName}`,
    body: readString(record.body),
    releaseUrl,
    publishedAt: readString(record.published_at),
    assets
  }
}

const publicAsset = (asset: GitHubAsset | null): UpdateAsset | null => asset ? {
  id: asset.id,
  name: asset.name,
  size: asset.size,
  digest: asset.digest
} : null

const sha256Digest = (digest: string): string =>
  /^sha256:[a-f0-9]{64}$/i.test(digest) ? digest.slice('sha256:'.length).toLowerCase() : ''

const hashFile = async (path: string): Promise<string> => new Promise<string>((resolve, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.once('error', reject)
  stream.once('end', () => resolve(hash.digest('hex')))
})

const writeCompleteChunk = async (
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  position: number
): Promise<void> => {
  let offset = 0
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, position + offset)
    if (result.bytesWritten <= 0) throw new Error('写入更新安装包失败')
    offset += result.bytesWritten
  }
}

const safeDownloadName = (value: string): string => {
  const name = [...basename(value)]
    .map((character) =>
      character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character
    )
    .join('')
  if (!name || name === '.' || name === '..') throw new Error('更新安装包文件名无效')
  return name
}

const requestError = (response: Response): Error => {
  if (response.status === 403 || response.status === 429) {
    return new Error('GitHub 暂时限制了更新检查频率，请稍后再试')
  }
  return new Error(`检查更新失败：GitHub 返回 HTTP ${response.status}`)
}

export class UpdateService extends EventEmitter {
  private readonly runtimeInfo: AppRuntimeInfo
  private checkedRelease: CheckedRelease | null = null
  private activeDownload: Promise<DownloadedUpdate> | null = null
  private readonly downloads = new Map<string, VerifiedDownload>()

  constructor(private readonly options: UpdateServiceOptions) {
    super()
    this.runtimeInfo = createAppRuntimeInfo(options)
  }

  getRuntimeInfo(): AppRuntimeInfo {
    return { ...this.runtimeInfo }
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    let response: Response
    try {
      response = await this.options.fetcher(LATEST_RELEASE_API, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': `${this.options.appName}/${this.options.version}`
        }
      })
    } catch (error) {
      if (controller.signal.aborted) throw new Error('检查更新超时，请检查网络后重试')
      throw new Error(`无法连接 GitHub：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) throw requestError(response)

    let release: GitHubRelease
    try {
      release = parseGitHubRelease(await response.json() as unknown)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GitHub')) throw error
      throw new Error(`无法读取 GitHub 版本信息：${error instanceof Error ? error.message : String(error)}`)
    }
    const summary = cleanReleaseSummary(release.body)
    const asset = selectReleaseAsset(
      release.assets,
      this.runtimeInfo.platform,
      this.runtimeInfo.architecture
    )
    const isNewer = compareVersions(release.version, this.runtimeInfo.version) > 0
    const status: UpdateCheckResult['status'] = !isNewer
      ? 'up-to-date'
      : asset
        ? 'available'
        : 'unsupported'
    const publicRelease: UpdateRelease = {
      id: release.id,
      version: release.version,
      tagName: release.tagName,
      title: release.title,
      summary: summary.summary,
      hasSummary: summary.hasSummary,
      summaryTruncated: summary.truncated,
      releaseUrl: release.releaseUrl,
      publishedAt: release.publishedAt,
      asset: publicAsset(asset)
    }
    const message = status === 'up-to-date'
      ? `当前已是最新版本（${this.runtimeInfo.version}）`
      : status === 'available'
        ? `发现新版本 ${release.version}`
        : `发现新版本 ${release.version}，但没有适用于 ${this.runtimeInfo.platformLabel} ${this.runtimeInfo.architectureLabel} 的安装包`
    const result: UpdateCheckResult = {
      status,
      checkedAt: new Date().toISOString(),
      currentVersion: this.runtimeInfo.version,
      release: publicRelease,
      message
    }
    this.checkedRelease = { result, asset }
    return structuredClone(result)
  }

  async downloadUpdate(): Promise<DownloadedUpdate> {
    if (this.options.developmentPreview) {
      throw new Error('本地开发预览只检查更新，不下载或启动安装包')
    }
    if (!this.checkedRelease || this.checkedRelease.result.status !== 'available') {
      throw new Error('请先检查更新并确认有适用于当前设备的新版本')
    }
    const asset = this.checkedRelease.asset
    if (!asset) throw new Error('当前系统和架构没有可下载的安装包')
    const existing = [...this.downloads.values()].find((entry) =>
      entry.info.releaseVersion === this.checkedRelease?.result.release.version &&
      entry.info.fileName === asset.name
    )
    if (existing) {
      if (await this.isVerifiedDownloadAvailable(existing)) return { ...existing.info }
      this.downloads.delete(existing.info.downloadId)
    }
    if (this.activeDownload) return this.activeDownload

    const download = this.performDownload(asset, this.checkedRelease.result.release.version)
    this.activeDownload = download
    try {
      return await download
    } finally {
      if (this.activeDownload === download) this.activeDownload = null
    }
  }

  async installDownloaded(downloadId: string): Promise<void> {
    if (this.options.developmentPreview) {
      throw new Error('本地开发预览不能启动更新安装包')
    }
    const download = this.downloads.get(downloadId)
    if (!download) throw new Error('找不到已验证的更新安装包，请重新下载')
    if (!await this.isVerifiedDownloadAvailable(download)) {
      this.downloads.delete(downloadId)
      throw new Error('更新安装包已丢失或大小发生变化，请重新下载')
    }
    const error = await this.options.openPath(download.path)
    if (error) throw new Error(`无法启动更新安装包：${error}`)
  }

  async verifyDownloaded(downloadId: string): Promise<DownloadedUpdate> {
    const download = this.downloads.get(downloadId)
    if (!download || !await this.isVerifiedDownloadAvailable(download)) {
      if (download) this.downloads.delete(downloadId)
      throw new Error('更新安装包已丢失或校验失败，请重新下载')
    }
    return { ...download.info }
  }

  getDownloadedUpdate(downloadId: string): DownloadedUpdate | null {
    const download = this.downloads.get(downloadId)
    return download ? { ...download.info } : null
  }

  async openReleasePage(): Promise<boolean> {
    const url = this.checkedRelease?.result.release.releaseUrl || RELEASES_URL
    await this.options.openExternal(url)
    return true
  }

  onDownloadProgress(listener: (progress: UpdateDownloadProgress) => void): () => void {
    this.on(UPDATE_EVENT, listener)
    return () => this.off(UPDATE_EVENT, listener)
  }

  private async performDownload(
    asset: GitHubAsset,
    releaseVersion: string
  ): Promise<DownloadedUpdate> {
    const directory = join(this.options.temporaryDirectory, 'TapCollect-updates')
    await mkdir(directory, { recursive: true })
    const fileName = safeDownloadName(asset.name)
    const downloadId = randomUUID()
    const finalPath = join(directory, `${downloadId}-${fileName}`)
    const temporaryPath = `${finalPath}.part`
    let fileHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      const response = await this.options.fetcher(asset.downloadUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': `${this.options.appName}/${this.options.version}` }
      })
      if (response.status !== 200) throw new Error(`下载更新失败：HTTP ${response.status}`)
      if (!response.body) throw new Error('下载更新失败：响应中没有文件内容')
      const responseLength = Number(response.headers.get('content-length') || 0)
      if (responseLength > 0 && responseLength !== asset.size) {
        throw new Error(`更新安装包大小不一致：应为 ${asset.size} 字节，响应为 ${responseLength} 字节`)
      }

      fileHandle = await open(temporaryPath, 'wx')
      const reader = response.body.getReader()
      const hash = createHash('sha256')
      let receivedBytes = 0
      let lastProgressAt = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        if (receivedBytes + value.byteLength > asset.size) {
          throw new Error('更新安装包实际内容超过 GitHub 标注大小')
        }
        await writeCompleteChunk(fileHandle, value, receivedBytes)
        hash.update(value)
        receivedBytes += value.byteLength
        const now = Date.now()
        if (now - lastProgressAt >= 100 || receivedBytes === asset.size) {
          this.emitProgress(asset, receivedBytes)
          lastProgressAt = now
        }
      }
      if (receivedBytes !== asset.size) {
        throw new Error(`更新安装包下载不完整：应为 ${asset.size} 字节，实际 ${receivedBytes} 字节`)
      }
      const expectedDigest = sha256Digest(asset.digest)
      const actualDigest = hash.digest('hex')
      if (expectedDigest && actualDigest !== expectedDigest) {
        throw new Error('更新安装包 SHA-256 校验失败，请重新下载')
      }
      await fileHandle.sync()
      await fileHandle.close()
      fileHandle = null
      await rename(temporaryPath, finalPath)
      this.emitProgress(asset, receivedBytes)
      const info: DownloadedUpdate = {
        downloadId,
        releaseVersion,
        fileName,
        size: receivedBytes,
        digestVerified: Boolean(expectedDigest)
      }
      this.downloads.set(downloadId, { info, path: finalPath, digest: asset.digest })
      return { ...info }
    } catch (error) {
      await fileHandle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      await rm(finalPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private emitProgress(asset: GitHubAsset, receivedBytes: number): void {
    const progress: UpdateDownloadProgress = {
      assetId: asset.id,
      fileName: asset.name,
      receivedBytes,
      totalBytes: asset.size,
      percentage: Math.min(100, Math.round((receivedBytes / asset.size) * 100))
    }
    this.emit(UPDATE_EVENT, progress)
  }

  private async isVerifiedDownloadAvailable(download: VerifiedDownload): Promise<boolean> {
    const fileInfo = await stat(download.path).catch(() => null)
    if (!fileInfo?.isFile() || fileInfo.size !== download.info.size) return false
    const expectedDigest = sha256Digest(download.digest)
    return !expectedDigest || await hashFile(download.path) === expectedDigest
  }
}
