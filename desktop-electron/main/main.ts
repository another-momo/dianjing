/**
 * Electron spike 第 3 步——Electron main：用 utilityProcess 托管 pi-backend
 * + bridge 双 sidecar，打通 AI 全链路。
 *
 * 职责（与 src/app/ai/pi-backend/host.ts 对齐——host.ts 是 T33 生产编排器，
 * 本步用 utilityProcess 在 Electron 内做同款编排；env 语义刻意照抄而非共享
 * 导入，详见 spawnBridge/spawnBackend 来源注释）：
 *  1. spawn 自动化桥（electron-spike/dist-sidecar/bridge.mjs，token 经 env）
 *  2. spawn pi 后端（electron-spike/dist-sidecar/pi-backend.mjs，token + port 经 env）
 *  3. 托管 dist/（MIME 表 + SPA fallback），index.html 注入桥 token 运行时
 *     全局（__OPENPENCIL_RUNTIME_AUTOMATION_TOKEN__，见 bridge/runtime.ts P104）
 *  4. 反代 /api/pi* → 127.0.0.1:<backend> 并注入 Bearer piToken（流式管道透传，
 *     SSE 不缓冲；前端同源调用零改动）
 *  5. sidecar 崩溃退避复活（移植 vite-plugin.ts T27 语义：最多 3 次、间隔退避，
 *     一次 /health 就绪即清零）
 *  6. app quit 两段式 kill（utilityProcess.kill() = SIGTERM，2s 内未退走
 *     Windows taskkill /F 兜底——utilityProcess.kill() 不接受 signal 参数，
 *     Windows 上无原生 SIGKILL 等价）
 *  7. 窗口与 sidecar 生命周期解耦（关窗不杀 sidecar，app quit 才杀）
 *  8. P0.5 壳加固（依据 docs/202609071041-electron-shell-ux.md §1）：
 *     8.1 防白屏：backgroundColor + 可见窗 show:false 起步 + ready-to-show
 *     8.2 单实例锁（smoke 路径 OPENPENCIL_DISABLE_SINGLE_INSTANCE=1 绕过）
 *     8.3 did-fail-load 重试 3 次（1s 间隔）+ 失败日志
 *     8.4 setWindowOpenHandler + will-navigate 双重拦截（url-safety 分类）
 *  9. P1 状态根 userData 化 + 窗口状态持久化 + 关窗语义：
 *     9.1 app.setName('open-pencil') 在 main() 入口尽快调——让 userData 目录
 *         在 Windows 下落到 %APPDATA%/open-pencil（macOS ~/Library/Application
 *         Support/open-pencil），可读且与产品名一致
 *     9.2 rootDir 缺省从 distDir 改为 app.getPath('userData')；env 仍优先——
 *         smoke/full-smoke 显式传 OPENPENCIL_ROOT_DIR 隔离多实例，dev 启动器
 *         spike-electron-dev.ts 钉 worktree 根的便利也不受影响
 *     9.3 窗口 bounds（width/height/x/y/maximized）持久化到 userData/
 *         window-state.json（见 ./window-state.ts）；恢复时校验与当前显示器
 *         集合有交集——拔了外接屏窗口出屏是经典坑；无交集回退 1440x900 居中
 *     9.4 macOS 关窗不退出（dock 图标保留，activate 重建窗口）；其余平台全关
 *         即 quit；quit 时杀 sidecar 的既有逻辑（before-quit）保持不动
 *
 * token 三方对齐（不变量，spike 阶段由本文件单点维护）：
 *   pageToken === bridgeEnvToken（页面经 WS 连桥用的 token = 注入 index.html
 *     的 __OPENPENCIL_RUNTIME_AUTOMATION_TOKEN__ = spawn 桥时 env 传入的 token）
 *   proxyBearer === piBackendEnvToken（/api/pi 反代注入的 Bearer = spawn 后端
 *     时 env 传入的 OPENPENCIL_PI_TOKEN）
 *   桥与后端的 token 彼此独立——只与代理/前端对应侧对齐即可。
 *   任何漂移都会破坏：① /rpc 401；② /api/pi 401；③ pi-backend 拿不到桥端口/token。
 */

import { randomBytes } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, shell, utilityProcess, type UtilityProcess } from 'electron'
import {
  readDisableSingleInstanceLock,
  readElectronBackendPort,
  readElectronBridgePort,
  readElectronDevURL,
  readElectronLoopbackPort,
  readRootDir,
  readShowWindow,
  readSmokeMode,
  readFullSmokeMode
} from '@/app/orchestration/env'
import { waitForHealthPolling } from '@/app/orchestration/health'
import {
  RUNTIME_AUTOMATION_TOKEN_KEY,
  RUNTIME_BRIDGE_URL_KEY,
  RUNTIME_ELECTRON_KEY
} from '@/app/orchestration/runtime-globals'
import { MAX_AUTO_RESTARTS, nextRestartDelay } from '@/app/orchestration/restart'
import { generateToken } from '@/app/orchestration/token'
import { resolveElectronRootDir } from '@/app/ai/pi-backend/paths'
import { pickFreePort, randomPort } from '../tools/ports.js'
import { classifyExternalUrl, isHttpOrHttps, isLoopbackHttpUrl } from './url-safety.js'
import { loadWindowState, saveWindowState, type WindowState } from './window-state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── 端口 + token 自举 ──

// OPENPENCIL_PI_BACKEND_PORT / OPENPENCIL_MCP_PORT 是 sidecar 自身 env 名（见
// pi-backend/main.ts:92 + bridge/server/index.ts:28）。与 vite plugin 命名错开
// 是有意的——electron 主进程设的是「自己 fork 子进程时的 env」，不是 vite
// plugin 已经设过的 env，二者不冲突；vite plugin 路径走的是另一套进程。
// OPENPENCIL_LOOPBACK_PORT：full-smoke 用，把回环服务端口钉住便于外部脚本
// 经固定 URL 探活（不钉则 smoke 必须 grep 主进程 stdout 解出随机端口）
const bridgePort = readElectronBridgePort() ?? randomPort()
const backendPort = readElectronBackendPort() ?? randomPort()
const pinnedLoopbackPort = readElectronLoopbackPort()
// 三方对齐不变量（见文件头）
const bridgeToken = generateToken()
const piToken = generateToken()

// ── sidecar 子进程编排（移植 vite-plugin.ts T27 退避 + host.ts spawn 语义）──

const CHILD_EXIT_TIMEOUT_MS = 2_000
const HEALTH_TIMEOUT_MS = 15_000
const HEALTH_INTERVAL_MS = 150

