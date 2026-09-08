import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask } from '@shared/defaults'
import type { FetchResourceResult } from '@main/core/http-client'
import { HttpClient } from '@main/core/http-client'
import { AccessProtectionError } from '@main/core/access-errors'
import { AccessCoordinator } from './access-coordinator'
import type { ResourcePlan } from '@shared/types'
import { ResourceDownloader } from './resource-downloader'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

const planFor = (localPath: string): ResourcePlan => ({
  normalizedUrl: 'https://example.com/files/a.bin',
  sourceUrl: 'https://example.com/files/a.bin',
  relativePath: 'files/a.bin',
  localPath,
  xmlUrl: '/resources/files/a.bin',
  kind: 'attachment'
})

describe('resource downloader', () => {
  it.each(['text/html', 'application/msword'])('rejects a soft 404 served as %s without publishing it or replacing an existing file', async (contentType) => {
    const root = await mkdtemp(join(tmpdir(), 'collector-soft-404-'))
    temporaryDirectories.push(root)
    const target = join(root, 'file.doc')
    await writeFile(target, 'original-file')
    const fetcher = vi.fn(async () => new Response('<html><title>404错误提示</title><body>您访问的页面未找到</body></html>', { headers: { 'content-type': contentType } }))
    const downloader = new ResourceDownloader(new HttpClient(fetcher))
    await expect(downloader.download(planFor(target), createTask('task').request, true)).rejects.toMatchObject({ status: 200, retries: 0, message: '资源返回错误提示页面：404错误提示' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(await readFile(target, 'utf8')).toBe('original-file')
    expect(await readdir(root)).toEqual(['file.doc'])
  })

  it('retains access protection when a binary-labelled download is actually a verification page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resource-challenge-'))
    temporaryDirectories.push(root)
    const access = new AccessCoordinator('test-agent')
    const fetcher = vi.fn(async () => new Response('<html><title>安全验证</title><body><input name="captcha">请输入验证码</body></html>', { headers: { 'content-type': 'application/octet-stream' } }))
    const downloader = new ResourceDownloader(new HttpClient(fetcher, access))
    await expect(downloader.download(planFor(join(root, 'file.doc')), createTask('task').request, true)).rejects.toBeInstanceOf(AccessProtectionError)
    expect(await readdir(root)).toEqual([])
  })

  it('streams a resource through a temporary file and atomically publishes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resource-download-'))
    temporaryDirectories.push(root)
    const target = join(root, 'files', 'a.bin')
    const fetchResource = vi.fn(async (): Promise<FetchResourceResult> => ({
      kind: 'success',
      requestedUrl: 'https://example.com/files/a.bin',
      finalUrl: 'https://example.com/files/a.bin',
      status: 200,
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first-'))
            controller.enqueue(new TextEncoder().encode('second'))
            controller.close()
          }
        })
      ),
      retries: 1
    }))
    const downloader = new ResourceDownloader({ fetchResource })
    const result = await downloader.download(planFor(target), createTask('task').request, true)

    expect(result).toEqual({ kind: 'downloaded', path: target, retries: 1 })
    await expect(readFile(target, 'utf8')).resolves.toBe('first-second')
  })

  it('skips an existing target without issuing a request when overwrite is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resource-skip-'))
    temporaryDirectories.push(root)
    const target = join(root, 'a.bin')
    await writeFile(target, 'existing')
    const fetchResource = vi.fn()
    const downloader = new ResourceDownloader({ fetchResource })

    await expect(
      downloader.download(planFor(target), createTask('task').request, false)
    ).resolves.toEqual({ kind: 'skipped', path: target, retries: 0 })
    expect(fetchResource).not.toHaveBeenCalled()
    await expect(readFile(target, 'utf8')).resolves.toBe('existing')
  })

  it('replaces an existing file from the completed temporary download when overwrite is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resource-overwrite-'))
    temporaryDirectories.push(root)
    const target = join(root, 'a.bin')
    await writeFile(target, 'old-content')
    const fetchResource = vi.fn(async (): Promise<FetchResourceResult> => ({
      kind: 'success',
      requestedUrl: 'https://example.com/files/a.bin',
      finalUrl: 'https://example.com/files/a.bin',
      status: 200,
      response: new Response('new-content'),
      retries: 0
    }))
    const downloader = new ResourceDownloader({ fetchResource })

    await expect(
      downloader.download(planFor(target), createTask('task').request, true)
    ).resolves.toEqual({ kind: 'downloaded', path: target, retries: 0 })
    await expect(readFile(target, 'utf8')).resolves.toBe('new-content')
  })

  it('rejects an existing directory instead of treating it as a usable resource file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resource-directory-'))
    temporaryDirectories.push(root)
    const target = join(root, 'a.bin')
    await mkdir(target)
    const fetchResource = vi.fn()
    const downloader = new ResourceDownloader({ fetchResource })

    await expect(
      downloader.download(planFor(target), createTask('task').request, false)
    ).rejects.toThrow('资源目标已存在但不是文件')
    expect(fetchResource).not.toHaveBeenCalled()
  })

  it('does not keep a partial file when the resource request fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-resource-failure-'))
    temporaryDirectories.push(root)
    const target = join(root, 'a.bin')
    const fetchResource = vi.fn(async (): Promise<FetchResourceResult> => ({
      kind: 'external-redirect',
      requestedUrl: 'https://example.com/files/a.bin',
      finalUrl: 'https://cdn.example.com/files/a.bin',
      status: 302,
      retries: 0
    }))
    const downloader = new ResourceDownloader({ fetchResource })

    await expect(
      downloader.download(planFor(target), createTask('task').request, true)
    ).rejects.toThrow('资源重定向到站外地址')
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
