import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDataDirectory, resolveDataDirectory } from './data-directory'

const temporaryRoots: string[] = []

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'tapcollect-data-directory-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveDataDirectory', () => {
  it('uses the Electron user-data directory on Windows', () => {
    expect(
      resolveDataDirectory({
        platform: 'win32',
        userDataDirectory: 'C:\\Users\\Example\\AppData\\Roaming\\TapCollect'
      })
    ).toBe('C:\\Users\\Example\\AppData\\Roaming\\TapCollect\\collector-data')
  })

  it('uses the Electron user-data directory on Linux/UOS and macOS', () => {
    expect(
      resolveDataDirectory({
        platform: 'linux',
        userDataDirectory: '/home/example/.config/TapCollect'
      })
    ).toBe('/home/example/.config/TapCollect/collector-data')
    expect(
      resolveDataDirectory({
        platform: 'darwin',
        userDataDirectory: '/Users/example/Library/Application Support/TapCollect'
      })
    ).toBe('/Users/example/Library/Application Support/TapCollect/collector-data')
  })
})

describe('prepareDataDirectory', () => {
  it('creates and selects a writable directory below Electron userData', async () => {
    const root = await createTemporaryRoot()
    const userDataDirectory = join(root, 'user-data')

    const result = await prepareDataDirectory({
      platform: process.platform,
      userDataDirectory
    })

    expect(result.rootDirectory).toBe(join(userDataDirectory, 'collector-data'))
    await expect(readdir(result.rootDirectory)).resolves.toEqual([])
  })

  it('does not read, migrate, or remove an application-sibling data directory', async () => {
    const root = await createTemporaryRoot()
    const applicationDataDirectory = join(root, 'app', 'data')
    const oldTaskPath = join(applicationDataDirectory, 'tasks', 'old-task', 'task.json')
    await mkdir(join(applicationDataDirectory, 'tasks', 'old-task'), { recursive: true })
    await writeFile(oldTaskPath, '{"id":"old-task"}')

    const result = await prepareDataDirectory({
      platform: process.platform,
      userDataDirectory: join(root, 'user-data')
    })

    await expect(readdir(result.rootDirectory)).resolves.toEqual([])
    await expect(readFile(oldTaskPath, 'utf8')).resolves.toBe('{"id":"old-task"}')
  })

  it('fails instead of falling back to the application directory when userData is invalid', async () => {
    const root = await createTemporaryRoot()
    const userDataDirectory = join(root, 'user-data-file')
    await writeFile(userDataDirectory, 'not a directory')

    await expect(
      prepareDataDirectory({ platform: process.platform, userDataDirectory })
    ).rejects.toMatchObject({ code: expect.stringMatching(/ENOTDIR|EEXIST/) })
  })
})