interface SidecarHandle {
  readonly name: string
  readonly modulePath: string
  readonly env: NodeJS.ProcessEnv
  /** health URL——bridge 探 /health（127.0.0.1:<bridgePort>），backend 同款 */
  readonly healthUrl: string
  /** 当前活进程引用——kill / pid 查询都走这里；复活时由 spawnAndWatch 重设 */
  current: UtilityProcess | null
  /** 主动退出标记（app quit 触发，区分「意外崩溃」与「主动 kill」） */
  stopping: boolean
  /** 连续崩溃计数——一次 /health 就绪即清零 */
  restartCount: number
  /** 复活定时器——app quit 时清理 */
  restartTimer: ReturnType<typeof setTimeout> | null
}

let bridgeHandle: SidecarHandle | null = null
let backendHandle: SidecarHandle | null = null

// 「主进程端口」+ 回环 server 引用——抽成模块态供 runFullSmoke / 关窗回调复用
let portFromState = 0
let serverFromState: ReturnType<typeof createServer> | null = null

async function waitForHealth(
  child: UtilityProcess,
  healthUrl: string,
  onReady: () => void
): Promise<void> {
  await waitForHealthPolling({
    intervalMs: HEALTH_INTERVAL_MS,
    timeoutMs: HEALTH_TIMEOUT_MS,
    // pid 变 undefined = 子进程已退出（utilityProcess 退出后 pid 会置 undefined，
    // 见 electron.d.ts L15940），立刻放弃等待
    isAlive: () => child.pid !== undefined,
    probe: async () => {
      const res = await fetch(healthUrl)
      return res.ok
    },
    onReady,
    onTimeout: () => {
      console.warn(`[sidecar] ${HEALTH_TIMEOUT_MS}ms 内未等到 ${healthUrl} 就绪`)
    }
  })
}

function passthroughStream(stream: NodeJS.ReadableStream | null, label: string): void {
  if (!stream) return
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    process.stderr.write(`[${label}] ${chunk}`)
  })
}

function scheduleRestart(handle: SidecarHandle): void {
  if (handle.stopping) return
  const delay = nextRestartDelay(handle.restartCount)
  if (delay === null) {
    console.error(
      `[sidecar] ${handle.name} 已连续崩溃 ${MAX_AUTO_RESTARTS} 次，停止自动复活——` +
        `修复后重启 Electron，或 bun run spike:sidecar:smoke 单起 sidecar 看启动报错`
    )
    return
  }
  handle.restartCount++
  console.error(`[sidecar] ${handle.name} ${delay}ms 后自动重启（第 ${handle.restartCount}/${MAX_AUTO_RESTARTS} 次）`)
  handle.restartTimer = setTimeout(() => {
    handle.restartTimer = null
    spawnAndWatch(handle)
  }, delay)
}

function spawnAndWatch(handle: SidecarHandle): void {
  // utilityProcess.fork 必须是 ESM 入口（Electron 41+ 强制 modulePath 为 ESM
  // 或 CJS 之一，dist-sidecar/*.mjs 是 ESM）
  let child: UtilityProcess
  try {
    child = utilityProcess.fork(handle.modulePath, [], {
      env: handle.env,
      serviceName: handle.name,
      // stdio: 'pipe' 让 stdout/stderr 经 main 进程透传（默认 inherit 直绑
      // 主进程终端，smoke 抓日志更稳）；stdin 固定 ignore（utilityProcess 不接）
      stdio: 'pipe'
    })
  } catch (error) {
    console.error(`[sidecar] ${handle.name} fork 失败：${error instanceof Error ? error.message : String(error)}`)
    scheduleRestart(handle)
    return
  }
  handle.current = child
  // full-smoke 用：打印 PID 让外部脚本能 taskkill 该子进程模拟崩溃。
  // child.pid 在 fork 返回时仍是 undefined（utilityProcess 文档：直到 'spawn'
  // 事件触发才赋值），所以在 'spawn' 上打印而非同步 console.log
  child.once('spawn', () => {
    console.log(`SIDECAR_PID ${handle.name} ${child.pid}`)
  })
  void waitForHealth(child, handle.healthUrl, () => {
    // 一次 /health 就绪即清零崩溃计数——只针对「连续」崩溃
    handle.restartCount = 0
    console.error(`[sidecar] ${handle.name} ready (pid=${child.pid})`)
  })

  passthroughStream(child.stdout, handle.name)
  passthroughStream(child.stderr, handle.name)

  child.on('exit', (code: number) => {
    // handle.current 被 stopSidecar 主动置 null = 主动回收（app quit 触发的
    // kill），不复活
    if (handle.current !== child) return
    handle.current = null
    if (handle.stopping) return
    if (code === 0) return // 正常退出
    console.error(`[sidecar] ${handle.name} 进程退出 code=${code}`)
    scheduleRestart(handle)
  })
}

function stopSidecar(handle: SidecarHandle): Promise<void> {
  handle.stopping = true
  if (handle.restartTimer) {
    clearTimeout(handle.restartTimer)
    handle.restartTimer = null
  }
  const child = handle.current
  handle.current = null
  if (!child || child.pid === undefined) return Promise.resolve()
  return new Promise<void>((resolveStop) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolveStop()
    }
    child.once('exit', finish)
    try {
      child.kill()
    } catch (error) {
      console.error(`[sidecar] ${handle.name} kill 失败：${error instanceof Error ? error.message : String(error)}`)
      finish()
      return
    }
    // SIGTERM 兜底：utilityProcess.kill() 是 SIGTERM，但 Windows 上 SIGTERM
    // 落到 Node 子进程 ≈ 立即终止（无优雅退出概念），保留 2s 是为 Unix 形态
    // 上给 sidecar 自己的 shutdown handler 排空连接。
    setTimeout(() => {
      if (settled) return
      if (child.pid === undefined) {
        finish()
        return
      }
      // Windows 兜底：用 taskkill /T /F 强杀（utilityProcess.kill() 不接受
      // signal 参数，无原生 SIGKILL；fork 的 Node 进程默认响应 SIGTERM 但
      // Windows 上常被立即强杀，保留 taskkill 是为罕见「SIGTERM 忽略」兜底）。
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        })
        killer.once('exit', finish)
        killer.once('error', finish)
      } else {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          // 已退出
        }
        finish()
      }
    }, CHILD_EXIT_TIMEOUT_MS).unref()
  })
}

// ── 回环静态服务 + /api/pi 反代 ──

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
}
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'])

function existsAsFile(filePath: string): boolean {
  try { return statSync(filePath).isFile() } catch { return false }
}

function sendFile(res: ServerResponse, filePath: string): void {
  res.writeHead(200, { 'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream' })
  const stream = createReadStream(filePath)
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end() })
  stream.pipe(res)
}

