/**
 * T33 生产编排器（localhost 分发骨架）：vite dev server 客串的编排职责的生产
 * 形态入口。`bun run build && bun run serve` 一条链起完整产品——静态编辑器 +
 * pi 后端 + MCP 工具桥，浏览器打开即用。
 *
 * 职责（对齐两个 vite 插件的行为，env 语义刻意复制而非共享导入——automation
 * 面在 pendingReclass 区且有「只允许相对导入」约束，重分类仪式未到不动它；
 * 复制面各约 10 行，来源注释见 spawnBridge/spawnBackend）：
 *  1. spawn 自动化桥（src/app/bridge/server/index.ts，TCP 7600 + token）
 *  2. spawn pi 后端（src/app/ai/pi-backend/main.ts，7700 + token env 注入）
 *  3. 托管 dist/（MIME 表 + SPA fallback），index.html 注入桥 token 运行时
 *     全局（配合 bridge/runtime.ts P104 的 window.__DIANJING_RUNTIME_AUTOMATION_TOKEN__
 *     hook——上游生产形态靠 Tauri 读 discovery 文件，web 形态无该通道）
 *  4. 反代 /api/pi* → 127.0.0.1:7700 并注入 Bearer（流式管道透传，SSE 不缓冲；
 *     仅客户端主动断连才销毁上游——正常 SSE 收尾不杀，chat abort 语义与
 *     vite proxy 一致；pipe 双侧 error 守卫防 EPIPE 杀进程）
 *
 * 端口：主服务 DIANJING_SERVE_PORT（默认 8080）；子进程沿用既有常量
 * 7600/7700。与 vite dev 互斥（同端口冲突时子进程 EADDRINUSE 文案已有）。
 * key 卫生：token 只经 env 进子进程 / 经注入脚本进同源页面，不落日志。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

import { AUTOMATION_HTTP_PORT } from '@open-pencil/core/constants'

import { readDiscoveryFile } from '@/app/bridge/server/discovery'
import { getSocketPath, platformHasUnixSockets } from '@/app/bridge/server/paths'
import { readPiBackendPort, readServePort } from '@/app/orchestration/env'
import { waitForHealthPolling } from '@/app/orchestration/health'
import { attachStderrPassthrough, stopChildGracefully } from '@/app/orchestration/lifecycle'
import { RUNTIME_AUTOMATION_TOKEN_KEY } from '@/app/orchestration/runtime-globals'
import { generateToken } from '@/app/orchestration/token'

import { PI_BACKEND_DEFAULT_PORT } from './config'

// D2：状态根收口——host 进程自身没有状态根（旧 rootDir 唯一消费者是 dist
// 解析基准）；状态根由 backend 子进程 main.ts 走 resolveAppDataRoot 单源
// 解析，与 dev / Electron 三形态同源（旧「cwd 即仓根」隐式契约随之消亡）。
// distDir 维持相对工作目录解析（`bun run build && bun run serve` 仍按仓根
// 跑，dist/ 是构建产物约定落点）。
const distDir = resolve(process.cwd(), 'dist')
const servePort = readServePort()
const backendPort = readPiBackendPort(PI_BACKEND_DEFAULT_PORT)
// CORS/WS 都按主服务来源放行（浏览器跨源 fetch 桥 /health 需要它）
const serveOrigin = `http://localhost:${servePort}`

const automationToken = generateToken()
const piToken = generateToken()

// ── 子进程编排（语义复制自 automation/bridge/vite-plugin.ts startChild）──

let bridge: ChildProcess | null = null
let backend: ChildProcess | null = null

function passthroughStderr(child: ChildProcess, label: string): void {
  attachStderrPassthrough(child, {
    label,
    onEaddrinuse: () => {
      console.error(
        `[host] ${label} 端口绑定失败（可能另一个点睛设计实例/dev server 正在运行）——先停掉占用 ${AUTOMATION_HTTP_PORT}/${backendPort} 的进程`
      )
      child.kill()
    }
  })
}

async function stopChild(child: ChildProcess | null, label: string): Promise<void> {
  if (!child) return
  await stopChildGracefully(child, { timeoutMs: 2_000 })
  console.error(`[host] ${label} 已停止`)
}

async function spawnBridge(): Promise<void> {
  // env 语义复制自 automation/bridge/vite-plugin.ts createAutomationEnvironment
  // （鉴权开、corsOrigin 指向宿主来源）
  //
  // T34 评估：跟不跟 DIANJING_MCP_DISCOVERY_PATH 隔离（0f981ff2）？
  // 不跟——host.ts 自身是生产形态，7600 端口独占（serveOrigin 也固定），
  // 多实例会被端口 EADDRINUSE 拦截，不存在 dev-plugin 同款「worktree 隔离」
  // 场景。discovery 默认路径 `~/.dianjing/mcp.json` 在 host.ts 单实例下不
  // 构成冲突；若未来扩成同主机多 host.ts 实例，再补 DIANJING_MCP_DISCOVERY_PATH
  // 临时目录隔离——届时复用 vite-plugin 的 sha256(runtimeId) 方案即可。
  const socketPath = platformHasUnixSockets() ? await getSocketPath() : null
  bridge = spawn('bun', ['run', 'src/app/bridge/server/index.ts'], {
    stdio: ['ignore', 'inherit', 'pipe'],
    env: {
      ...process.env,
      PORT: String(AUTOMATION_HTTP_PORT),
      ...(socketPath ? { DIANJING_MCP_SOCKET: socketPath } : {}),
      DIANJING_MCP_AUTH_TOKEN: automationToken,
      DIANJING_MCP_CORS_ORIGIN: serveOrigin
    }
  })
  bridge.on('error', (err) => console.error(`[host] 无法 spawn 自动化桥：${err.message}`))
  if (bridge.stderr) passthroughStderr(bridge, '自动化桥')
}

async function spawnBackend(): Promise<void> {
  // env 语义复制自 ai/pi-backend/vite-plugin.ts spawnBackend
  backend = spawn('bun', ['run', 'src/app/ai/pi-backend/main.ts'], {
    stdio: ['ignore', 'inherit', 'pipe'],
    env: {
      ...process.env,
      DIANJING_PI_BACKEND_PORT: String(backendPort),
      DIANJING_PI_TOKEN: piToken
    }
  })
  backend.on('error', (err) => console.error(`[host] 无法 spawn pi 后端：${err.message}`))
  if (backend.stderr) passthroughStderr(backend, 'pi 后端')
}

// ── 就绪探针 ──

async function waitFor(
  label: string,
  timeoutMs: number,
  probe: () => Promise<boolean>
): Promise<void> {
  await waitForHealthPolling({
    intervalMs: 200,
    timeoutMs,
    // host.ts 历史语义：探针内异常不视作失败（连接拒绝属预期），但要打 warn
    // 以便排查；waitForHealthPolling 默认 catch 静默——这里在 probe 内部吞
    // 异常并打 warn，保持行为一致
    probe: async () => {
      try {
        return await probe()
      } catch (error) {
        console.warn(
          `[host] ${label} 探针异常（继续等待）：${error instanceof Error ? error.message : String(error)}`
        )
        return false
      }
    },
    onTimeout: () => {
      throw new Error(
        `[host] ${timeoutMs}ms 内未等到 ${label} 就绪——查看上方子进程日志定位启动失败原因`
      )
    }
  })
}

async function backendReadyProbe(): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${backendPort}/health`)
  return res.ok
}

async function bridgeReadyProbe(): Promise<boolean> {
  return (await readDiscoveryFile()) !== null
}

// ── 静态托管（dist/ + SPA fallback + index.html token 注入）──

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
}

/** index.html 前置注入运行时桥 token（bridge/runtime.ts P104 消费；dev 构建无此需求但注入无害） */
function withRuntimeToken(html: string): string {
  const script = `<script>window.${RUNTIME_AUTOMATION_TOKEN_KEY}=${JSON.stringify(automationToken)}</script>`
  const headIndex = html.indexOf('<head>')
  if (headIndex === -1) return script + html
  return html.slice(0, headIndex + 6) + script + html.slice(headIndex + 6)
}

