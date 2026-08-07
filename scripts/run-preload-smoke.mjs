import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const run = async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'tapcollect-preload-runner-'))
  const resultPath = join(temporaryRoot, 'result.json')
  const stagePath = `${resultPath}.stage`
  const bootstrapMarkerPath = join(temporaryRoot, 'bootstrap.txt')
  const bootstrapErrorPath = join(temporaryRoot, 'bootstrap-error.txt')
  const userDataPath = join(temporaryRoot, 'user-data')
  const bootstrapPath = join(temporaryRoot, 'main.mjs')

  try {
    await writeFile(
      join(temporaryRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'tapcollect-preload-smoke-app',
          version: '1.0.0',
          private: true,
          type: 'module',
          main: 'main.mjs'
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    await writeFile(
      bootstrapPath,
      `import { writeFileSync } from 'node:fs'\nimport { pathToFileURL } from 'node:url'\nimport process from 'node:process'\nimport { app } from 'electron'\nconst entry = process.env.TAPCOLLECT_PRELOAD_SMOKE_ENTRY\nconst marker = process.env.TAPCOLLECT_PRELOAD_SMOKE_BOOTSTRAP\nconst errorPath = process.env.TAPCOLLECT_PRELOAD_SMOKE_BOOTSTRAP_ERROR\nif (marker) writeFileSync(marker, 'started', 'utf8')\nif (!entry) {\n  process.stderr.write('缺少 TAPCOLLECT_PRELOAD_SMOKE_ENTRY\\n')\n  app.exit(1)\n} else {\n  import(pathToFileURL(entry).href).then(() => {\n    if (marker) writeFileSync(marker, 'imported', 'utf8')\n  }).catch((error) => {\n    const message = error instanceof Error ? error.stack : String(error)\n    if (errorPath) writeFileSync(errorPath, message, 'utf8')\n    process.stderr.write(\`${'${message}'}\\n\`)\n    app.exit(1)\n  })\n}\n`,
      'utf8'
    )

    const exitCode = await new Promise((resolveExit, reject) => {
      const child = spawn(
        electronPath,
        [`--user-data-dir=${userDataPath}`, temporaryRoot],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            TAPCOLLECT_PRELOAD_SMOKE_RESULT: resultPath,
            TAPCOLLECT_PRELOAD_SMOKE_BOOTSTRAP: bootstrapMarkerPath,
            TAPCOLLECT_PRELOAD_SMOKE_BOOTSTRAP_ERROR: bootstrapErrorPath,
            TAPCOLLECT_PRELOAD_SMOKE_ENTRY: resolve(projectRoot, 'out/main/preload-smoke.js')
          },
          stdio: 'inherit',
          windowsHide: true
        }
      )

      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (signal) {
          reject(new Error(`Electron preload 冒烟被信号 ${signal} 终止`))
          return
        }
        resolveExit(code)
      })
    })

    let serialized = ''
    let readError
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        serialized = await readFile(resultPath, 'utf8')
        break
      } catch (error) {
        readError = error
        await delay(100)
      }
    }

    if (!serialized) {
      let bootstrapState = '未执行'
      try {
        bootstrapState = await readFile(bootstrapMarkerPath, 'utf8')
      } catch {
        // Keep the diagnostic state above.
      }
      let bootstrapError = ''
      try {
        bootstrapError = await readFile(bootstrapErrorPath, 'utf8')
      } catch {
        // The import did not report an error.
      }
      let smokeStage = '未进入冒烟脚本'
      try {
        smokeStage = await readFile(stagePath, 'utf8')
      } catch {
        // Keep the diagnostic state above.
      }
      throw new Error(
        `Electron preload 冒烟在 30 秒内没有生成结果（启动进程退出码 ${String(exitCode)}，引导入口：${bootstrapState}，执行阶段：${smokeStage}${bootstrapError ? `，导入错误：${bootstrapError}` : ''}）：${String(readError)}`
      )
    }

    const output = JSON.parse(serialized)

    if (exitCode !== 0 || output.ok !== true) {
      throw new Error(output.error || `Electron preload 冒烟失败，退出码 ${String(exitCode)}`)
    }

    process.stdout.write(`${JSON.stringify(output.result, null, 2)}\n`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
