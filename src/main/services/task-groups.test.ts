import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyCounters, createEmptyResourceCounters, createTask } from '@shared/defaults'
import { createTaskConfigBundle, parseTaskConfigBundleWithGroups } from '@shared/task-config-bundle'
import { emptyTaskGroups, parseTaskGroups, taskGroupFor } from '@shared/task-groups'
import { TaskStore } from './task-store'

const roots: string[] = []
const setup = async (): Promise<TaskStore> => {
  const root = await mkdtemp(join(tmpdir(), 'tapcollect-group-test-'))
  roots.push(root)
  return new TaskStore(root)
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('task group storage', () => {
  it('does not create grouping metadata or rewrite legacy tasks on initialization or restart', async () => {
    const store = await setup()
    await store.initialize()
    expect(await store.groups.read()).toEqual(emptyTaskGroups())
    expect(await readdir(store.rootDirectory)).not.toContain('task-groups.json')
    await store.saveTask(createTask('legacy'))
    const path = join(store.rootDirectory, 'tasks/legacy/task.json')
    const before = await readFile(path, 'utf8')
    const summaries = await store.listTasks()
    const restarted = new TaskStore(store.rootDirectory)
    expect(await restarted.groups.read()).toEqual(emptyTaskGroups())
    expect(await restarted.listTasks()).toEqual(summaries)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await readdir(store.rootDirectory)).not.toContain('task-groups.json')
  })

  it('trims names, rejects normalized duplicates, retains empty groups and never recreates deleted groups', async () => {
    const store = await setup()
    const { groups: [group] } = await store.groups.create('  Ｎｅｗｓ  ')
    expect(group!.name).toBe('Ｎｅｗｓ')
    await expect(store.groups.create('news')).rejects.toThrow('同名')
    await expect(store.groups.create('  ')).rejects.toThrow('请输入')
    await expect(store.groups.create('名'.repeat(41))).rejects.toThrow('40')
    await expect(store.groups.create('门户\n网站')).rejects.toThrow('控制字符')
    expect((await new TaskStore(store.rootDirectory).groups.read()).groups).toEqual([group])
    await store.groups.rename(group!.id, '市政府门户')
    expect((await store.groups.read()).groups[0]?.name).toBe('市政府门户')
    await store.groups.remove(group!.id, null)
    expect(await new TaskStore(store.rootDirectory).groups.read()).toEqual(emptyTaskGroups())
  })

  it('moves batches and deletes groups without changing task bytes, timestamps, checkpoints or outputs', async () => {
    const store = await setup()
    const tasks = await Promise.all(['a', 'b'].map(id => store.saveTask(createTask(id))))
    await store.groups.create('门户')
    const { groups: [first, second] } = await store.groups.create('专题')
    const output = join(store.rootDirectory, 'sample-output.xml')
    await writeFile(output, '<kept/>')
    await store.saveOutputManifest('a', [output])
    await store.saveCheckpoint({
      version: 1, taskId: 'a', runId: 'run-1', startedAt: '2026-09-10T00:00:00.000Z',
      runStamp: '20260910_080000', nextRuleIndex: 0, nextPage: 2, templatePagesVisited: 1,
      nextSequence: 1, nextFileIndex: 1, pagesVisited: 1, seenPageUrls: [], seenKeys: [],
      pendingRecords: [], outputFiles: [output], errorLogPath: '', counters: createEmptyCounters(),
      resources: createEmptyResourceCounters(), processedResourceUrls: []
    })
    const checkpoint = join(store.rootDirectory, 'checkpoints/a/checkpoint.json')
    const paths = [...tasks.map(task => join(store.rootDirectory, 'tasks', task.id, 'task.json')),
      checkpoint, join(store.rootDirectory, 'checkpoints/a/pending.ndjson'), output, join(store.rootDirectory, 'manifests/a.json')]
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')))
    await store.moveTasksToGroup(['a', 'b', 'a'], first!.id)
    expect((await store.groups.read()).memberships).toEqual({ a: first!.id, b: first!.id })
    await store.groups.remove(first!.id, second!.id)
    expect((await store.groups.read()).memberships).toEqual({ a: second!.id, b: second!.id })
    await store.groups.remove(second!.id, null)
    expect(await store.groups.read()).toEqual(emptyTaskGroups())
    expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before)
    expect(await store.listTaskConfigs()).toEqual([...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  })

  it('serializes concurrent creates, moves, renames and task deletion without losing unrelated membership', async () => {
    const store = await setup()
    await store.saveTask(createTask('a'))
    await store.saveTask(createTask('b'))
    await Promise.all([store.groups.create('第一组'), store.groups.create('第二组')])
    const { groups: [a, b] } = await store.groups.read()
    await Promise.all([store.moveTasksToGroup(['a'], a!.id), store.moveTasksToGroup(['b'], b!.id), store.groups.rename(a!.id, '新名称')])
    expect((await store.groups.read()).memberships).toEqual({ a: a!.id, b: b!.id })
    expect((await store.groups.read()).groups[0]?.name).toBe('新名称')
    await Promise.all([store.deleteTask('a'), store.moveTasksToGroup(['b'], a!.id)])
    expect((await store.groups.read()).memberships).toEqual({ b: a!.id })
    expect(await store.loadTask('a')).toBeNull()
  })

  it('rejects an invalid batch or missing destination before publishing any membership', async () => {
    const store = await setup()
    await store.saveTask(createTask('a'))
    const { groups: [group] } = await store.groups.create('有效分组')
    const previous = await store.groups.read()
    await expect(store.moveTasksToGroup(['a', 'missing'], group!.id)).rejects.toThrow('找不到任务')
    await expect(store.moveTasksToGroup(['a'], 'missing')).rejects.toThrow('分组已不存在')
    await expect(store.groups.remove(group!.id, group!.id)).rejects.toThrow('请选择其他分组')
    expect(await store.groups.read()).toEqual(previous)
  })

  it('saves new tasks and copies with membership, while missing groups fall back to ungrouped', async () => {
    const store = await setup()
    const { groups: [group] } = await store.groups.create('门户')
    const created = await store.saveNewTask(createTask('a'), group!.id)
    expect(created.warning).toBe('')
    const copy = await store.duplicateTask('a')
    expect(copy.warning).toBe('')
    expect(copy.task.id).not.toBe('a')
    expect(taskGroupFor(await store.groups.read(), copy.task.id)?.id).toBe(group!.id)
    expect((await store.saveNewTask(createTask('b'), 'deleted-group')).warning).toContain('原分组已不存在')
    expect(await store.loadTask('b')).not.toBeNull()
    expect(taskGroupFor(await store.groups.read(), 'b')).toBeUndefined()
    await expect(store.saveNewTask(createTask('a'), null)).rejects.toThrow('任务已存在')
  })

  it('retains the persisted organization on failure and reports saved tasks and copies as ungrouped', async () => {
    const store = await setup()
    const { groups: [group] } = await store.groups.create('门户')
    await store.saveNewTask(createTask('a'), group!.id)
    const previous = await store.groups.read()
    vi.spyOn(store.groups, 'persist').mockRejectedValue(new Error('disk full'))
    await expect(store.groups.rename(group!.id, '新名称')).rejects.toThrow('disk full')
    await expect(store.moveTasksToGroup(['a'], null)).rejects.toThrow('disk full')
    await expect(store.groups.remove(group!.id, null)).rejects.toThrow('disk full')
    await expect(store.deleteTask('a')).rejects.toThrow('disk full')
    const created = await store.saveNewTask(createTask('b'), group!.id)
    const copy = await store.duplicateTask('a')
    expect(created.warning).toContain('分组保存失败')
    expect(copy.warning).toContain('分组保存失败')
    expect(await store.loadTask(created.task.id)).not.toBeNull()
    expect(await store.loadTask(copy.task.id)).not.toBeNull()
    expect(await store.groups.read()).toEqual(previous)
    expect(await store.loadTask('a')).not.toBeNull()
  })

  it('keeps malformed metadata intact, leaves tasks accessible, and treats dangling references as ungrouped', async () => {
    const store = await setup()
    await store.saveTask(createTask('a'))
    const path = join(store.rootDirectory, 'task-groups.json')
    await writeFile(path, 'malformed')
    await expect(store.groups.create('门户')).rejects.toThrow('无法读取任务分组')
    expect(await readFile(path, 'utf8')).toBe('malformed')
    expect(await store.loadTask('a')).not.toBeNull()
    const parsed = parseTaskGroups({ version: 1, groups: [{ id: 'g', name: '组' }], memberships: { a: 'gone' } })
    expect(taskGroupFor(parsed, 'a')).toBeUndefined()
  })

  it('deleting a task removes its membership but preserves empty groups and generated files', async () => {
    const store = await setup()
    const { groups: [group] } = await store.groups.create('门户')
    await store.saveNewTask(createTask('a'), group!.id)
    const output = join(store.rootDirectory, 'generated.xml')
    await writeFile(output, '<preserved/>')
    await store.saveOutputManifest('a', [output])
    await store.deleteTask('a')
    expect(await readFile(output, 'utf8')).toBe('<preserved/>')
    expect(await store.groups.read()).toEqual({ version: 1, groups: [group], memberships: {} })
  })
})

describe('grouped task transfer', () => {
  it('imports legacy bundles ungrouped with new IDs and credential sanitization', async () => {
    const store = await setup()
    const task = createTask('old-id')
    task.request.headers = [{ id: 'secret', key: 'Cookie', value: 'session=secret' }]
    const result = await store.importTaskConfigs(parseTaskConfigBundleWithGroups({
      format: 'tapcollect-task-bundle', version: 1, tasks: [task]
    }))
    expect(result.imported).toHaveLength(1)
    expect(result.imported[0]!.id).not.toBe(task.id)
    expect((await store.loadTask(result.imported[0]!.id))!.request.headers).toEqual([])
    expect(await store.groups.read()).toEqual(emptyTaskGroups())
  })

  it('round-trips empty groups, reuses normalized names, and maps valid entries by index even when source IDs repeat', async () => {
    const store = await setup()
    const { groups: [local] } = await store.groups.create('NEWS')
    const task = createTask('same-source-id')
    const source = { version: 1 as const, groups: [{ id: 'remote', name: 'ｎｅｗｓ' }, { id: 'empty', name: '空组' }], memberships: { [task.id]: 'remote' } }
    const bundle = createTaskConfigBundle([task, task, task], undefined, source)
    const parsed = parseTaskConfigBundleWithGroups({ ...bundle, tasks: [task, { name: 'invalid' }, task], taskGroupIds: ['remote', 'remote', 'missing'] })
    const result = await store.importTaskConfigs(parsed)
    expect(result.imported.map(entry => entry.sourceIndex)).toEqual([1, 3])
    expect(new Set(result.imported.map(entry => entry.id)).size).toBe(2)
    expect(result.skipped).toHaveLength(1)
    expect(result.warnings).toMatchObject([{ sourceIndex: 3, reason: expect.stringContaining('引用的分组不存在') }])
    const registry = await store.groups.read()
    expect(registry.groups.map(group => group.name)).toEqual(['NEWS', '空组'])
    expect(taskGroupFor(registry, result.imported[0]!.id)?.id).toBe(local!.id)
    expect(taskGroupFor(registry, result.imported[1]!.id)).toBeUndefined()
    const exported = createTaskConfigBundle(await store.listTaskConfigs(), undefined, registry)
    expect(exported.version).toBe(2)
    expect(exported.tasks.every(item => item.version === 1)).toBe(true)
    expect(parseTaskConfigBundleWithGroups(exported).groups).toEqual(registry.groups)
  })

  it('reports partial group-write failures without dropping valid imported tasks or changing existing groups', async () => {
    const store = await setup()
    await store.groups.create('原分组')
    const before = await store.groups.read()
    vi.spyOn(store.groups, 'persist').mockRejectedValue(new Error('disk full'))
    const result = await store.importTaskConfigs({ tasks: [createTask('source')], groups: [{ id: 'g', name: '导入分组' }], taskGroupIds: ['g'] })
    expect(result.imported).toHaveLength(1)
    expect(result.skipped).toEqual([])
    expect(result.warnings[0]?.reason).toContain('任务已导入，但分组保存失败')
    expect(await store.groups.read()).toEqual(before)
    expect(await store.loadTask(result.imported[0]!.id)).not.toBeNull()
  })
})
