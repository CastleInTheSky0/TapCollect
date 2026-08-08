import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  initializeDataDirectory,
  resolvePreferredDataDirectory
} from './data-directory'

const temporaryRoots: string[] = []

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'tapcollect-data-directory-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolvePreferredDataDirectory', () => {
  it('uses the project data directory during development', () => {
    expect(
      resolvePreferredDataDirectory({
        isPackaged: false,
        platform: 'win32',
        appPath: 'D:\\workspace\\TapCollect',
        executablePath: 'D:\\workspace\\TapCollect\\node_modules\\electron\\electron.exe'
      })
    ).toBe('D:\\workspace\\TapCollect\\data')
  })

  it('uses the executable sibling directory for packaged Windows and Linux apps', () => {
    expect(
      resolvePreferredDataDirectory({
        isPackaged: true,
        platform: 'win32',
        appPath: 'C:\\Apps\\TapCollect\\resources\\app.asar',
        executablePath: 'C:\\Apps\\TapCollect\\TapCollect.exe'
      })
    ).toBe('C:\\Apps\\TapCollect\\data')
    expect(
      resolvePreferredDataDirectory({
        isPackaged: true,
        platform: 'linux',
        appPath: '/opt/TapCollect/resources/app.asar',
        executablePath: '/opt/TapCollect/tapcollect'
      })
    ).toBe('/opt/TapCollect/data')
  })

  it('keeps packaged macOS data outside and beside the app bundle', () => {
    const dataDirectory = resolvePreferredDataDirectory({
      isPackaged: true,
      platform: 'darwin',
      appPath: '/Applications/TapCollect.app/Contents/Resources/app.asar',
      executablePath: '/Applications/TapCollect.app/Contents/MacOS/TapCollect'
    })

    expect(dataDirectory).toBe('/Applications/data')
    expect(dataDirectory).not.toContain('TapCollect.app/Contents')
  })
})

describe('initializeDataDirectory', () => {
  it('creates and selects an empty preferred data directory', async () => {
    const root = await createTemporaryRoot()
    const preferred = join(root, 'app', 'data')
    const legacy = join(root, 'legacy', 'collector-data')

    const result = await initializeDataDirectory(preferred, legacy)

    expect(result).toMatchObject({
      rootDirectory: preferred,
      migrated: false,
      usingFallback: false,
      warning: ''
    })
  })

  it('migrates the complete legacy store without deleting the source', async () => {
    const root = await createTemporaryRoot()
    const preferred = join(root, 'app', 'data')
    const legacy = join(root, 'legacy', 'collector-data')
    await mkdir(join(legacy, 'tasks', 'task-1'), { recursive: true })
    await writeFile(join(legacy, 'settings.json'), '{"defaultOutputDirectory":"D:/output"}')
    await writeFile(join(legacy, 'tasks', 'task-1', 'task.json'), '{"id":"task-1"}')

    const result = await initializeDataDirectory(preferred, legacy)

    expect(result).toMatchObject({
      rootDirectory: preferred,
      migrated: true,
      usingFallback: false
    })
    await expect(readFile(join(preferred, 'settings.json'), 'utf8')).resolves.toContain('D:/output')
    await expect(readFile(join(preferred, 'tasks', 'task-1', 'task.json'), 'utf8')).resolves.toContain(
      'task-1'
    )
    await expect(readFile(join(legacy, 'tasks', 'task-1', 'task.json'), 'utf8')).resolves.toContain(
      'task-1'
    )
    await expect(readdir(join(root, 'app'))).resolves.toEqual(['data'])
  })

  it('uses one writable directory directly when preferred and legacy paths are the same', async () => {
    const root = await createTemporaryRoot()
    const shared = join(root, 'collector-data')
    await mkdir(shared, { recursive: true })
    await writeFile(join(shared, 'settings.json'), '{"defaultOutputDirectory":"shared"}')

    const result = await initializeDataDirectory(shared, shared)

    expect(result).toMatchObject({
      rootDirectory: shared,
      migrated: false,
      usingFallback: false,
      warning: ''
    })
    await expect(readFile(join(shared, 'settings.json'), 'utf8')).resolves.toContain('shared')
  })

  it('keeps an existing preferred store authoritative instead of merging legacy data', async () => {
    const root = await createTemporaryRoot()
    const preferred = join(root, 'app', 'data')
    const legacy = join(root, 'legacy', 'collector-data')
    await mkdir(preferred, { recursive: true })
    await mkdir(join(legacy, 'tasks', 'legacy-task'), { recursive: true })
    await writeFile(join(preferred, 'settings.json'), '{"defaultOutputDirectory":"preferred"}')
    await writeFile(join(legacy, 'tasks', 'legacy-task', 'task.json'), '{"id":"legacy-task"}')

    const result = await initializeDataDirectory(preferred, legacy)

    expect(result).toMatchObject({ migrated: false, usingFallback: false })
    await expect(readFile(join(preferred, 'settings.json'), 'utf8')).resolves.toContain('preferred')
    await expect(readFile(join(preferred, 'tasks', 'legacy-task', 'task.json'), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' }
    )
  })

  it('falls back to the legacy store when the preferred path cannot be a directory', async () => {
    const root = await createTemporaryRoot()
    const preferred = join(root, 'app-data-file')
    const legacy = join(root, 'legacy', 'collector-data')
    await writeFile(preferred, 'not a directory')

    const result = await initializeDataDirectory(preferred, legacy)

    expect(result).toMatchObject({
      rootDirectory: legacy,
      migrated: false,
      usingFallback: true
    })
    expect(result.warning).toContain('无法使用应用同级 data 目录')
  })
})
