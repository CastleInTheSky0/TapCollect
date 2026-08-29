import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

export interface DataDirectoryContext {
  platform: NodeJS.Platform
  userDataDirectory: string
}

export interface DataDirectoryResult {
  rootDirectory: string
}

const ensureWritableDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
  const pathApi = process.platform === 'win32' ? win32 : posix
  const probe = pathApi.join(path, `.tapcollect-write-${randomUUID()}.tmp`)
  try {
    await writeFile(probe, '', { flag: 'wx' })
  } finally {
    await rm(probe, { force: true })
  }
}

export const resolveDataDirectory = ({
  platform,
  userDataDirectory
}: DataDirectoryContext): string => {
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.join(userDataDirectory, 'collector-data')
}

export const prepareDataDirectory = async (
  context: DataDirectoryContext
): Promise<DataDirectoryResult> => {
  const rootDirectory = resolveDataDirectory(context)
  await ensureWritableDirectory(rootDirectory)
  return { rootDirectory }
}
