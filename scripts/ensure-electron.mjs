import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)

let electronExecutable

try {
  // Electron 43 会在首次加载时检查二进制；若依赖安装阶段跳过了
  // electron 的安装脚本，这里会自动补齐 dist 和 path.txt。
  electronExecutable = require('electron')
} catch (error) {
  process.stderr.write('[Electron] Electron 运行文件准备失败。\n')
  process.stderr.write('[Electron] 请确认网络可用后重新执行 npm install 或 pnpm install。\n')
  throw error
}

if (typeof electronExecutable !== 'string' || !existsSync(electronExecutable)) {
  throw new Error(`[Electron] 未找到 Electron 可执行文件：${String(electronExecutable)}`)
}

process.stdout.write(`[Electron] 运行文件已就绪：${electronExecutable}\n`)