function proxyPi(req: IncomingMessage, res: ServerResponse, backendPortInner: number, bearer: string): void {
  // SSE 流式代理——vite http-proxy 的等价物（spike 不引 http-proxy 包，手写）
  // 关键纪律：
  //  1. 转发 request body（POST /api/pi-chat 的 JSON）
  //  2. 转发 response stream（SSE 不缓冲，逐 chunk）
  //  3. 客户端断连（res.close 且非 writableEnded）才销毁上游；SSE 正常结
  //     尾时 response.pipe(res) 自然 end，res.close 触发但不销毁上游
  //  4. 上游错（refused / hangup）回 502，**headersSent 后不重写**
  // 早期实现的 bug：res.on('close') 无条件 upstream.destroy()——SSE 正常
  // 结尾时 response.pipe 完成也会触发 res.close，导致上游被强杀、pi-backend
  // 看到自己的 res close（writableEnded=false 因为没显式 res.end()）→ 调
  // service.abort → 用户感知「chat 跑一半被取消」。修复：只销毁 if 客户端
  // 主动断（res.writableEnded=false）
  process.stderr.write(`[proxyPi] → ${req.method} ${req.url} (backend=${backendPortInner})\n`)
  const headers: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(req.headers)) if (!HOP_BY_HOP_HEADERS.has(key)) headers[key] = value
  headers.authorization = `Bearer ${bearer}`
  headers.host = `127.0.0.1:${backendPortInner}`
  const upstream = httpRequest({ host: '127.0.0.1', port: backendPortInner, path: req.url, method: req.method, headers }, (response) => {
    process.stderr.write(`[proxyPi] ← ${response.statusCode} ${req.url}\n`)
    // 客户端在等上游响应期间断开（页面刷新/设置面板切换取消在途请求）：
    // res 已销毁，writeHead/pipe 会抛 ERR_STREAM_DESTROYED / EPIPE——直接弃流
    if (res.destroyed) {
      response.destroy()
      return
    }
    const responseHeaders: Record<string, string | string[] | undefined> = {}
    for (const [key, value] of Object.entries(response.headers)) if (!HOP_BY_HOP_HEADERS.has(key)) responseHeaders[key] = value
    res.writeHead(response.statusCode ?? 502, responseHeaders)
    // pipe 不转发错误：两侧各自挂 error 监听，否则客户端中途断连时
    // res.write 抛 EPIPE → uncaughtException → Electron 弹「main process 错误」对话框
    response.on('error', (error) => {
      process.stderr.write(`[proxyPi] upstream response error: ${error.message}\n`)
      if (!res.destroyed) res.destroy()
    })
    response.pipe(res)
  })
  upstream.on('error', (error) => {
    process.stderr.write(`[proxyPi] upstream error: ${error.message}\n`)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    if (!res.writableEnded) res.end(`pi 后端不可达（${error.message}）`)
  })
  upstream.on('socket', (s) => {
    s.on('close', (hadError) => {
      process.stderr.write(`[proxyPi] upstream socket close (hadError=${hadError})\n`)
    })
  })
  res.on('error', (error) => {
    // 客户端 socket 已断后的写失败（EPIPE 典型）——吞掉并断上游，不冒泡
    process.stderr.write(`[proxyPi] client res error: ${error.message}\n`)
    upstream.destroy()
  })
  res.on('close', () => {
    process.stderr.write(`[proxyPi] client close (writableEnded=${res.writableEnded})\n`)
    // 仅当客户端断连（res 未正常结束）才销毁上游；正常 SSE 收尾不杀
    if (!res.writableEnded) {
      upstream.destroy()
    }
  })
  // POST body 透传：req.pipe 在 'end' 时自动 upstream.end()——比手写
  // data/end 健壮；Node 20 http 模块会自动等 socket 可写再 flush
  req.pipe(upstream)
}

export interface LoopbackServerOptions {
  distDir: string
  automationToken?: string
  backendPort?: number
  piToken?: string
  /** 0 = 随机端口；full-smoke 用 env 钉住便于外部脚本探活 */
  port?: number
}

export function createLoopbackServer(options: LoopbackServerOptions): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const distDir = resolve(options.distDir)
  const indexPath = join(distDir, 'index.html')
  if (!existsAsFile(indexPath)) throw new Error(`dist/index.html 不存在：${distDir}`)
  const token = options.automationToken ?? randomBytes(16).toString('hex')
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (urlPath.startsWith('/api/pi') && options.backendPort && options.piToken) {
      return proxyPi(req, res, options.backendPort, options.piToken)
    }
    // shell-polish A2：三键主题跟随——前端把当前主题色 POST 过来，main 调
    // setTitleBarOverlay。严格 ^#[0-9a-fA-F]{6}$ 校验拒绝一切非法输入；端点
    // 幂等（setTitleBarOverlay 重复同值无副作用），所以前端每次 applyTheme 都
    // 发即可。命名空间 /__openpencil/* 留扩展位（如未来 chat-telegram 等
    // shell-side hook 都走此前缀，避免与产品路由 /api/* 混）。
    if (urlPath === '/__openpencil/titlebar-theme' && req.method === 'POST') {
      return handleTitleBarTheme(req, res)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
    const filePath = normalize(join(distDir, urlPath))
    const relative = filePath.slice(distDir.length)
    if (relative.startsWith('..') || filePath.startsWith('..')) { res.writeHead(403).end(); return }
    const candidate = existsAsFile(filePath) ? filePath : indexPath
    if (candidate === indexPath && extname(urlPath) !== '' && urlPath !== '/' && !existsAsFile(filePath)) { res.writeHead(404).end('Not Found'); return }
    if (candidate === indexPath) {
      const html = readFileSync(indexPath, 'utf8')
      // spike-electron-spike：双注入——桥 token + 桥 WS URL（运行时全局名见
      // src/app/bridge/{url,runtime}.ts 与 src/app/orchestration/runtime-globals.ts）。
      // electron 形态下桥在随机端口（bridgePort），页面必须拿这个 URL 去连；
      // 只有 token 没有 URL 会让页面去撞 build-time 烘焙的 ws://127.0.0.1:7600，
      // 撞主战场 + token 不符。dev 形态不注入，页面 fallback 到 vite define 烘焙值。
      // shell-polish A1：三键遮挡顶部通栏——前端用 isElectron() 给 editor-root 顶
      // 部通栏右侧预留 titleBarOverlay 宽度；A2：标题栏主题切换——前端把当前主
      // 题色 POST 到 /__openpencil/titlebar-theme，main 调 setTitleBarOverlay。
      // 浏览器形态（含 dev url 路径）不注入——这些功能只在 Electron 壳里生效。
      const script = `<script>window.${RUNTIME_AUTOMATION_TOKEN_KEY}=${JSON.stringify(token)};window.${RUNTIME_BRIDGE_URL_KEY}=${JSON.stringify(`ws://127.0.0.1:${bridgePort}`)};window.${RUNTIME_ELECTRON_KEY}=true</script>`
      res.writeHead(200, { 'content-type': MIME_TYPES['.html'] }); res.end(html.replace('<head>', `<head>${script}`)); return
    }
    sendFile(res, candidate)
  })
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    // pinnedLoopbackPort>0 时钉住端口；full-smoke 必须钉（外部脚本靠固定 URL
    // 探活）；0 = 随机（与 spike 第 2 步形态兼容）
    server.listen(options.port && options.port > 0 ? options.port : 0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('无法读取回环服务端口'))
      resolvePromise({ server, port: address.port })
    })
  })
}

