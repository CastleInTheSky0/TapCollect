import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { createTask } from '@shared/defaults'
import { createTaskConfigBundle } from '@shared/task-config-bundle'
import { configureXmlRecord } from '@main/core/xml-template'
import type { TaskStore } from '@main/services/task-store'
import type { RunManager } from '@main/services/run-manager'
import type { AccessCoordinator } from '@main/services/access-coordinator'
import type { AccessProfileService } from '@main/services/access-profile-service'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (condition: () => boolean | Promise<boolean>, message: string): Promise<void> => {
  for (let attempt = 0; attempt < 250; attempt++) { if (await condition()) return; await delay(40) }
  throw new Error(message)
}

/** 本地登录 fixture 覆盖真实窗口、IPC、会话、检查点与资源发布。 */
export const verifyManualVerification = async (window: BrowserWindow, store: TaskStore, profiles: AccessProfileService, access: AccessCoordinator, manager: RunManager): Promise<boolean> => {
  let requests = 0
  const site = createServer((request, response) => {
    requests++
    const url = new URL(request.url ?? '/', 'http://fixture')
    const authenticated = request.headers.cookie?.includes('verification=fixture-cookie-secret')
    response.setHeader('content-type', 'text/html; charset=utf-8')
    const record = (title: string, body = ''): string => `<!doctype html><html><body><div class="item"><span>${title}</span><div class="body">${body}</div></div><button id="next" disabled>下一页</button></body></html>`
    if (url.pathname === '/login') {
      response.writeHead(302, { 'set-cookie': 'verification=fixture-cookie-secret; Path=/; HttpOnly; SameSite=Lax', location: url.searchParams.get('next') || '/gated' })
      response.end(); return
    }
    if (url.pathname === '/first') { response.end(record('第一条已提交')); return }
    if (url.pathname === '/resource-list') { response.end(record('资源记录', '<a href="/download.pdf?token=fixture-target-secret">附件</a>')); return }
    if (!authenticated && url.pathname === '/gated') {
      response.writeHead(302, { location: '/challenge?token=fixture-target-secret' }); response.end(); return
    }
    if (!authenticated && ['/challenge', '/download.pdf', '/forbidden'].includes(url.pathname)) {
      if (url.pathname === '/forbidden') { response.statusCode = 403; response.setHeader('retry-after', '2') }
      response.end(`<!doctype html><html><head><title>用户登录</title></head><body><h1>请登录后继续</h1><form method="post" action="/login?next=${encodeURIComponent(request.url!)}"><input type="password" name="password"><button type="submit">完成本地验证</button></form></body></html>`)
      return
    }
    if (url.pathname === '/download.pdf') {
      response.setHeader('content-type', 'application/pdf')
      response.setHeader('content-disposition', 'attachment; filename="verified.pdf"')
      response.end('%PDF-1.4\nverified fixture\n%%EOF'); return
    }
    response.end(record('第二条验证后采集'))
  })
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  const settings = { ...access.settings }
  access.configure({ ...settings, minIntervalMs: 0, jitterPercent: 0, maxRetries: 0 })
  const profileIds: string[] = []
  const taskIds: string[] = []
  let stage = 'start'
  try {
    assert(await window.webContents.executeJavaScript("typeof window.collector.openVerification === 'function' && typeof window.collector.confirmVerification === 'function'"))
    for (const mode of ['static', 'dynamic', 'resource', 'cooldown']) {
      stage = `${mode}: pause`
      const profile = await profiles.save({ id: '', name: `人工验证 ${mode}`, origin, userAgent: '', language: '' })
      profileIds.push(profile.id)
      const task = createTask(`manual-verification-${mode}`)
      taskIds.push(task.id)
      task.name = `人工验证 ${mode}`
      task.accessProfileId = profile.id
      task.listUrl = `${origin}/${mode === 'resource' ? 'resource-list' : mode === 'static' ? 'first' : mode === 'cooldown' ? 'forbidden' : 'gated'}`
      task.listPageRules = mode === 'static' ? [task.listUrl, `${origin}/gated`] : [task.listUrl]
      task.listItem.selector = '.item'
      task.detail.enabled = false
      task.request.delayMs = 0
      task.request.timeoutSeconds = 5
      task.output.rootDirectory = join(store.rootDirectory, 'verification-output')
      task.output.recordsPerFile = 1
      if (mode === 'dynamic') { task.pagination.mode = 'click'; task.pagination.nextButton.selector = '#next' }
      task.xml = configureXmlRecord('<root><record><title/><body/></record></root>', 'fixture.xml', '/root/record')
      for (const mapping of task.xml.mappings) {
        mapping.mode = 'page'; mapping.pageSource = 'list'
        mapping.selector = mapping.fieldPath === 'title' ? 'span' : '.body'
        if (mapping.fieldPath === 'body') mapping.extraction = 'html'
      }
      task.dedupeFieldPath = 'title'
      if (mode === 'resource') {
        task.resources.download.enabled = true
        task.resources.download.rootDirectory = join(store.rootDirectory, 'verification-resources')
        task.resources.download.urlPrefix = '/verified-resources'
      }
      await store.saveTask(task)
      await manager.start(task.id, false)
      const item = () => manager.getSessionSnapshot().items.find(row => row.taskId === task.id)!
      await until(() => item()?.status === 'paused', `${mode}: did not pause`).catch(error => { throw new Error(`${String(error)}; ${JSON.stringify(item())}`) })
      const checkpoint = await store.getCheckpoint(task.id)
      assert(checkpoint)
      if (mode === 'static') assert.equal(checkpoint.outputFiles.length, 1)
      if (mode === 'resource') {
        assert.equal(checkpoint.outputFiles.length, 0)
        assert.equal(checkpoint.processedResourceUrls.length, 0)
        const files = await readdir(task.resources.download.rootDirectory, { recursive: true })
        assert(files.every(path => !path.endsWith('.tmp') && !path.endsWith('.pdf')))
      }
      const id = item().verification!.id
      let isolatedTaskId = ''
      if (mode === 'static') {
        const isolatedProfile = await profiles.save({ id: '', name: '等待中的独立身份', origin, userAgent: '', language: '' })
        profileIds.push(isolatedProfile.id)
        isolatedTaskId = 'manual-verification-isolated'
        taskIds.push(isolatedTaskId)
        await store.saveTask({ ...task, id: isolatedTaskId, name: '独立身份受限任务', accessProfileId: isolatedProfile.id, listUrl: `${origin}/gated`, listPageRules: [`${origin}/gated`] })
        await manager.start(isolatedTaskId, false)
      }
      const invoke = (method: 'openVerification' | 'confirmVerification') => window.webContents.executeJavaScript(`window.collector.${method}(${JSON.stringify(task.id)}, ${JSON.stringify(id)})`)
      assert(!JSON.stringify(manager.getSessionSnapshot()).includes('fixture-target-secret'))
      assert(!JSON.stringify(createTaskConfigBundle([task])).includes('fixture-target-secret'))

      if (mode === 'static') {
        stage = 'failed confirmation'
        await invoke('confirmVerification')
        await until(() => item().verification?.status === 'failed', 'Unfinished verification must fail')
        assert.equal(item().status, 'paused')
      }
      stage = `${mode}: window`
      await invoke('openVerification')
      const verificationWindow = BrowserWindow.getAllWindows().find(candidate => candidate !== window && candidate.getTitle().startsWith('人工验证'))
      assert(verificationWindow)
      await until(async () => !verificationWindow.isDestroyed() && Boolean(await verificationWindow.webContents.executeJavaScript("Boolean(document.querySelector('form button'))")), 'Missing local login form')
      assert.equal(await verificationWindow.webContents.executeJavaScript('typeof window.collector'), 'undefined')
      const count = BrowserWindow.getAllWindows().length
      await invoke('openVerification')
      assert.equal(BrowserWindow.getAllWindows().length, count)
      if (mode === 'static') {
        window.webContents.reload()
        await delay(900)
        await window.webContents.executeJavaScript(`location.hash = '/run-center/${task.id}'`)
        await delay(500)
        const capture = process.env.TAPCOLLECT_VERIFICATION_SCREENSHOTS
        if (capture) {
          await mkdir(capture, { recursive: true })
          window.showInactive()
          window.setContentSize(1180, 720)
          await delay(400)
          await writeFile(join(capture, 'run-center-verification.png'), (await window.webContents.capturePage()).toPNG())
          await writeFile(join(capture, 'verification-window.png'), (await verificationWindow.webContents.capturePage()).toPNG())
        }
        assert(await window.webContents.executeJavaScript("document.body.innerText.includes('我已完成验证，尝试恢复')"))
      }
      stage = `${mode}: login`
      const lease = await profiles.acquire(task)
      assert(lease)
      try {
        await verificationWindow.webContents.executeJavaScript("document.querySelector('form button').click()")
        await until(async () => (await lease.session.cookies.get({ url: origin })).some(cookie => cookie.name === 'verification'), 'No Cookie after local login')
      } finally { lease.release() }
      if (mode === 'static') {
        verificationWindow.close()
        await delay(100)
        assert.equal(item().status, 'paused')
        assert.equal(item().verification!.windowOpen, false)
      }
      if (mode === 'cooldown') {
        access.protect('127.0.0.1', 'Retry-After', Date.now() + 1200)
        const before = requests
        await invoke('confirmVerification')
        await delay(200)
        assert.equal(requests, before)
        assert.equal(item().verification?.status, 'waiting')
      } else if (mode === 'static') {
        await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('.host-protection-notice button')).find(button => button.textContent.includes('我已完成验证，尝试恢复')).click()")
      } else await invoke('confirmVerification')
      stage = `${mode}: resume`
      await until(() => item().status === 'completed', `${mode}: did not complete: ${item().message}`)
      assert.equal(item().result!.counters.succeeded, mode === 'static' ? 2 : 1)
      assert.equal(item().result!.outputFiles.length, mode === 'static' ? 2 : 1)
      assert.equal(await store.getCheckpoint(task.id), null)
      if (mode === 'resource') assert.equal(item().result!.resources.downloaded, 1)
      assert(!JSON.stringify(manager.getSessionSnapshot()).includes('fixture-cookie-secret'))
      assert(!JSON.stringify(manager.getSessionSnapshot()).includes('fixture-target-secret'))
      assert.equal(await invoke('confirmVerification'), false)
      const output = (await Promise.all(item().result!.outputFiles.map(path => readFile(path, 'utf8')))).join('\n')
      if (mode === 'static') assert.equal(output.split('第一条已提交').length - 1, 1)
      if (isolatedTaskId) {
        const isolated = () => manager.getSessionSnapshot().items.find(row => row.taskId === isolatedTaskId)!
        assert.equal(isolated().status, 'queued')
        assert.equal(isolated().verification!.status, 'required')
        manager.confirmVerification(isolatedTaskId, isolated().verification!.id)
        await until(() => isolated().verification?.status === 'failed', 'Independent profile must still require login')
        await manager.cancel(isolatedTaskId)
        access.clearManual('127.0.0.1')
      }
      const other = await profiles.save({ id: '', name: `隔离配置 ${mode}`, origin, userAgent: '', language: '' })
      profileIds.push(other.id)
      const otherLease = await profiles.acquire({ ...task, accessProfileId: other.id })
      assert(otherLease)
      assert.equal((await otherLease.session.cookies.get({ url: origin })).length, 0)
      otherLease.release()
    }
    return true
  } catch (error) {
    throw new Error(`人工验证冒烟 (${stage}): ${error instanceof Error ? error.stack : String(error)}`)
  } finally {
    await manager.cancelAll()
    for (const id of taskIds) await manager.deleteTask(id)
    for (const id of profileIds) await profiles.remove(id, async () => false)
    access.configure(settings)
    await new Promise<void>(resolve => { site.closeAllConnections(); site.close(() => resolve()) })
  }
}
