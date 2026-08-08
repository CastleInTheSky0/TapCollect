import { createApp } from 'vue'
import 'tdesign-vue-next/es/style/index.css'
import App from './App.vue'
import { hasCollectorRuntime } from './collector-runtime'
import './styles.css'

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('找不到应用挂载节点')

if (!hasCollectorRuntime(window.collector)) {
  const shell = document.createElement('main')
  shell.className = 'runtime-unavailable-shell'

  const card = document.createElement('section')
  card.className = 'runtime-unavailable-card'

  const eyebrow = document.createElement('span')
  eyebrow.textContent = 'Electron 连接不可用'

  const title = document.createElement('h1')
  title.textContent = '请使用 TapCollect 桌面开发窗口'

  const description = document.createElement('p')
  description.textContent =
    '当前页面没有加载 Electron preload，因此任务、文件和采集功能不可用。请不要直接在浏览器中打开 localhost 地址。'

  const command = document.createElement('code')
  command.textContent = 'npm run dev'

  const hint = document.createElement('small')
  hint.textContent = '运行后请使用自动打开的 TapCollect 窗口进行验证。'

  card.append(eyebrow, title, description, command, hint)
  shell.append(card)
  root.replaceChildren(shell)
} else {
  createApp(App).mount(root)
}
