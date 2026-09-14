/**
 * Electron spike：最小 main + 回环静态服务的隐藏窗冒烟。
 *
 * 验收点（与本步交付物第 3 条一一对应）：
 *  1. 页面加载成功（编辑器根节点存在）
 *  2. CanvasKit 初始化成功、无 wasm fetch 报错（收集 console / pageerror）
 *  3. IndexedDB 可写可读（写入 + 读回一个值）
 *  4. 注入的 window.__DIANJING_RUNTIME_AUTOMATION_TOKEN__ 存在
 *
 * 形态 2（DIANJING_DEV_URL=…）下跳过第 4 条。
 * 全部断言打完 app.exit；隐藏窗禁弹可见窗口。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

function here(): string {
  const u = new URL('.', import.meta.url)
  let p = decodeURIComponent(u.pathname)
  if (p.startsWith('/') && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p
}
const root = resolve(here(), '..', '..')
const mainBundle = resolve(root, 'desktop-electron/dist-main/main.mjs')
if (!existsSync(mainBundle)) {
  throw new Error('main bundle 缺失——先跑 bun run spike:electron:build')
}
const devUrl = process.env.DIANJING_DEV_URL ?? ''

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DIANJING_SMOKE: '1',
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
}
if (devUrl) env.DIANJING_DEV_URL = devUrl

const electronExe = resolve(root, 'node_modules/electron/dist/electron.exe')
if (!existsSync(electronExe)) throw new Error(`electron 二进制缺失：${electronExe}`)

const child: ChildProcess = spawn(electronExe, [mainBundle, '--no-sandbox', '--disable-gpu'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
child.stdout?.on('data', (c) => { output += c.toString() })
child.stderr?.on('data', (c) => { output += c.toString() })

const timer = setTimeout(() => {
  console.error('[smoke] 超时 60s 仍无结果；force kill。日志：\n' + output.slice(-2000))
  try { child.kill('SIGKILL') } catch { /* noop */ }
  process.exit(1)
}, 60_000)

child.once('exit', (code) => {
  clearTimeout(timer)
  const m = output.match(/SMOKE_RESULT (\{[^\n]*\})/)
  if (m) console.log('[smoke] SMOKE_RESULT ' + m[1])
  if (code === 0) {
    console.log('[smoke] electron main 正常退出（app.exit 由 main 内置断言触发）')
  } else {
    console.error(`[smoke] electron 退出码 ${code}，日志尾段：\n${output.slice(-2000)}`)
  }
  process.exit(code ?? 1)
})
