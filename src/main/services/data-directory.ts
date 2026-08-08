import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  join,
  posix,
  resolve as resolveHostPath,
  win32
} from 'node:path'

const LEGACY_DATA_ENTRIES = new Set(['settings.json', 'tasks', 'checkpoints', 'manifests'])

export interface DataDirectoryContext {
  isPackaged: boolean
  platform: NodeJS.Platform
  appPath: string
  executablePath: string
  legacyRootDirectory: string
}

export interface DataDirectoryResult {
  rootDirectory: string
  preferredRootDirectory: string
  legacyRootDirectory: string
  migrated: boolean
  usingFallback: boolean
  warning: string
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const comparablePath = (path: string): string => {
  const resolved = resolveHostPath(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const listDirectory = async (path: string): Promise<string[]> => {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

const hasLegacyData = async (path: string): Promise<boolean> =>
  (await listDirectory(path)).some((entry) => LEGACY_DATA_ENTRIES.has(entry))

const ensureWritableDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
  const probe = join(path, `.tapcollect-write-${randomUUID()}.tmp`)
  try {
    await writeFile(probe, '', { flag: 'wx' })
  } finally {
    await rm(probe, { force: true })
  }
}

const migrateLegacyData = async (
  preferredRootDirectory: string,
  legacyRootDirectory: string
): Promise<void> => {
  const stagingDirectory = join(
    dirname(preferredRootDirectory),
    `.${basename(preferredRootDirectory)}-migration-${randomUUID()}`
  )
  try {
    await cp(legacyRootDirectory, stagingDirectory, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true
    })
    await rmdir(preferredRootDirectory)
    await rename(stagingDirectory, preferredRootDirectory)
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
    await mkdir(preferredRootDirectory, { recursive: true }).catch(() => undefined)
    throw error
  }
}

export const resolvePreferredDataDirectory = ({
  isPackaged,
  platform,
  appPath,
  executablePath
}: Omit<DataDirectoryContext, 'legacyRootDirectory'>): string => {
  const pathApi = platform === 'win32' ? win32 : posix
  if (!isPackaged) return pathApi.join(appPath, 'data')
  if (platform !== 'darwin') return pathApi.join(pathApi.dirname(executablePath), 'data')

  const bundleDirectory = pathApi.resolve(pathApi.dirname(executablePath), '..', '..')
  return pathApi.join(pathApi.dirname(bundleDirectory), 'data')
}

export const initializeDataDirectory = async (
  preferredRootDirectory: string,
  legacyRootDirectory: string
): Promise<DataDirectoryResult> => {
  if (comparablePath(preferredRootDirectory) === comparablePath(legacyRootDirectory)) {
    await ensureWritableDirectory(preferredRootDirectory)
    return {
      rootDirectory: preferredRootDirectory,
      preferredRootDirectory,
      legacyRootDirectory,
      migrated: false,
      usingFallback: false,
      warning: ''
    }
  }

  try {
    await ensureWritableDirectory(preferredRootDirectory)
    let migrated = false
    if (
      (await listDirectory(preferredRootDirectory)).length === 0 &&
      (await hasLegacyData(legacyRootDirectory))
    ) {
      await migrateLegacyData(preferredRootDirectory, legacyRootDirectory)
      await ensureWritableDirectory(preferredRootDirectory)
      migrated = true
    }
    return {
      rootDirectory: preferredRootDirectory,
      preferredRootDirectory,
      legacyRootDirectory,
      migrated,
      usingFallback: false,
      warning: ''
    }
  } catch (error) {
    await ensureWritableDirectory(legacyRootDirectory)
    return {
      rootDirectory: legacyRootDirectory,
      preferredRootDirectory,
      legacyRootDirectory,
      migrated: false,
      usingFallback: true,
      warning: `无法使用应用同级 data 目录“${preferredRootDirectory}”，已继续使用原数据目录“${legacyRootDirectory}”：${errorMessage(error)}`
    }
  }
}

export const prepareDataDirectory = async (
  context: DataDirectoryContext
): Promise<DataDirectoryResult> =>
  initializeDataDirectory(resolvePreferredDataDirectory(context), context.legacyRootDirectory)
