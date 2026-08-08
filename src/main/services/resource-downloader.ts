import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { RequestConfig, ResourcePlan } from '@shared/types'
import { HttpClient, HttpRequestError } from '@main/core/http-client'

export interface ResourceDownloadResult {
  kind: 'downloaded' | 'skipped'
  path: string
  retries: number
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    const information = await stat(path)
    if (!information.isFile()) throw new Error(`资源目标已存在但不是文件：${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const publishFile = async (
  temporary: string,
  target: string,
  overwrite: boolean
): Promise<boolean> => {
  try {
    await rename(temporary, target)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (!overwrite && ['EEXIST', 'EPERM'].includes(code) && (await pathExists(target))) {
      return false
    }
    throw error
  }
}

export class ResourceDownloader {
  constructor(private readonly httpClient: Pick<HttpClient, 'fetchResource'>) {}

  async download(
    plan: ResourcePlan,
    request: RequestConfig,
    overwrite: boolean
  ): Promise<ResourceDownloadResult> {
    if (!overwrite && (await pathExists(plan.localPath))) {
      return { kind: 'skipped', path: plan.localPath, retries: 0 }
    }

    await mkdir(dirname(plan.localPath), { recursive: true })
    const temporary = `${plan.localPath}.${randomUUID()}.tmp`
    try {
      const response = await this.httpClient.fetchResource(
        plan.sourceUrl,
        request,
        new URL(plan.sourceUrl).hostname
      )
      if (response.kind === 'external-redirect') {
        throw new HttpRequestError(
          `资源重定向到站外地址：${response.finalUrl}`,
          plan.sourceUrl,
          response.status,
          response.retries
        )
      }
      if (response.kind === 'not-found') {
        throw new HttpRequestError(
          `资源返回 ${response.status}`,
          plan.sourceUrl,
          response.status,
          response.retries
        )
      }

      if (response.response.body) {
        await pipeline(
          Readable.fromWeb(response.response.body as unknown as NodeReadableStream),
          createWriteStream(temporary, { flags: 'wx' })
        )
      } else {
        await writeFile(temporary, Buffer.alloc(0), { flag: 'wx' })
      }

      const published = await publishFile(temporary, plan.localPath, overwrite)
      if (!published) {
        await rm(temporary, { force: true })
        return { kind: 'skipped', path: plan.localPath, retries: response.retries }
      }
      return { kind: 'downloaded', path: plan.localPath, retries: response.retries }
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}
