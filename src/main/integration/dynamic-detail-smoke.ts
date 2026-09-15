import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserWindow } from 'electron'
import { createTask } from '@shared/defaults'
import type { DynamicPageSession } from '@main/core/dynamic-page'
import { configureXmlRecord } from '@main/core/xml-template'
import { ElectronDynamicPageProvider } from '@main/services/dynamic-page-service'
import type { AccessProfileService } from '@main/services/access-profile-service'

const listen = (server: Server): Promise<string> => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
})

/** Exercise real popup denial/transfer, late DOM values and live list state. */
export const verifyDynamicDetails = async (
  window: BrowserWindow,
  profiles: AccessProfileService
): Promise<boolean> => {
  let foreignRequests = 0
  const foreign = createServer((_request, response) => { foreignRequests += 1; response.end('foreign') })
  const foreignOrigin = await listen(foreign)
  const seenCookies: string[] = []
  let unexpectedRequests = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local')
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (url.pathname === '/unexpected') { unexpectedRequests += 1; response.end('unexpected'); return }
    if (url.pathname === '/post') {
      response.end('<!doctype html><form class="item" action="/unexpected" method="post" target="_blank"><input name="value" value="fixture"><button>提交</button></form>')
      return
    }
    if (url.pathname === '/noop') {
      response.end('<!doctype html><div class="item"><button>无跳转</button></div>')
      return
    }
    if (url.pathname === '/slow') {
      const timer = setTimeout(() => response.end(), 4_000)
      response.once('close', () => clearTimeout(timer))
      return
    }
    if (url.pathname === '/data') {
      const timer = setTimeout(() => response.end(`正文 ${url.searchParams.get('id')}`), 850)
      response.once('close', () => clearTimeout(timer))
      return
    }
    if (url.pathname === '/detail') {
      seenCookies.push(request.headers.cookie ?? '')
      const id = JSON.stringify(url.searchParams.get('id'))
      response.end(`<!doctype html><h1 id="title"></h1><article id="body"></article>
        <img src="/slow"><script>
        setTimeout(() => document.querySelector('#title').textContent = '标题 ' + ${id}, 100);
        fetch('/data?id=' + ${id}).then(r => r.text()).then(text => document.querySelector('#body').textContent = text);
        </script>`)
      return
    }
    if (url.pathname === '/blocked') {
      const target = JSON.stringify(url.searchParams.get('target') ?? foreignOrigin)
      response.end(`<!doctype html><div class="item"><button onclick='window.open(${target})'>打开</button></div>`)
      return
    }
    if (url.pathname === '/spa') {
      response.end(`<!doctype html><div class="item"><button onclick="
        history.pushState({}, '', '#detail');
        setTimeout(() => document.querySelector('#body').textContent = '路由正文', 850);
        ">打开</button></div><h1 id="title">路由标题</h1><article id="body"></article>`)
      return
    }
    response.setHeader('Set-Cookie', 'detail-fixture=shared; Path=/; HttpOnly; SameSite=Lax')
    response.end(`<!doctype html><ul id="items"></ul><button id="next">下一页</button><script>
      let page = 1;
      const render = () => {
        const items = [1, 2].map(row => {
          const li = document.createElement('li'); li.className = 'item';
          const target = document.createElement(row === 1 ? 'a' : 'button');
          target.textContent = '文章 ' + row;
          if (row === 1) { target.target = ${JSON.stringify(url.searchParams.has('self') ? '_self' : '_Blank')}; target.href = '/detail?id=' + page + '-1'; }
          else target.onclick = () => window.open('/detail?id=' + page + '-2');
          li.append(target); return li;
        });
        document.querySelector('#items').replaceChildren(...items);
      };
      render(); document.querySelector('#next').onclick = () => { page += 1; render(); };
      ${url.searchParams.has('idle-popup') ? "window.open('/unexpected');" : ''}
      </script>`)
  })
  const origin = await listen(server)
  const task = createTask('dynamic-detail-smoke')
  task.listUrl = `${origin}/list`
  task.listPageRules = [task.listUrl]
  task.listItem.selector = '.item'
  task.detail.navigationMode = 'click'
  task.detail.link.selector = 'a,button'
  task.pagination.mode = 'click'
  task.pagination.nextButton.selector = '#next'
  task.request.timeoutSeconds = 2
  task.request.delayMs = 0
  task.xml = configureXmlRecord('<root><record><title/><body/></record></root>', 'fixture.xml', '/root/record')
  task.xml.mappings.forEach((mapping, index) => {
    mapping.mode = 'page'
    mapping.pageSource = 'detail'
    mapping.selector = index === 0 ? '#title' : '#body'
  })
  const initialViewCount = window.contentView.children.length
  const initialWindowCount = BrowserWindow.getAllWindows().length
  let session: DynamicPageSession | null = null
  let profileId = ''
  try {
    session = await new ElectronDynamicPageProvider(window).create(task)
    const advanced = await session.advance()
    assert.equal(advanced.kind, 'page')
    if (advanced.kind !== 'page') throw new Error('动态列表未进入第二页')
    for (const index of [0, 1]) {
      const started = Date.now()
      const detail = await session.openDetail(index)
      assert(detail.url.endsWith(`id=2-${index + 1}`))
      assert(detail.html.includes(`标题 2-${index + 1}`))
      assert(detail.html.includes(`正文 2-${index + 1}`))
      assert(Date.now() - started < 2_000, '详情不应等待无关慢图片')
      assert.equal(BrowserWindow.getAllWindows().length, initialWindowCount, '不能创建真实弹窗')
      assert.equal(window.contentView.children.length, initialViewCount + 2)
      const restored = await session.returnToList()
      assert.equal(restored.signature, advanced.snapshot.signature, '返回必须保留动态列表第二页')
      assert.equal(window.contentView.children.length, initialViewCount + 1)
    }
    assert(seenCookies.every(cookie => cookie.includes('detail-fixture=shared')), '详情必须复用列表会话')
    await session.close()

    // Same-view hash navigation still waits for late fields and returns normally.
    session = await new ElectronDynamicPageProvider(window).create(task, `${origin}/spa`)
    const spa = await session.openDetail(0)
    assert(spa.url.endsWith('#detail') && spa.html.includes('路由正文'))
    assert.equal((await session.returnToList()).url, `${origin}/spa`)
    await session.close()

    session = await new ElectronDynamicPageProvider(window).create(task, `${origin}/list?self=1`)
    assert((await session.openDetail(0)).html.includes('正文 1-1'))
    assert.equal((await session.returnToList()).url, `${origin}/list?self=1`)
    await session.close()

    session = await new ElectronDynamicPageProvider(window).create(task, `${origin}/list?idle-popup=1`)
    assert.equal((await session.current()).itemCount, 2)
    await session.close()
    session = await new ElectronDynamicPageProvider(window).create(task, `${origin}/post`)
    await assert.rejects(session.openDetail(0), /不支持.*表单/)
    await session.close()
    assert.equal(unexpectedRequests, 0, '无关弹窗和 POST 表单不得发出请求')

    const noNavigation = structuredClone(task)
    noNavigation.request.timeoutSeconds = 1
    session = await new ElectronDynamicPageProvider(window).create(noNavigation, `${origin}/noop`)
    await assert.rejects(session.openDetail(0), /没有进入详情/)
    await session.close()

    // A permanently missing optional field reaches the bounded deadline rather
    // than being mistaken for a navigation failure or an endless render wait.
    const optionalTask = structuredClone(task)
    optionalTask.request.timeoutSeconds = 1
    optionalTask.xml!.mappings[1]!.selector = '.optional-missing'
    session = await new ElectronDynamicPageProvider(window).create(optionalTask)
    assert((await session.openDetail(0)).html.includes('标题 1-1'))
    await session.close()

    for (const target of [origin.replace('127.0.0.1', 'localhost') + '/forbidden', 'about:blank']) {
      session = await new ElectronDynamicPageProvider(window).create(task, `${origin}/blocked?target=${encodeURIComponent(target)}`)
      await assert.rejects(session.openDetail(0), /允许的站点|访问配置/)
      assert.equal((await session.returnToList()).itemCount, 1)
      await session.close()
    }

    // A bound profile keeps its Cookie identity; same hostname / foreign port
    // must still be rejected before the foreign server receives any request.
    const profile = await profiles.save({ id: '', name: '动态详情验证', origin, userAgent: '', language: '' })
    profileId = profile.id
    task.accessProfileId = profileId
    session = await new ElectronDynamicPageProvider(window, undefined, profiles).create(task)
    assert((await session.openDetail(0)).html.includes('正文 1-1'))
    await session.close()
    session = await new ElectronDynamicPageProvider(window, undefined, profiles).create(task, `${origin}/blocked?target=${encodeURIComponent(foreignOrigin)}`)
    await assert.rejects(session.openDetail(0), /允许的站点|访问配置/)
    assert.equal(foreignRequests, 0)
    await session.close()
    assert.equal(window.contentView.children.length, initialViewCount)
    return true
  } finally {
    await session?.close()
    if (profileId) await profiles.remove(profileId, async () => false)
    server.closeAllConnections()
    foreign.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => foreign.close(() => resolve()))])
  }
}