// ── BrowserWindow 共享 options ──

// P0 外壳打磨——去掉原生标题栏：
//   titleBarStyle: 'hidden' → 隐藏标题栏但保留窗口阴影/拖拽/贴边分屏等系统行为
//   titleBarOverlay → Windows 上在页面顶部叠加原生最小化/最大化/关闭按钮（macOS
//   无按钮显示，但 overlay 字段不影响）。色值必须匹配应用顶栏实际背景——
//   src/theme/tab-bar.ts 的 root 槽位 'bg-canvas'，深色主题 token
//   --color-canvas: #1e1e1e（src/app.css L41）。height 36 = h-9 匹配顶栏高度。
//   symbolColor：Windows 不读但 Electron 类型要求，写合理前景色保持语义完整。
// 默认尺寸 1440x900：旧缺省 800x600 太小，肉眼可见「迷你窗」。抽取 helper
// 收敛三处 BrowserWindow 调用，防漂移。
const BASE_WINDOW_OPTIONS: Electron.BrowserWindowConstructorOptions = {
  width: 1440,
  height: 900,
  // P0.5 防白屏——backgroundColor 与 --color-canvas 同色（src/app.css L41），
  // 覆盖从 BrowserWindow 创建到 ready-to-show 之间的「无背景」窗口，避免
  // 冷启动/代码缓存命中失败时短暂闪现默认灰白；index.html 自带 #boot-splash
  // 与之叠加，作为内容就绪前的二次兜底。
  backgroundColor: '#1e1e1e',
  titleBarStyle: 'hidden',
  titleBarOverlay: {
    color: '#1e1e1e',
    symbolColor: '#ffffff',
    height: 36
  }
}

// shell-polish A2：标题栏高度常量——handleTitleBarTheme 与 BASE_WINDOW_OPTIONS
// 共享此值，防漂移（前端 --window-controls-width 按 height×3+ 余量校准）。
const TITLEBAR_OVERLAY_HEIGHT = 36

