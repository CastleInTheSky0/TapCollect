import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, WebContentsView } from 'electron'
import { configureXmlRecord } from '@main/core/xml-template'
import type { TaskStore } from '@main/services/task-store'
import type { RunManager } from '@main/services/run-manager'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export const verifyTaskGroups = async (
  window: BrowserWindow, store: TaskStore, runManager: RunManager, previewUrl: string, outputRoot: string
): Promise<boolean> => {
  const captureRoot = process.env.TAPCOLLECT_SMOKE_ARTIFACTS
  if (captureRoot) await mkdir(captureRoot, { recursive: true })
  const js = async <T = unknown>(source: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(source, true) as T }
    catch (error) { throw new Error(`Renderer script: ${source}\n${String(error)}`) }
  }
  const until = async (predicate: () => Promise<unknown> | unknown, label: string): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      if (await predicate()) return
      await wait(50)
    }
    throw new Error(`等待失败：${label}`)
  }
  const click = async (selector: string, text?: string): Promise<void> => {
    await js(`(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find(element =>
        element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden' &&
        (${JSON.stringify(text ?? '')} === '' || element.textContent.trim() === ${JSON.stringify(text ?? '')}));
      if (!target) throw new Error(${JSON.stringify(`找不到控件 ${selector} ${text ?? ''}`)});
      target.click();
    })()`)
    await wait(300)
  }
  const input = async (selector: string, value: string): Promise<void> => {
    await js(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('找不到输入框');
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await wait(50)
  }
  const capture = async (name: string): Promise<void> => {
    if (!captureRoot) return
    try {
      await js(`document.querySelectorAll('.t-message__close').forEach(element => element.click())`)
      await wait(250)
      await writeFile(join(captureRoot, `${name}.png`), (await window.capturePage()).toPNG())
    } catch (error) {
      await writeFile(join(captureRoot, `${name}-capture-error.txt`), String(error), 'utf8')
    }
  }
  const dialogButton = (label: string): Promise<void> => click('.task-group-dialog button', label)
  const groupMenu = (name: string): Promise<void> => click(`button[aria-label="${name}的分组菜单"]`)
  const taskMenu = async (id: string): Promise<void> => {
    await until(() => js(`Boolean(document.querySelector('[data-task-id="${id}"] .task-row-main:not(:disabled)'))`), '任务行就绪')
    await click(`[data-task-id="${id}"] .task-actions button`)
    await until(() => js(`Array.from(document.querySelectorAll('.task-actions-dropdown .t-dropdown__item')).some(element =>
      element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden')`), '任务操作菜单展开')
  }
  const menuAction = (label: string): Promise<void> => click('.t-dropdown__item', label)
  const breadcrumb = (): Promise<string> => js(`document.querySelector('.workspace-breadcrumb')?.textContent.replace(/\\s/g, '')`)
  const taskName = (): Promise<string> => js(`document.querySelector('input[placeholder="例如：图片新闻"]')?.value`)
  let stage = 'start'
  const wasVisible = window.isVisible()
  try {
    if (captureRoot) window.showInactive()
    window.setContentSize(1500, 920)
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    await until(() => js(`Boolean(document.querySelector('button[aria-label="新建分组"]'))`), '侧栏就绪')
    assert.equal((await store.groups.read()).groups.length, 0)
    stage = 'create-and-rename'
    await click('button[aria-label="新建分组"]')
    await input('.task-group-dialog input', '网站 A')
    await dialogButton('创建分组')
    await until(async () => (await store.groups.read()).groups.length === 1, '创建分组')
    await groupMenu('网站 A')
    await menuAction('重命名分组')
    await input('.task-group-dialog input', '市政府门户网站')
    await js(`document.querySelector('.task-group-dialog input').focus()`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await until(async () => (await store.groups.read()).groups[0]?.name === '市政府门户网站', '回车保存分组名称')
    const first = (await store.groups.read()).groups[0]!
    assert.equal(first.name, '市政府门户网站')
    const longName = '政务信息专题与公共服务'.repeat(3).slice(0, 40)
    await click('button[aria-label="新建分组"]')
    await input('.task-group-dialog input', longName)
    await dialogButton('创建分组')
    const second = (await store.groups.read()).groups[1]!
    assert(second)
    await groupMenu(first.name)
    await menuAction('在此组新建任务')
    assert(await js(`Array.from(document.querySelectorAll('.task-group-dialog input')).some(input => input.value === '市政府门户网站')`))
    await input('.task-group-dialog input', '分组采集')
    await dialogButton('创建任务')
    await until(() => js(`Boolean(document.querySelector('input[placeholder="例如：图片新闻"]'))`), '新任务草稿')
    await input('textarea[placeholder*="包含 {page} 的模板"]', previewUrl)
    await click('.workspace-header button', '保存草稿')
    await until(async () => (await store.listTasks()).some(task => task.name === '分组采集'), '分组内保存')
    const task = (await store.listTasks()).find(task => task.name === '分组采集')!
    assert.equal((await store.groups.read()).memberships[task.id], first.id)
    assert.equal(await breadcrumb(), `任务配置>${first.name}`)

    stage = 'task-actions-and-copy'
    await taskMenu(task.id)
    const labels = await js<string[]>(`[...document.querySelectorAll('.task-actions-dropdown .t-dropdown__item')].filter(e => e.getBoundingClientRect().height).map(e => e.textContent.trim())`)
    assert.deepEqual(labels, ['移动到分组', '运行任务', '复制任务', '删除任务'])
    await capture('task-menu')
    await menuAction('复制任务')
    await until(async () => (await store.listTasks()).length === 2, '复制任务')
    const copy = (await store.listTasks()).find(item => item.id !== task.id)!
    assert.equal((await store.groups.read()).memberships[copy.id], first.id)
    await click(`[data-task-id="${task.id}"] .task-row-main`)
    await input('input[placeholder="例如：图片新闻"]', '未保存草稿')
    const taskPath = join(store.rootDirectory, 'tasks', task.id, 'task.json')
    const originalBytes = await readFile(taskPath, 'utf8')
    await click('button', '打开预览')
    await until(() => window.contentView.children.some(child => child instanceof WebContentsView && child.webContents.getURL() === previewUrl && child.getBounds().width > 100), '原生网页预览')
    const previewView = window.contentView.children.find(child => child instanceof WebContentsView && child.webContents.getURL() === previewUrl) as WebContentsView
    await capture('grouped-workspace')

    stage = 'move-with-draft-and-preview'
    await taskMenu(task.id)
    await menuAction('移动到分组')
    await until(() => previewView.getBounds().width <= 1 || previewView.getBounds().x < 0, '分组弹窗隐藏预览')
    await capture('move-dialog')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await until(() => previewView.getBounds().width > 100 && previewView.getBounds().x >= 0, 'Esc 关闭弹窗并恢复预览')
    assert.equal((await store.groups.read()).memberships[task.id], first.id)
    await taskMenu(task.id)
    await menuAction('移动到分组')
    await click('.group-destination', '不分组')
    await dialogButton('确认移动')
    await until(async () => !(await store.groups.read()).memberships[task.id], '移回任务根列表')
    await until(() => previewView.getBounds().width > 100 && previewView.getBounds().x >= 0, '关闭弹窗恢复预览')
    assert.equal(await breadcrumb(), '任务配置')
    assert.equal(await taskName(), '未保存草稿')
    assert.equal(await readFile(taskPath, 'utf8'), originalBytes)
    assert.equal(previewView.webContents.getURL(), previewUrl)
    assert(await js(`document.querySelector('.workspace-header').textContent.includes('有未保存修改')`))
    await taskMenu(task.id)
    await menuAction('运行任务')
    assert.equal((await js<{ items: unknown[] }>('window.collector.getRunSession()')).items.length, 0)
    assert(await js(`document.body.textContent.includes('保存')`))

    stage = 'batch-and-group-deletion'
    await click('button[aria-label="任务配置工具"]')
    await menuAction('批量整理')
    await click(`[data-task-id="${task.id}"] input[type="checkbox"]`)
    await click(`[data-task-id="${copy.id}"] input[type="checkbox"]`)
    await click('.task-batch-toolbar button', '移动到分组')
    await js(`([...document.querySelectorAll('.group-destination')].find(e => e.textContent.includes(${JSON.stringify(second.name)}))).click()`)
    await wait(50)
    await dialogButton('确认移动')
    await until(async () => Object.values((await store.groups.read()).memberships).filter(id => id === second.id).length === 2, '批量移动')
    assert.equal(await taskName(), '未保存草稿')
    await click('.task-batch-toolbar button', '完成')
    await groupMenu(second.name)
    await menuAction('删除分组')
    await capture('delete-group-dialog')
    await dialogButton('删除分组')
    await until(async () => (await store.groups.read()).groups.length === 1, '删除非空分组')
    assert.equal((await store.listTasks()).length, 2)
    assert.equal(await breadcrumb(), '任务配置')
    assert.equal(await taskName(), '未保存草稿')
    assert.equal(await readFile(taskPath, 'utf8'), originalBytes)
    await taskMenu(copy.id)
    await menuAction('删除任务')
    await click('.dialog-actions button', '删除任务')
    await until(async () => (await store.listTasks()).length === 1, '删除任务菜单')

    stage = 'minimum-width-and-collapsed-navigation'
    window.setContentSize(1180, 720)
    await wait(250)
    assert(await js(`document.documentElement.scrollWidth <= innerWidth`))
    await capture('groups-1180')
    await click('button[aria-label="收起侧边栏"]')
    await capture('collapsed-sidebar')
    const hoverPoint = await js<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('.tasks-submenu > .t-menu__item').getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint })
    await wait(350)
    await until(() => js(`Array.from(document.querySelectorAll('.task-sidebar-popup')).some(e =>
      e.getBoundingClientRect().height > 0 && e.textContent.includes('导入任务配置') && e.textContent.includes('批量整理'))`), '折叠侧栏工具浮层')
    await capture('collapsed-task-popup')
    await click('.task-sidebar-popup .task-row-main')
    await click('button[aria-label="打开侧边栏"]')
    await click(`[data-task-id="${task.id}"] .task-row-main`)
    assert.equal(await taskName(), '未保存草稿')

    stage = 'running-task-move'
    const runnable = (await store.loadTask(task.id))!
    runnable.name = '本地运行验证'
    runnable.output.rootDirectory = outputRoot
    runnable.listPageRules = [previewUrl, `${previewUrl}?page=2`, `${previewUrl}?page=3`]
    runnable.listItem.selector = '#preview-smoke-list li'
    runnable.detail.enabled = false
    runnable.request.delayMs = 2000
    runnable.request.detailConcurrency = 1
    runnable.xml = configureXmlRecord('<root><item><title/></item></root>', 'test.xml', '/root/item')
    runnable.xml.mappings[0]!.mode = 'page'
    runnable.xml.mappings[0]!.pageSource = 'list'
    runnable.xml.mappings[0]!.selector = 'a'
    runnable.dedupeFieldPath = runnable.xml.fields[0]!.path
    await store.saveTask(runnable)
    await js('window.collector.previewClose()')
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    await until(() => js(`Boolean(document.querySelector('[data-task-id="${task.id}"]'))`), '运行验证任务加载')
    await taskMenu(task.id)
    await menuAction('运行任务')
    await until(async () => (await js<{ items: { taskId: string; status: string }[] }>('window.collector.getRunSession()')).items.some(item => item.taskId === task.id && ['preparing', 'running'].includes(item.status)), '菜单启动采集')
    const beforeRun = await js<{ items: { taskId: string; runId: string; status: string }[] }>('window.collector.getRunSession()')
    const runningBytes = await readFile(taskPath, 'utf8')
    stage = 'running-menu-locks'
    await taskMenu(task.id)
    assert(await js(`([...document.querySelectorAll('.task-actions-dropdown .t-dropdown__item')].find(e => e.textContent.trim() === '删除任务')).classList.contains('t-dropdown__item--disabled')`))
    await menuAction('移动到分组')
    stage = 'move-running-task'
    await js(`([...document.querySelectorAll('.group-destination')].find(e => e.textContent.includes(${JSON.stringify(first.name)}))).click()`)
    await wait(50)
    await dialogButton('确认移动')
    assert.equal((await store.groups.read()).memberships[task.id], first.id)
    const afterRun = await js<{ items: { taskId: string; runId: string }[] }>('window.collector.getRunSession()')
    assert.equal(afterRun.items.find(item => item.taskId === task.id)?.runId, beforeRun.items.find(item => item.taskId === task.id)?.runId)
    assert.equal(await readFile(taskPath, 'utf8'), runningBytes)
    stage = 'pause-and-resume-label'
    await js(`window.collector.pauseRun(${JSON.stringify(task.id)})`)
    await until(async () => (await js<{ items: { taskId: string; status: string }[] }>('window.collector.getRunSession()')).items.some(item => item.taskId === task.id && item.status === 'paused'), '任务暂停')
    await taskMenu(task.id)
    assert(await js(`document.querySelector('.task-actions-dropdown').textContent.includes('继续任务')`))
    await capture('paused-task-menu')
    await menuAction('继续任务')
    await until(async () => (await js<{ items: { taskId: string; runId: string; status: string }[] }>('window.collector.getRunSession()')).items.some(item =>
      item.taskId === task.id && item.runId === beforeRun.items.find(entry => entry.taskId === task.id)?.runId && ['preparing', 'running'].includes(item.status)), '菜单继续原有采集')
    await js(`window.collector.cancelRun(${JSON.stringify(task.id)})`)
    await until(async () => (await js<{ items: { taskId: string; status: string }[] }>('window.collector.getRunSession()')).items.every(item => item.taskId !== task.id || !['preparing', 'running', 'pausing', 'paused'].includes(item.status)), '清理测试运行')
    await runManager.deleteTask(task.id)
    await store.groups.remove(first.id, null)
    assert.deepEqual(await store.groups.read(), { version: 1, groups: [], memberships: {} })
    return true
  } catch (error) {
    await capture('group-smoke-failure')
    if (captureRoot) await writeFile(join(captureRoot, 'failure.txt'), `${stage}\n${String(error)}\n${await js('document.body.innerText')}`, 'utf8')
    throw new Error(`任务分组冒烟（${stage}）：${error instanceof Error ? error.stack : String(error)}`)
  } finally {
    if (!wasVisible && window.isVisible()) window.hide()
  }
}
