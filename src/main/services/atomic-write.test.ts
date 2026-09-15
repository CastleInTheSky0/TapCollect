import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { atomicWrite } from './task-store'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})
const roots: string[] = []
afterEach(async () => {
  vi.mocked(rename).mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('atomically replaces an existing file on this platform and cleans temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tapcollect-atomic-test-'))
  roots.push(root)
  const path = join(root, 'task-groups.json')
  await writeFile(path, 'old')
  await atomicWrite(path, 'new')
  expect(await readFile(path, 'utf8')).toBe('new')
  expect(await readdir(root)).toEqual(['task-groups.json'])
})

it.each(['EPERM', 'EEXIST', 'EACCES'])('preserves the old file when replacement fails with %s', async (code) => {
  const root = await mkdtemp(join(tmpdir(), 'tapcollect-atomic-test-'))
  roots.push(root)
  const path = join(root, 'task-groups.json')
  await writeFile(path, 'old')
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('replacement denied'), { code }))
  await expect(atomicWrite(path, 'new')).rejects.toThrow('replacement denied')
  expect(await readFile(path, 'utf8')).toBe('old')
  expect(await readdir(root)).toEqual(['task-groups.json'])
})