function sendFile(res: ServerResponse, filePath: string): void {
  res.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
  })
  // 读失败（权限/竞态删除）转 500，不让未捕获流错误炸进程
  const stream = createReadStream(filePath)
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
  stream.pipe(res)
}

function isInsideDist(filePath: string): boolean {
  const relative = normalize(filePath).slice(distDir.length)
  return !relative.startsWith('..') && !normalize(filePath).startsWith('..')
}

// ── /api/pi 反代（流式；语义对齐 vite proxy + Bearer 注入）──

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer'
])

function proxyPi(req: IncomingMessage, res: ServerResponse): void {
  const headers: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key)) headers[key] = value
  }
  headers.authorization = `Bearer ${piToken}`
  headers.host = `127.0.0.1:${backendPort}`
  const upstream = httpRequest(
    { host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers },
    (up) => {
      // 客户端在等上游响应期间断开（页面刷新/设置面板切换取消在途请求）：
      // res 已销毁，writeHead/pipe 会抛 ERR_STREAM_DESTROYED / EPIPE——直接弃流
      if (res.destroyed) {
        up.destroy()
        return
      }
      // 上游的 hop-by-hop 头不回写（transfer-encoding 由 node 按流自动处理）
      const responseHeaders: Record<string, string | string[] | undefined> = {}
      for (const [key, value] of Object.entries(up.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(key)) responseHeaders[key] = value
      }
      res.writeHead(up.statusCode ?? 502, responseHeaders)
      // pipe 不转发错误：两侧各自挂 error 监听，否则客户端中途断连时写失败
      // 会冒成 uncaughtException 杀掉 host 进程（Electron 版 proxyPi 实测踩中）
      up.on('error', (error) => {
        console.error(
          `[host] /api/pi 上游响应流错误：${error instanceof Error ? error.message : String(error)}`
        )
        if (!res.destroyed) res.destroy()
      })
      up.pipe(res) // 逐 chunk 透传——SSE 不缓冲
    }
  )
  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    if (!res.writableEnded) {
      res.end(`pi 后端不可达（${error instanceof Error ? error.message : String(error)}）`)
    }
  })
  // 客户端 socket 写失败（EPIPE 典型）——吞掉并断上游，不冒泡
  res.on('error', () => upstream.destroy())
  // 仅客户端主动断连（res 未正常结束）才销毁上游；SSE 正常结尾时 pipe 完成
  // 也会触发 res.close，无条件销毁会把跑到一半的 chat 杀掉（Electron 版踩过）
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
  req.pipe(upstream)
}