// shell-polish A2：处理前端 POST /__openpencil/titlebar-theme。严格六位 hex
// 校验拒绝任何非法输入；端点幂等（重复同值无副作用），无需去抖。读 body 用
// 累加 chunk 模式——http.IncomingMessage 不直接给完整 body，需自管 buffer。
// apply 走 BrowserWindow.getAllWindows()——覆盖 dev 形态 / 默认形态 / 未来
// 多窗口共享 sidecar 形态；窗口已 destroyed 静默跳过。
function handleTitleBarTheme(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'invalid json', detail: String(error) }))
      return
    }
    const body = parsed as { color?: unknown; symbolColor?: unknown }
    if (typeof body.color !== 'string' || typeof body.symbolColor !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'color and symbolColor must be strings' }))
      return
    }
    const HEX6 = /^#[0-9a-fA-F]{6}$/
    if (!HEX6.test(body.color) || !HEX6.test(body.symbolColor)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'color and symbolColor must match ^#[0-9a-fA-F]{6}$' }))
      return
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      try {
        window.setTitleBarOverlay({
          color: body.color,
          symbolColor: body.symbolColor,
          height: TITLEBAR_OVERLAY_HEIGHT
        })
      } catch (error) {
        // setTitleBarOverlay 在非 Windows 平台会抛——本任务仅交付 Windows 包，但
        // main.ts 复用为产品形态后会被 macOS 跑；记日志不冒泡。
        process.stderr.write(`[electron-main] setTitleBarOverlay 失败：${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
  })
  req.on('error', (error) => {
    process.stderr.write(`[electron-main] titlebar-theme 请求体读失败：${error.message}\n`)
    if (!res.headersSent) res.writeHead(400).end()
  })
}

function baseWindowOptions(extra: Electron.BrowserWindowConstructorOptions = {}): Electron.BrowserWindowConstructorOptions {
  return { ...BASE_WINDOW_OPTIONS, ...extra }
}

// P1.9.3 窗口状态持久化——把 loadWindowState 解出的 { width, height, x, y }
// 折进 BrowserWindow constructorOptions；maximized 在 ready-to-show 后单独
// 恢复（构造时 maximize 会与「show:false 起步 + ready-to-show show」叠加
// 时序混乱——用户首启会看到一闪的「未最大化正常尺寸」）。把恢复职责收敛到
// restoreBounds(window, state) 一处，三个构造分支（dev / default / full-smoke）
// 共用同一份语义，full-smoke 不调（隐藏探针不参与用户可见窗口状态）。
// x/y 可省（首启 / 坐标失效回退后无坐标）——Electron.setBounds 拒绝含
// undefined 的对象，必须按存在性分支构造
function restoreBounds(window: BrowserWindow, state: WindowState): void {
  if (state.x !== undefined && state.y !== undefined) {
    window.setBounds({ x: state.x, y: state.y, width: state.width, height: state.height })
  } else {
    window.setBounds({ width: state.width, height: state.height })
  }
  if (state.maximized) {
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.maximize()
    })
  }
}

// ── 窗体安全/重试/可见时序（attachWindowSafety，applySafeShow）──
//
// 把四项加固收敛到一处给 BrowserWindow 挂，避免在每个分支里重复挂载。调用
// 约定：构造 BrowserWindow 时给 show:false（含 smoke 隐藏窗），构造后立即
// 调一次 attachWindowSafety(window, loadUrl)；applySafeShow 只在「本进程
// 想把窗口显示出来」的路径调（默认形态 + showWindow），smoke 路径跳过——
// ready-to-show 是「内容已绘制完成」信号，smoke 探针在 webContents 跑完
// 之前就返回了，不该等 ready-to-show 卡时序。

const LOAD_RETRY_MAX = 3
const LOAD_RETRY_DELAY_MS = 1_000

function attachWindowSafety(window: BrowserWindow, loadUrl: string): void {
  // P0.5.3 did-fail-load 重试——加载失败多为回环服务刚 listen 完但路由未
  // 就绪、或一次性 connection refused，等 1s 再 loadURL 即可；三次仍败让
  // 窗口显示错误态（electron 在 did-fail-load 默认会画 ERR_* 错误页即可，
  // 本项目不做自定义错误页，stderr 留日志便于调试）。
  let attempt = 0
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return // 子 frame 失败不重试整页
    attempt++
    process.stderr.write(`[electron-main] did-fail-load attempt=${attempt}/${LOAD_RETRY_MAX} code=${errorCode} ${errorDescription} url=${validatedUrl}\n`)
    if (attempt > LOAD_RETRY_MAX) {
      process.stderr.write(`[electron-main] 加载 ${loadUrl} 重试 ${LOAD_RETRY_MAX} 次仍失败，保持错误页显示\n`)
      return
    }
    setTimeout(() => {
      void window.loadURL(loadUrl).catch((err) => {
        process.stderr.write(`[electron-main] loadURL 重试失败：${err instanceof Error ? err.message : String(err)}\n`)
      })
    }, LOAD_RETRY_DELAY_MS)
  })

  // P0.5.4 外链与导航拦截——setWindowOpenHandler 处理 window.open / target=_blank
  // 与 <a href> click；will-navigate 处理 window.location 改写（包含 SPA 内
  // location 跳转、第三方脚本调用 location.href 等）。两份兜底分工：
  //   setWindowOpenHandler：仅 http/https 走 shell.openExternal；其余 deny
  //   will-navigate：仅 http://127.0.0.1 | http://localhost 回环导航放行
  window.webContents.setWindowOpenHandler(({ url }) => {
    const verdict = classifyExternalUrl(url)
    if (verdict.kind === 'dangerous') {
      process.stderr.write(`[electron-main] window.open 拒绝（${verdict.scheme ?? 'dangerous'}）：${verdict.reason}\n`)
      return { action: 'deny' }
    }
    if (isHttpOrHttps(url)) {
      // 调 shell.openExternal 把外链交给系统浏览器；deny 阻止在 Electron 窗内打开
      void shell.openExternal(url).catch((err) => {
        process.stderr.write(`[electron-main] shell.openExternal 失败：${err instanceof Error ? err.message : String(err)}\n`)
      })
      return { action: 'deny' }
    }
    process.stderr.write(`[electron-main] window.open 拒绝（非 http/https scheme）：${url}\n`)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, navigationUrl) => {
    // 同源回环跳转放行（vite dev / Electron 回环服务的 SPA 内跳转）
    if (isLoopbackHttpUrl(navigationUrl)) {
      // 同 origin 比对——拆 origin（scheme://host:port），nav 目标 origin
      // 必须等于 loadUrl origin。127.0.0.1:port 与 127.0.0.1:other-port 视
      // 跨源，避免「同 host 不同端口」被前缀误判放行。
      let navOrigin: string | null = null
      try { navOrigin = new URL(navigationUrl).origin } catch { navOrigin = null }
      let loadOrigin: string | null = null
      try { loadOrigin = new URL(loadUrl).origin } catch { loadOrigin = null }
      if (navOrigin && loadOrigin && navOrigin === loadOrigin) return
    }
    event.preventDefault()
    if (isHttpOrHttps(navigationUrl)) {
      void shell.openExternal(navigationUrl).catch((err) => {
        process.stderr.write(`[electron-main] shell.openExternal 失败：${err instanceof Error ? err.message : String(err)}\n`)
      })
    } else {
      process.stderr.write(`[electron-main] will-navigate 拒绝（非 http/https 或非预期 host）：${navigationUrl}\n`)
    }
  })
}

function applySafeShow(window: BrowserWindow): void {
  // P0.5.1 ready-to-show——BrowserWindow 构造时一律 show:false，等首次绘制
  // 完成（ready-to-show）再 show 一次，避免 Windows 上常见的「窗口先白/灰
  // 一帧再换内容」闪烁。smoke 路径不调（探针不等绘制），hide 模式也不调。
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })
}

// P1.9.3 关窗前写盘——挂 'close'（不是 'closed'）：'closed' 时已 destroyed，
// getBounds() 行为平台相关；'close' 是 Electron 关闭流程的第一个事件，
// e.preventDefault() 可拦住——本路径只读不拦，故不存 preventDefault
function persistBoundsOnClose(window: BrowserWindow): void {
  window.on('close', () => {
    if (window.isDestroyed()) return
    const bounds = window.getBounds()
    saveWindowState({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: window.isMaximized()
    })
  })
}

// ── 隐藏窗探针（与 electron-smoke 同款，full-smoke 用）──

const PROBE_SCRIPT = `(async () => {
  const out = { checks: [] }
  function record(name, ok, detail) { out.checks.push({ name, ok: !!ok, detail: detail ?? null }); return !!ok }
  out.rootExists = !!document.querySelector('#app, [data-shell]')
  record('editor root', out.rootExists, 'document selector #app or [data-shell]')
  out.ck = await (async () => {
    try {
      const res = await fetch('/canvaskit.wasm', { method: 'GET' })
      const ct = res.headers.get('content-type') || ''
      const buf = await res.arrayBuffer()
      return { ok: res.ok && ct.includes('application/wasm') && buf.byteLength > 1024, status: res.status, contentType: ct, size: buf.byteLength }
    } catch (e) { return { ok: false, error: String(e) } }
  })()
  record('canvaskit.wasm fetchable via http', out.ck.ok, JSON.stringify(out.ck))
  out.idb = await (async () => {
    try {
      const open = indexedDB.open('openpencil-smoke', 1)
      await new Promise((res, rej) => { open.onupgradeneeded = () => open.result.createObjectStore('kv'); open.onsuccess = res; open.onerror = () => rej(open.error) })
      const db = open.result
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put('hello-electron', 'k')
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
      const readTx = db.transaction('kv', 'readonly')
      const v = await new Promise((res, rej) => { const r = readTx.objectStore('kv').get('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      db.close()
      return { ok: v === 'hello-electron', value: v }
    } catch (e) { return { ok: false, error: String(e) } }
  })()
  record('idb write+read', out.idb.ok, JSON.stringify(out.idb))
  // 探针在渲染进程跑——此处字面量必须与 src/app/orchestration/runtime-globals.ts
  // 的 RUNTIME_AUTOMATION_TOKEN_KEY / RUNTIME_BRIDGE_URL_KEY 同源（拼字符串传过去
  // 没办法用 const；本探针手改与上面 withRuntimeToken 注入脚本错位即回归）
  out.token = typeof window.__OPENPENCIL_RUNTIME_AUTOMATION_TOKEN__ === 'string' && window.__OPENPENCIL_RUNTIME_AUTOMATION_TOKEN__.length > 0
  record('runtime automation token injected', out.token, window.__OPENPENCIL_RUNTIME_AUTOMATION_TOKEN__ ?? '')
  // spike-electron-spike：桥 URL 运行时全局注入断言（electron 形态必命中；
  // dev 形态——OPENPENCIL_DEV_URL 路径下 main 不注入——本条天然不命中，smoke
  // 跳过本条以免误伤）
  out.runtimeBridgeUrl = typeof window.__OPENPENCIL_RUNTIME_BRIDGE_URL__ === 'string' && window.__OPENPENCIL_RUNTIME_BRIDGE_URL__.startsWith('ws://')
  record('runtime bridge url injected', out.runtimeBridgeUrl, window.__OPENPENCIL_RUNTIME_BRIDGE_URL__ ?? '')
  // spike-electron-spike：Vue mount + mcpRuntime 状态探针——证 WorkspaceView
  // onMounted 跑了 startMCPRuntime，进而 connectAutomation 才会经运行时 URL
  // 通道 WS 连桥。
  await new Promise((r) => setTimeout(r, 500))
  out.vueMounted = !!document.querySelector('[data-shell]') || !!document.querySelector('#app .app-root, #app > div')
  record('vue mounted (workspace shell rendered)', out.vueMounted, 'data-shell or #app child element')
  window.__SMOKE_RESULT__ = out
})().catch((e) => { window.__SMOKE_RESULT__ = { fatal: String(e) } })`

async function runSmoke(window: BrowserWindow, skipTokenCheck: boolean): Promise<{ ok: boolean; result: unknown }> {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  window.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message)
  })
  window.webContents.on('render-process-gone', (_e, details) => consoleErrors.push('render-process-gone: ' + JSON.stringify(details)))
  window.webContents.on('did-fail-load', (_e, code, desc, url) => pageErrors.push('did-fail-load: ' + code + ' ' + desc + ' ' + url))
  await window.webContents.executeJavaScript(PROBE_SCRIPT, true)
  const raw = await window.webContents.executeJavaScript('window.__SMOKE_RESULT__', true)
  const result = (raw ?? {}) as { fatal?: string; checks?: Array<{ name: string; ok: boolean; detail: string | null }> }
  if (result.fatal) return { ok: false, result: { ...result, consoleErrors, pageErrors } }
  const checks = (result.checks ?? []).filter((c) =>
    !(skipTokenCheck && (c.name === 'runtime automation token injected' || c.name === 'runtime bridge url injected'))
  )
  const allOk = checks.length > 0 && checks.every((c) => c.ok)
  return { ok: allOk, result: { checks, consoleErrors, pageErrors } }
}

// ── sidecar + 回环启动（编排入口，被 main / full-smoke 共用）──

function buildSidecars(distDir: string, loopbackOrigin: string): { bridge: SidecarHandle; backend: SidecarHandle } {
  // OPENPENCIL_ROOT_DIR：状态根目录（sidecar 内 .openpencil/ 落盘点）。
  // 解析优先级 env > app.getPath('userData')——env 优先保留是为了让 smoke /
  // full-smoke 显式钉独立 rootDir 隔离多实例，dev 启动器 spike-electron-dev.ts
  // 钉 worktree 根的便利也不受影响；用户日常双击图标落地即默认 userData，
  // 不再依赖「spawn 时所在目录」（既有缺省 distDir 在打包形态下随产物目录
  // 走——既不可读也不跨平台稳定）
  const rootDir = resolveElectronRootDir(readRootDir(), app.getPath('userData'))
  // OPENPENCIL_STUDIO_BUILTIN_DIR：studio 内置资产目录的显式解析基准。
  // registry 缺省按 rootDir + 源码树子路径（src/app/ai/pi-backend/studio）
  // 解析——打包形态 rootDir=userData 下没有源码树，必须指向 extraResources
  // 平铺位 resources/app/studio；dev 形态显式钉 worktree 源码树，与 vite
  // dev（cwd=worktree 根）的缺省解析结果一致，行为不变。
  const studioBuiltinDir = app.isPackaged
    ? join(process.resourcesPath, 'app', 'studio')
    : join(__dirname, '..', '..', 'src', 'app', 'ai', 'pi-backend', 'studio')
  // OPENPENCIL_MCP_SOCKET / OPENPENCIL_MCP_DISCOVERY_PATH：host.ts 不隔离（单
  // 实例 + 平台默认路径）；Electron 同款——不注入则 sidecar 落平台默认路径。
  // full-smoke 通过 env 覆盖到 tmp 子目录即可隔离多 smoke 实例。
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENPENCIL_ROOT_DIR: rootDir,
    OPENPENCIL_STUDIO_BUILTIN_DIR: studioBuiltinDir
  }
  // P2 sidecar 解析基准——dev / spike 形态：相对 dist-main/ 的 dist-sidecar/
  // （__dirname 解析 main.mjs 所在目录）；打包形态：app.isPackaged=true 且
  // electron-builder extraResources 把 dist-sidecar 平铺到 resources/app/
  // 下，sidecar 的 ../native-externals/ 相对路径才能解析到随产物分发的
  // native-externals/ 子树。distDir 同款：dev 用项目根 dist/，打包形态用
  // resources/app/dist/（同上路径平铺约定）。
  const sidecarsDir = app.isPackaged
    ? join(process.resourcesPath, 'app', 'dist-sidecar')
    : join(__dirname, '..', 'dist-sidecar')
  const packedDistDir = app.isPackaged ? join(process.resourcesPath, 'app', 'dist') : distDir
  const bridge: SidecarHandle = {
    name: 'openpencil-bridge',
    modulePath: join(sidecarsDir, 'bridge.mjs'),
    env: {
      ...baseEnv,
      PORT: String(bridgePort),
      // bridge token 经 env 进 sidecar——与 index.html 注入的 token 同源
      OPENPENCIL_MCP_AUTH_TOKEN: bridgeToken,
      // spike-electron-spike：跨源兜底——页面在 loopback 端口（http://127.0.0.1:
      // <loopback>）发 fetch 到 bridge 端口（http://127.0.0.1:<bridge>），跨
      // 源；显式给 bridge CORS origin = 页面 origin，让预检通过。旧「空字符
      // 串禁用 cors middleware」在跨源 fetch 时会让浏览器预检 401，readAutomationHealth
      // 失败 → connectAutomation 永不 register → bridge /health 永 no_app。
      OPENPENCIL_MCP_CORS_ORIGIN: loopbackOrigin
    },
    healthUrl: `http://127.0.0.1:${bridgePort}/health`,
    current: null,
    stopping: false,
    restartCount: 0,
    restartTimer: null
  }
  const backend: SidecarHandle = {
    name: 'openpencil-pi-backend',
    modulePath: join(sidecarsDir, 'pi-backend.mjs'),
    env: {
      ...baseEnv,
      OPENPENCIL_PI_BACKEND_PORT: String(backendPort),
      OPENPENCIL_PI_TOKEN: piToken
    },
    healthUrl: `http://127.0.0.1:${backendPort}/health`,
    current: null,
    stopping: false,
    restartCount: 0,
    restartTimer: null
  }
  console.error(
    `[electron-main] sidecar 编排就绪（bridgePort=${bridgePort} backendPort=${backendPort}）`
  )
  return { bridge, backend, distDir: packedDistDir }
}

async function startLoopbackWithSidecars(distDir: string): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  // spike-electron-spike：先钉 loopback 端口（full-smoke 已用 OPENPENCIL_
  // LOOPBACK_PORT 注入；默认 0 = 选个空闲端口），再编排 sidecar——桥 CORS
  // origin 必须等于页面 origin（即 loopbackOrigin），跨源 fetch 才会放行。
  // 旧顺序「先 spawn bridge 再 listen loopback」会让 CORS origin 拿不到，
  // 跨源 fetch 预检 401，page-side readAutomationHealth 永远失败，桥 /health
  // 永 no_app。
  const reservedLoopbackPort = pinnedLoopbackPort > 0 ? pinnedLoopbackPort : await pickFreePort()
  const loopbackOrigin = `http://127.0.0.1:${reservedLoopbackPort}`

  // 1. 编排 sidecar——env 语义对齐 host.ts（端口 / token / discovery path 注入）
  const { bridge, backend, distDir: resolvedDistDir } = buildSidecars(distDir, loopbackOrigin)
  bridgeHandle = bridge
  backendHandle = backend
  spawnAndWatch(bridge)
  spawnAndWatch(backend)

  // 2. 等双方就绪（先 bridge，后 backend——backend 的 readDiscoveryFile 找的是
  // bridge 写出的 mcp.json；超时由 waitForHealth 内部打 warn，不抛）
  await new Promise<void>((r) => setTimeout(r, 100))
  // 直接 await handle 内部 ready 不行——buildSidecars 不暴露 Promise；用
  // 轮询 /health 替代（与 vite-plugin waitForHealth 等价）
  await waitForHealthUntil(bridge.healthUrl, HEALTH_TIMEOUT_MS, 'bridge')
  await waitForHealthUntil(backend.healthUrl, HEALTH_TIMEOUT_MS, 'pi-backend')

  // 3. 起回环服务。token / port 注入 createLoopbackServer；pinnedLoopbackPort
  // 由 OPENPENCIL_LOOPBACK_PORT 解析（full-smoke 钉住便于外部脚本探活）
  const { server, port } = await createLoopbackServer({
    distDir: resolvedDistDir,
    automationToken: bridgeToken,
    backendPort,
    piToken,
    port: reservedLoopbackPort
  })
  portFromState = port
  serverFromState = server
  console.error(`[electron-main] 回环服务就绪 http://127.0.0.1:${port}`)

  // 4. app quit 两段式 kill——注册到 before-quit 防止默认强杀孤儿
  app.on('before-quit', async (event) => {
    const globalScope = globalThis as { __opSidecarQuitting?: boolean }
    if (globalScope.__opSidecarQuitting) return
    globalScope.__opSidecarQuitting = true
    event.preventDefault()
    if (server) await new Promise<void>((r) => server.close(() => r()))
    await stopSidecar(backend)
    await stopSidecar(bridge)
    app.exit(0)
  })

  return { server, port }
}

async function waitForHealthUntil(url: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        console.error(`[electron-main] ${label} /health 200`)
        return
      }
    } catch {
      // 未就绪
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
  }
  console.warn(`[electron-main] ${timeoutMs}ms 内未等到 ${url} 就绪——继续执行，依赖首次调用触发复活`)
}

