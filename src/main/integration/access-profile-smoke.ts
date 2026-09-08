import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, net, type BrowserWindow } from 'electron'
import { createTask } from '@shared/defaults'
import type { AccessProfileInput } from '@shared/access-profile'
import { createTaskConfigBundle } from '@shared/task-config-bundle'
import { HttpClient } from '@main/core/http-client'
import { configureXmlRecord } from '@main/core/xml-template'
import { AccessProfileService } from '@main/services/access-profile-service'
import { AccessCoordinator } from '@main/services/access-coordinator'
import type { PreviewService } from '@main/services/preview-service'
import type { RunManager } from '@main/services/run-manager'
import { TaskStore } from '@main/services/task-store'
import { ElectronDynamicPageProvider } from '@main/services/dynamic-page-service'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const listen = (server: Server): Promise<string> => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))

/** Uses real Chromium cookies, session transport and renderer IPC; no remote site. */
export const verifyAccessProfiles = async (window: BrowserWindow, store: TaskStore, profiles: AccessProfileService, access: AccessCoordinator, manager: RunManager, preview: PreviewService): Promise<boolean> => {
  const seen: Array<{ origin: string; path: string; cookie: string; ua: string; language: string }> = []
  let otherOrigin = ''
  const site = (foreign: boolean) => createServer((request, response) => {
    seen.push({ origin: foreign ? 'foreign' : 'primary', path: request.url ?? '', cookie: request.headers.cookie ?? '', ua: request.headers['user-agent'] ?? '', language: request.headers['accept-language'] ?? '' })
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url === '/login') response.setHeader('set-cookie', 'session=profile-secret; Path=/; HttpOnly; SameSite=Lax')
    if (request.url === '/redirect') { response.writeHead(302, { location: `${otherOrigin}/echo` }); response.end(); return }
    const identity = request.headers.cookie?.includes('session=profile-secret') ? 'authorized' : 'anonymous'
    if (request.url === '/resource') { response.setHeader('content-type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); return }
    response.end(`<!doctype html><html><body><ul><li class="item"><span>${identity}</span><img src="/resource"><img src="${otherOrigin}/resource"></li></ul><button id="next" disabled>Next</button></body></html>`)
  })
  const foreign = site(true)
  const primary = site(false)
  otherOrigin = await listen(foreign)
  const origin = await listen(primary)
  const setting = { ...access.settings }
  access.configure({ ...setting, minIntervalMs: 0, jitterPercent: 0, maxRetries: 0, failureThreshold: 20 })
  const ids: string[] = []
  let stage = 'create profiles'
  let failed = false
  try {
    const makeProfile = async (name: string, userAgent: string): Promise<AccessProfileInput> => {
      const input = { id: '', name, origin, userAgent, language: 'en-US,en;q=0.9' }
      const value = await window.webContents.executeJavaScript(`window.collector.saveAccessProfile(${JSON.stringify(input)})`) as AccessProfileInput
      ids.push(value.id)
      return value
    }
    const first = await makeProfile('访问配置 A', 'Profile-A-UA')
    const second = await makeProfile('访问配置 B', 'Profile-B-UA')
    const task = createTask('access-profile-smoke')
    task.name = '访问配置验证'
    task.accessProfileId = first.id
    task.listUrl = `${origin}/list`
    task.listPageRules = [task.listUrl]
    task.listItem.selector = '.item'
    task.detail.enabled = false
    task.request.delayMs = 0
    task.output.rootDirectory = join(store.rootDirectory, 'profile-output')
    task.xml = configureXmlRecord('<root><record><title/></record></root>', 'fixture.xml', '/root/record')
    task.xml.mappings[0]!.mode = 'page'
    task.xml.mappings[0]!.pageSource = 'list'
    task.xml.mappings[0]!.selector = 'span'
    task.dedupeFieldPath = task.xml.mappings[0]!.fieldPath
    await store.saveTask(task)
    const bounds = { x: 0, y: 0, width: 500, height: 350 }
    await window.webContents.executeJavaScript(`window.collector.previewOpen(${JSON.stringify(origin + '/login')}, ${JSON.stringify(bounds)}, ${JSON.stringify(task)})`)
    stage = 'preview Cookie and static transport'
    const lease = await profiles.acquire(task)
    assert(lease)
    const storedCookies = await lease.session.cookies.get({ url: origin })
    assert(storedCookies.some(cookie => cookie.name === 'session' && cookie.httpOnly))
    const client = new HttpClient(net.fetch as typeof fetch, access)
    const get = (url: string) => access.withContext(task.id, undefined, () => client.fetchHtml(url, task.request), lease)
    const html = await get(task.listUrl)
    assert(html.kind === 'success' && html.html.includes('authorized'))
    stage = 'cross-origin redirect'
    const redirected = await get(`${origin}/redirect`)
    assert(redirected.kind === 'success' && redirected.html.includes('anonymous'))
    stage = 'resources and active profile lock'
    const resource = await access.withContext(task.id, undefined, () => client.fetchResource(`${origin}/resource`, task.request), lease)
    assert(resource.kind === 'success')
    await resource.response.arrayBuffer()
    await assert.rejects(profiles.save({ ...first, name: 'busy' }), /使用/)
    await assert.rejects(profiles.clearSession(first.id), /使用/)
    lease.release()
    stage = 'dynamic and test collection'
    const dynamic = new ElectronDynamicPageProvider(window, access, profiles)
    const dynamicTask = { ...task, pagination: { ...task.pagination, mode: 'click' as const, nextButton: { selectorType: 'css' as const, selector: '#next' } } }
    const page = await dynamic.create(dynamicTask)
    assert((await page.current()).html.includes('authorized'))
    await page.close()
    const test = await manager.testTask(task.id)
    assert.equal(test.records.length, 1)
    assert(test.xmlPreview.includes('authorized'))
    await manager.start(task.id, false)
    for (let index = 0; index < 200 && manager.getSessionSnapshot().items.find(item => item.taskId === task.id)?.status !== 'completed'; index++) await wait(20)
    const completed = manager.getSessionSnapshot().items.find(item => item.taskId === task.id)
    assert.equal(completed?.status, 'completed')
    assert.equal(completed.result?.counters.succeeded, 1)
    assert.equal(completed.result?.outputFiles.length, 1)
    assert((await readFile(completed.result.outputFiles[0]!, 'utf8')).includes('authorized'))
    stage = 'second profile and legacy isolation'
    const secondLease = await profiles.acquire({ ...task, accessProfileId: second.id })
    assert(secondLease)
    const isolated = await access.withContext('second', undefined, () => client.fetchHtml(task.listUrl, task.request), secondLease)
    assert(isolated.kind === 'success' && isolated.html.includes('anonymous'))
    secondLease.release()
    const legacy = await client.fetchHtml(task.listUrl, task.request)
    assert(legacy.kind === 'success' && legacy.html.includes('anonymous'))
    await preview.open(task.listUrl, bounds, { ...task, accessProfileId: second.id })
    assert((await preview.evaluate({ selectorType: 'css', selector: 'span', scopeSelector: '', ancestorAttribute: '' })).sample.includes('anonymous'))
    preview.close()
    await assert.rejects(profiles.acquire({ ...task, accessProfileId: 'f165c9a7-2cd4-4f6b-9ffb-8e7f6b3b75dd' }), /找不到/)
    await assert.rejects(profiles.acquire({ ...task, listPageRules: [`${otherOrigin}/list`] }), /不匹配/)
    await profiles.flush()
    stage = 'encrypted persistence'
    const summary = (await profiles.list()).find(item => item.id === first.id)
    assert(summary && summary.cookieCount >= 1)
    if (summary.storageStatus === 'encrypted') {
      const encrypted = await readFile(join(store.rootDirectory, 'access-credentials', `${first.id}.bin`))
      assert(!encrypted.includes(Buffer.from('profile-secret')))
      const restored = new AccessProfileService(store.rootDirectory, access)
      await restored.initialize()
      const restoredLease = await restored.acquire(task)
      assert(restoredLease)
      const restoredHtml = await access.withContext('restored', undefined, () => client.fetchHtml(task.listUrl, task.request), restoredLease)
      assert(restoredHtml.kind === 'success' && restoredHtml.html.includes('authorized'))
      restoredLease.release()
      await restored.flush()
    }
    stage = 'unreadable encrypted credentials'
    const damagedRoot = join(store.rootDirectory, 'damaged-profile-fixture')
    await mkdir(join(damagedRoot, 'access-credentials'), { recursive: true })
    await writeFile(join(damagedRoot, 'access-profiles.json'), JSON.stringify([first]))
    await writeFile(join(damagedRoot, 'access-credentials', `${first.id}.bin`), 'damaged-vault-fixture')
    const damaged = new AccessProfileService(damagedRoot, access)
    await damaged.initialize()
    assert.equal((await damaged.list())[0]?.storageStatus, 'unreadable')
    await assert.rejects(damaged.acquire(task), /加密 Cookie 无法读取/)
    await damaged.clearSession(first.id)
    const recovered = await damaged.acquire(task)
    assert(recovered)
    assert.equal((await recovered.session.cookies.get({})).length, 0)
    recovered.release()
    await damaged.flush()
    assert(!JSON.stringify(await profiles.list()).includes('profile-secret'))
    assert(!JSON.stringify(createTaskConfigBundle([task])).includes('profile-secret'))
    assert(!String(await readFile(join(store.rootDirectory, 'access-profiles.json'))).includes('profile-secret'))
    await assert.rejects(profiles.remove(first.id, async () => true), /解除绑定/)
    stage = 'edit, import and clear'
    await profiles.save({ ...first, name: '访问配置 A（已编辑）' })
    await assert.rejects(profiles.save({ ...first, origin: otherOrigin }), /来源不能修改/)
    await profiles.importCookies(second.id, JSON.stringify([{ name: 'session', value: 'profile-secret', httpOnly: true }]))
    const imported = await profiles.acquire({ ...task, accessProfileId: second.id })
    assert(imported)
    assert((await imported.session.cookies.get({ url: origin })).some(cookie => cookie.httpOnly))
    imported.release()
    await profiles.clearSession(first.id)
    const cleared = await profiles.acquire(task)
    assert(cleared)
    assert.equal((await cleared.session.cookies.get({})).length, 0)
    cleared.release()
    assert(seen.some(entry => entry.origin === 'primary' && entry.cookie.includes('profile-secret') && entry.ua === 'Profile-A-UA' && entry.language === first.language))
    assert(seen.some(entry => entry.origin === 'primary' && !entry.cookie && entry.ua === 'Profile-B-UA'))
    assert(seen.filter(entry => entry.origin === 'foreign').every(entry => !entry.cookie))
    stage = 'renderer management UI'

    // Verify real renderer management UI and supported viewport sizes.
    const captureRoot = process.env.TAPCOLLECT_PROFILE_SCREENSHOTS
    const wasVisible = window.isVisible()
    if (captureRoot) {
      await mkdir(captureRoot, { recursive: true })
      window.showInactive()
    }
    await window.webContents.reload()
    await wait(900)
    await window.webContents.executeJavaScript(`location.hash = '/tasks/access-profile-smoke'`)
    await wait(600)
    await window.webContents.executeJavaScript(`document.querySelector('.run-drawer > header button')?.click()`)
    await wait(250)
    assert(await window.webContents.executeJavaScript(`document.body.innerText.includes('访问配置')`))
    assert(await window.webContents.executeJavaScript(`!document.querySelector('.run-drawer')`))
    if (captureRoot) {
      window.setContentSize(1500, 920)
      await wait(400)
      await writeFile(join(captureRoot, 'task-profile-binding.png'), (await window.webContents.capturePage()).toPNG())
    }
    await window.webContents.executeJavaScript(`location.hash = '/settings/profiles'`)
    await wait(600)
    assert(await window.webContents.executeJavaScript(`document.body.innerText.includes('访问配置 A（已编辑）')`))
    assert(await window.webContents.executeJavaScript(`document.querySelector('.app-shell').classList.contains('run-center-view')`))
    assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.preview-pane')).opacity`), '0')
    for (const [width, height] of [[1500, 920], [1180, 720]]) {
      window.setContentSize(width!, height!)
      await wait(200)
      assert(await window.webContents.executeJavaScript(`document.documentElement.scrollWidth <= innerWidth`))
      if (captureRoot) await writeFile(join(captureRoot, `profiles-${width}.png`), (await window.webContents.capturePage()).toPNG())
    }
    await window.webContents.executeJavaScript(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '新建访问配置')).click()`)
    await wait(100)
    assert(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.profile-editor input[placeholder="https://example.com"]'))`))
    if (captureRoot) await writeFile(join(captureRoot, 'profile-editor.png'), (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript(`(() => {
      const inputs = document.querySelectorAll('.profile-editor input')
      const set = (element, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }
      set(inputs[0], '界面创建配置'); set(inputs[1], 'https://example.com')
    })()`)
    await wait(50)
    await window.webContents.executeJavaScript(`([...document.querySelectorAll('.profile-editor button')].find(b => b.textContent.trim() === '保存访问配置')).click()`)
    await wait(200)
    const uiProfile = (await profiles.list()).find(item => item.name === '界面创建配置')
    assert(uiProfile)
    ids.push(uiProfile.id)
    if (captureRoot && !wasVisible) window.hide()
    return true
  } catch (error) {
    failed = true
    throw new Error(`Access profile smoke (${stage}): ${error instanceof Error ? error.stack : String(error)}`)
  } finally {
    preview.close()
    await store.deleteTask('access-profile-smoke')
    const cleanup = await Promise.allSettled(ids.map(id => profiles.remove(id, async () => false)))
    await profiles.flush()
    access.configure(setting)
    primary.closeAllConnections(); foreign.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => primary.close(() => resolve())), new Promise<void>(resolve => foreign.close(() => resolve()))])
    if (!failed) assert(cleanup.every(result => result.status === 'fulfilled'), 'Profile leases must be released before cleanup')
  }
}