// ── host 主服务 ──

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  // 前缀语义对齐 vite proxy 的 '/api/pi'：含 /api/pi-chat 等连字符路由
  if (urlPath.startsWith('/api/pi')) {
    proxyPi(req, res)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const filePath = normalize(join(distDir, urlPath))
  if (!isInsideDist(filePath)) {
    res.writeHead(403).end()
    return
  }
  const servePath = existsAsFile(filePath) ? filePath : join(distDir, 'index.html')
  const isIndex = servePath === join(distDir, 'index.html')
  if (isIndex && extname(urlPath) !== '' && urlPath !== '/' && !existsAsFile(filePath)) {
    // 带扩展名但不存在的资源不做 SPA fallback（真实 404）
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found')
    return
  }
  if (isIndex) {
    // index.html 每次现读现注 token（文件小，且避免缓存陈旧 token）
    const html = readFileSyncSafe(servePath)
    if (html === null) {
      res.writeHead(500).end()
      return
    }
    res.writeHead(200, { 'content-type': MIME_TYPES['.html'] })
    res.end(withRuntimeToken(html))
    return
  }
  sendFile(res, servePath)
}

function existsAsFile(filePath: string): boolean {
  try {
    // 目录也满足 R_OK——必须 stat 显式排除（T33 冒烟实证：'/' 曾致 EISDIR 崩溃）
    return statSync(filePath).isFile()
  } catch {
    // 不可读/不存在即 false——静态分派的常规路径
    // oxlint-disable-next-line open-pencil/no-silent-catch
    return false
  }
}

function readFileSyncSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    // 读 index 失败 → 调用方转 500 出声，此处无需重复日志
    // oxlint-disable-next-line open-pencil/no-silent-catch
    return null
  }
}

function main(): void {
  if (!existsAsFile(join(distDir, 'index.html'))) {
    console.error('[host] dist/index.html 不存在——先跑 bun run build 再 bun run serve')
    process.exit(1)
  }
  void (async () => {
    await spawnBridge()
    await spawnBackend()
    await waitFor('自动化桥（discovery 文件）', 15_000, bridgeReadyProbe)
    console.error(`[host] 自动化桥就绪（127.0.0.1:${AUTOMATION_HTTP_PORT}）`)
    await waitFor(`pi 后端（/health @ ${backendPort}）`, 15_000, backendReadyProbe)
    console.error(`[host] pi 后端就绪（127.0.0.1:${backendPort}）`)
    const server = createServer(handleRequest)
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`[host] 端口 ${servePort} 已被占用——换 DIANJING_SERVE_PORT 或停掉占用进程`)
      } else {
        console.error(`[host] 启动失败：${error.message}`)
      }
      void shutdown()
      process.exitCode = 1
    })
    server.listen(servePort, '127.0.0.1', () => {
      console.error(`[host] 点睛设计已就绪 → ${serveOrigin}`)
      console.error('[host] Ctrl+C 退出（级联停止后端与工具桥）')
    })
  })().catch((error: unknown) => {
    console.error(`[host] 启动失败：${error instanceof Error ? error.message : String(error)}`)
    void shutdown()
    process.exitCode = 1
  })
}

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await stopChild(backend, 'pi 后端')
  await stopChild(bridge, '自动化桥')
}
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)))
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)))

main()
