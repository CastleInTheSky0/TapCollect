import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanReleaseSummary,
  compareVersions,
  createAppRuntimeInfo,
  selectReleaseAsset,
  UpdateService,
  type UpdateServiceOptions
} from './update-service'

const temporaryDirectories: string[] = []

const releaseResponse = (
  body: string,
  assets: Array<Record<string, unknown>>,
  tagName = 'v0.4.0'
): Response => new Response(JSON.stringify({
  id: 40,
  tag_name: tagName,
  name: `TapCollect ${tagName}`,
  body,
  html_url: `https://github.com/CastleInTheSky0/TapCollect/releases/tag/${tagName}`,
  published_at: '2026-08-13T00:00:00Z',
  assets
}), { status: 200, headers: { 'content-type': 'application/json' } })

const assetRecord = (name: string, bytes: Uint8Array, digest = ''): Record<string, unknown> => ({
  id: 101,
  name,
  size: bytes.byteLength,
  digest,
  browser_download_url:
    `https://github.com/CastleInTheSky0/TapCollect/releases/download/v0.4.0/${name}`
})

const createService = async (
  overrides: Partial<UpdateServiceOptions> = {}
): Promise<{ service: UpdateService; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'tapcollect-update-service-'))
  temporaryDirectories.push(root)
  const options: UpdateServiceOptions = {
    appName: 'TapCollect',
    version: '0.3.1',
    platform: 'win32',
    architecture: 'x64',
    developmentPreview: false,
    temporaryDirectory: root,
    fetcher: vi.fn(),
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => undefined),
    ...overrides
  }
  return { service: new UpdateService(options), root }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('update version and release helpers', () => {
  it('compares normal and prerelease semantic versions', () => {
    expect(compareVersions('v0.3.2', '0.3.1')).toBe(1)
    expect(compareVersions('0.3.1', '0.3.1.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
  })

  it('cleans generated Full Changelog-only bodies and bounds normal notes', () => {
    expect(cleanReleaseSummary(
      '**Full Changelog**: https://github.com/CastleInTheSky0/TapCollect/compare/v0.3.0...v0.3.1'
    )).toEqual({ summary: '', hasSummary: false, truncated: false })
    expect(cleanReleaseSummary('## 更新内容\n- 修复下载问题\n- [查看详情](https://example.com)', 10))
      .toEqual({ summary: '更新内容\n修复下载…', hasSummary: true, truncated: true })
  })

  it('maps runtime labels and selects only the exact platform package', () => {
    const assets = [
      { id: 1, name: 'TapCollect-0.4.0-mac-arm64.zip', size: 1, digest: '', downloadUrl: 'x' },
      { id: 2, name: 'TapCollect-0.4.0-mac-arm64.dmg', size: 1, digest: '', downloadUrl: 'x' },
      { id: 3, name: 'TapCollect-0.4.0-mac-x64.dmg', size: 1, digest: '', downloadUrl: 'x' },
      { id: 4, name: 'tapcollect-0.4.0-arm64.deb', size: 1, digest: '', downloadUrl: 'x' }
    ]
    expect(selectReleaseAsset(assets, 'macos', 'arm64')?.id).toBe(2)
    expect(selectReleaseAsset(assets, 'macos', 'x64')?.id).toBe(3)
    expect(selectReleaseAsset(assets, 'linux', 'arm64')?.id).toBe(4)
    expect(selectReleaseAsset(assets, 'windows', 'arm64')).toBeNull()
    expect(createAppRuntimeInfo({
      appName: 'TapCollect',
      version: '0.3.1',
      platform: 'linux',
      architecture: 'arm64',
      developmentPreview: false
    })).toMatchObject({
      platform: 'linux',
      platformLabel: 'UOS / Linux',
      architectureLabel: 'ARM64',
      updateInstallSupported: true
    })
  })
})

describe('UpdateService', () => {
  it('returns an unsupported result when a newer release has no matching asset', async () => {
    const bytes = new TextEncoder().encode('mac package')
    const fetcher = vi.fn(async () => releaseResponse('', [
      assetRecord('TapCollect-0.4.0-mac-arm64.dmg', bytes)
    ]))
    const { service } = await createService({ fetcher })

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      status: 'unsupported',
      currentVersion: '0.3.1',
      release: { version: '0.4.0', asset: null }
    })
  })

  it('shares a duplicate download, verifies its size and SHA-256, and can install it', async () => {
    const bytes = new TextEncoder().encode('verified installer')
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    let downloadRequests = 0
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return releaseResponse('## 更新\n- 支持在线更新', [
          assetRecord('TapCollect-0.4.0-x64.exe', bytes, digest)
        ])
      }
      downloadRequests += 1
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) }
      })
    })
    const openPath = vi.fn(async () => '')
    const { service } = await createService({ fetcher, openPath })
    const progress: number[] = []
    service.onDownloadProgress((event) => progress.push(event.percentage))

    await expect(service.checkForUpdates()).resolves.toMatchObject({ status: 'available' })
    const [first, duplicate] = await Promise.all([
      service.downloadUpdate(),
      service.downloadUpdate()
    ])

    expect(downloadRequests).toBe(1)
    expect(duplicate).toEqual(first)
    expect(first.digestVerified).toBe(true)
    expect(progress.at(-1)).toBe(100)
    await service.installDownloaded(first.downloadId)
    expect(openPath).toHaveBeenCalledOnce()
  })

  it('removes a partial file after byte-count or digest validation fails', async () => {
    const expected = new TextEncoder().encode('expected installer')
    const partial = expected.slice(0, 5)
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return releaseResponse('', [assetRecord('TapCollect-0.4.0-x64.exe', expected)])
      }
      return new Response(partial, { status: 200 })
    })
    const { service, root } = await createService({ fetcher })
    await service.checkForUpdates()

    await expect(service.downloadUpdate()).rejects.toThrow('下载不完整')
    await expect(readdir(join(root, 'TapCollect-updates'))).resolves.toEqual([])
  })

  it('removes a complete file when its SHA-256 digest does not match', async () => {
    const bytes = new TextEncoder().encode('untrusted installer')
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return releaseResponse('', [assetRecord(
          'TapCollect-0.4.0-x64.exe',
          bytes,
          `sha256:${'0'.repeat(64)}`
        )])
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) }
      })
    })
    const { service, root } = await createService({ fetcher })
    await service.checkForUpdates()

    await expect(service.downloadUpdate()).rejects.toThrow('SHA-256 校验失败')
    await expect(readdir(join(root, 'TapCollect-updates'))).resolves.toEqual([])
  })

  it('blocks download and installation in a development preview', async () => {
    const { service } = await createService({ developmentPreview: true })
    await expect(service.downloadUpdate()).rejects.toThrow('本地开发预览')
    await expect(service.installDownloaded('missing')).rejects.toThrow('本地开发预览')
  })

  it('rejects partial HTTP responses even when their declared asset size matches', async () => {
    const bytes = new TextEncoder().encode('partial response')
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return releaseResponse('', [assetRecord('TapCollect-0.4.0-x64.exe', bytes)])
      }
      return new Response(bytes, { status: 206 })
    })
    const { service } = await createService({ fetcher })
    await service.checkForUpdates()
    await expect(service.downloadUpdate()).rejects.toThrow('HTTP 206')
  })
})