export const seedProfileRestartCheck = async (store: TaskStore, profiles: AccessProfileService): Promise<void> => {
  const profile = await profiles.save({ id: '', name: '重启验证配置', origin: 'https://example.com', userAgent: 'Restart-UA', language: 'en-US' })
  await profiles.importCookies(profile.id, '[{"name":"session","value":"restart-secret","httpOnly":true}]')
  const task = createTask('profile-restart')
  task.accessProfileId = profile.id
  task.listUrl = profile.origin + '/list'
  task.listPageRules = [task.listUrl]
  await store.saveTask(task)
  await profiles.flush()
  const persisted = (await profiles.list()).find(item => item.id === profile.id)?.storageStatus === 'encrypted'
  await writeFile(join(store.rootDirectory, 'profile-restart-proof.json'), JSON.stringify({ persisted }))
}

export const verifyProfileAfterRestart = async (): Promise<boolean> => {
  await app.whenReady()
  const store = new TaskStore(join(app.getPath('userData'), 'collector-data'))
  const profiles = new AccessProfileService(store.rootDirectory, new AccessCoordinator('Restart-Chromium'))
  await profiles.initialize()
  const task = await store.loadTask('profile-restart')
  assert(task?.accessProfileId)
  const proof = JSON.parse(await readFile(join(store.rootDirectory, 'profile-restart-proof.json'), 'utf8')) as { persisted: boolean }
  const lease = await profiles.acquire(task)
  assert(lease)
  assert.equal(lease.userAgent, 'Restart-UA')
  assert.equal(lease.language, 'en-US')
  const cookies = await lease.session.cookies.get({ url: 'https://example.com' })
  assert.equal(cookies.some(cookie => cookie.value === 'restart-secret' && cookie.httpOnly), proof.persisted)
  lease.release()
  await profiles.clearSession(task.accessProfileId)
  await profiles.remove(task.accessProfileId, async () => false)
  await store.deleteTask(task.id)
  await profiles.flush()
  return true
}