// ── main 入口 ──

// 模块态：当前主窗口引用——second-instance 事件里拿来 restore+focus；锁以
// 后第一次 new BrowserWindow 的实例写入；窗口 closed 时清回 null。
let primaryWindow: BrowserWindow | null = null

async function main(): Promise<void> {
  // P1.9.1 状态根 userData 化——app.setName 必须在 whenReady 之前调，否则
  // app.getPath('userData') 已按 package.json 名字（open-pencil-app）落盘，
  // 再 setName 已晚（路径缓存）。统一改名为 'open-pencil' 让 Windows 下
  // %APPDATA%/open-pencil、macOS 下 ~/Library/Application Support/open-pencil，
  // 与产品名一致且可读
  app.setName('open-pencil')

  // P0.5.2 单实例锁——必须在 whenReady 之前 requestSingleInstanceLock：
  //   1. 文档要求；2. 二实例启动 race 下第二个进程必须抢在 Electron 派发
  //   second-instance 之前判定锁，否则二实例会跳过主实例直接走自己流程。
  //
  // 绕过例外：smoke / full-smoke 模式（OPENPENCIL_SMOKE=1 / OPENPENCIL_
  // FULL_SMOKE=1）默认绕过——理由：
  //   (a) smoke 探针靠子进程监听 stdout，Electron 单实例锁会把「同一个
  //   userData 下的二实例」踢到主实例，二实例的 SMOKE_RESULT 行根本没
  //   人收，断言脚本会拿不到结果而误判。
  //   (b) full-smoke 每次跑会建独立 rootDir + 独立端口集合，逻辑上应当
  //   可以并存多实例。
  //   (c) CI 上若需真测单实例行为，spike 脚本尚未写——P2 后由测试侧补。
  // 此外保留 OPENPENCIL_DISABLE_SINGLE_INSTANCE=1 作为「我就是要开锁」的
  // 显式旁路（写死/双击图标时也可临时设）。
  const disableLock = readDisableSingleInstanceLock()
  if (!disableLock) {
    const got = app.requestSingleInstanceLock()
    if (!got) {
      // 二实例——Electron 默认会自动 quit，但显式调一次更稳（Electron
      // 28+ 行为有变，部分版本不再自动退出非 default event loop 实例）。
      console.error('[electron-main] 二实例抢锁失败，退出；既有实例会经 second-instance 事件拉回焦点')
      app.quit()
      return
    }
    // 一实例——监听二实例启动事件：恢复最小化窗口 + 抢焦点。打开 URL 等
    // 路由语义本项目暂不接（无 deep link 协议），仅做焦点兜底。
    app.on('second-instance', () => {
      const win = primaryWindow
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.focus()
    })
  }

  await app.whenReady()
  const devUrl = readElectronDevURL()
  const smokeMode = readSmokeMode()
  const fullSmokeMode = readFullSmokeMode()

  // full-smoke 模式：sidecar 编排 + 回环 + 隐藏窗 + 让出控制权给父脚本驱动
  // 探针（外部脚本读 FULL_SMOKE_RESULT 后自行 kill 本进程）
  if (fullSmokeMode) {
    const { server, port } = await startLoopbackWithSidecars(join(__dirname, '..', '..', 'dist'))
    const window = new BrowserWindow(baseWindowOptions({ show: false, webPreferences: { contextIsolation: true, sandbox: true } }))
    window.once('closed', () => { server.close(); if (primaryWindow === window) primaryWindow = null })
    attachWindowSafety(window, `http://127.0.0.1:${port}`)
    // full-smoke 不调 applySafeShow——探针靠 webContents.executeJavaScript 跑
    // 不依赖 ready-to-show，强行等会卡超时。
    await window.loadURL(`http://127.0.0.1:${port}`)
    const verdict = await runSmoke(window, false)
    console.log('[electron-main] FULL_SMOKE_RESULT', JSON.stringify(verdict.result))
    // 不调 app.exit——保留进程给父脚本操作 sidecar
    return
  }

  // 窗口默认可见（产品形态）。隐藏只剩两个场景：smoke 探针（smokeMode，
  // 探针不等 ready-to-show）与显式 OPENPENCIL_SHOW=0（无头调试）。
  // OPENPENCIL_SHOW=1 保留兼容，等价于缺省。
  const showWindow = readShowWindow()

  if (devUrl) {
    const window = new BrowserWindow(baseWindowOptions({ show: showWindow, webPreferences: { contextIsolation: true, sandbox: true } }))
    // P1.9.3 dev 形态也走窗口状态持久化（dev 调试的用户体验与产品形态对齐）
    restoreBounds(window, loadWindowState())
    persistBoundsOnClose(window)
    attachWindowSafety(window, devUrl)
    if (showWindow) applySafeShow(window)
    await window.loadURL(devUrl)
    if (smokeMode) {
      const verdict = await runSmoke(window, true)
      console.log('[electron-main] SMOKE_RESULT', JSON.stringify(verdict.result))
      app.exit(verdict.ok ? 0 : 1)
    }
    return
  }

  // 默认形态：sidecar + 回环 + 隐藏窗加载。关窗不杀 sidecar（与下一步
  // 「多窗口共享 sidecar」对齐），app quit 才杀
  const { server, port } = await startLoopbackWithSidecars(join(__dirname, '..', '..', 'dist'))
  const window = new BrowserWindow(baseWindowOptions({ show: showWindow, webPreferences: { contextIsolation: true, sandbox: true } }))
  // P1.9.3 恢复 + 关窗前持久化 bounds
  restoreBounds(window, loadWindowState())
  persistBoundsOnClose(window)
  window.once('closed', () => { server.close(); if (primaryWindow === window) primaryWindow = null })
  primaryWindow = window
  const loadUrl = `http://127.0.0.1:${port}`
  attachWindowSafety(window, loadUrl)
  if (showWindow) applySafeShow(window)
  await window.loadURL(loadUrl)
  if (smokeMode) {
    const verdict = await runSmoke(window, false)
    console.log('[electron-main] SMOKE_RESULT', JSON.stringify(verdict.result))
    app.exit(verdict.ok ? 0 : 1)
  }
}

// P1.9.4 关窗语义——macOS 习惯：关窗不退出（dock 图标保留）；activate 时若
// 无窗口则重建一个。其他平台按 OS 默认行为（window-all-closed → quit）。
// 不在 smoke 路径下注册：smoke 路径 BrowserWindow 直接调 app.exit(0/1)
// 走完，无需走 window-all-closed 路径；full-smoke 同理（隐藏探针不期望
// 关窗语义被干扰）。注册条件收敛到「dev url / 默认形态」分支
if (!readSmokeMode() && !readFullSmokeMode()) {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && primaryWindow === null) {
      // darwin dock 点击复活——重建一个默认窗口（不带 dev url；sidecar 复用
      // 既有 bridge/backend，避免重新 spawn 拉长恢复时延）
      rebuildPrimaryWindow()
    }
  })
}

// P1.9.4 darwin 复活主窗口——dev 形态：直接 new BrowserWindow + loadURL；
// 默认形态（sidecar 全家桶）：sidecar 句柄在 before-quit 之前持续存活，可
// 重 listen 回环服务复用既有 bridge/backend；但实现复杂度（bridge CORS origin
// 在 fork 时锁定，复用旧 loopback 端口不一定可用）超出本 spike 范围——P2
// 「多窗口共享 sidecar」会顺手处理。当前只覆盖 dev 形态；默认形态下若
// primaryWindow 被关且 primaryWindow 已 null，则 console.warn 让用户手动重启
function rebuildPrimaryWindow(): void {
  const devUrl = readElectronDevURL()
  if (devUrl) {
    const win = new BrowserWindow(baseWindowOptions({ show: true, webPreferences: { contextIsolation: true, sandbox: true } }))
    restoreBounds(win, loadWindowState())
    persistBoundsOnClose(win)
    attachWindowSafety(win, devUrl)
    applySafeShow(win)
    primaryWindow = win
    win.once('closed', () => { if (primaryWindow === win) primaryWindow = null })
    void win.loadURL(devUrl)
    return
  }
  console.warn('[electron-main] darwin activate：默认形态（sidecar 全家桶）的复活路径尚未实现，请手动重启 app')
}

// 全局兜底：Electron 对 main 进程的 uncaughtException 默认弹系统错误对话框
// （「A JavaScript error occurred in the main process」）——spike 期任何漏挂
// error 监听的流（proxyPi 之类）都不该以弹窗形式打扰用户， loudly 记日志即可
process.on('uncaughtException', (error) => {
  console.error(`[electron-main] uncaughtException（已吞，进程继续）：${error.stack ?? error.message}`)
})
process.on('unhandledRejection', (reason) => {
  console.error(`[electron-main] unhandledRejection（已吞，进程继续）：${reason instanceof Error ? reason.stack : String(reason)}`)
})

void main().catch((error) => { console.error(`[electron-main] ${error instanceof Error ? error.stack : String(error)}`); app.exit(1) })

// 导出供 spike:electron:full-smoke / 单元测试用
export { spawnAndWatch, stopSidecar, bridgeHandle, backendHandle, bridgePort, backendPort, bridgeToken, piToken }
export type { SidecarHandle }
