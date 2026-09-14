/**
 * Electron spike：对**打包产物**（dist-sidecar/*.mjs）而非源码的冒烟。
 * 思路同 craft-agents-oss packages/pi-agent-server/src/bundle-smoke.test.ts：
 * 仓外临时目录 + 系统 node（不是 bun）spawn，驱动真实 HTTP 链路。
 *
 * 验收点：
 *  1. 两个 sidecar 产物在系统 node 下启动，/health 均 200（bridge 无 app
 *     时为 200 {status:'no_app'}）
 *  2. pi-backend 最小 agent 链路：写假凭据（POST /api/pi/credentials）→
 *     catalog 确认 configured → POST /api/pi-chat 到确定性失败点——
 *     errorText 命中 401/网络层错误（证明凭据解析→请求构建链路在 bundle
 *     形态完整），且不出现单文件打包回归标记（Cannot find module /
 *     No API key found / OAuth auth derivation failed）
 *  3. bridge /rpc 负向路径：无 app 附挂时 502（RPC 管线活着，只是不可达）
 *  4. rootDir env 化生效：状态落在 OPENPENCIL_ROOT_DIR 而非 cwd
 *
 * 端口自律：随机高位端口（20000-49000），绝不碰 1420/7600/7700。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pickFreePort } from '../tools/ports.js'

const here = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const root = join(here, '..', '..')
const distDir = join(here, '..', 'dist-sidecar')

// gitleaks 已白名单的 dummy key（tests/e2e 先例，见 zones P43）
const DUMMY_OPENROUTER_KEY = 'sk-or-test-key-12345'

// 单文件打包回归标记——出现即判失败（craft-agents-oss 实证坑型）
const REGRESSION_MARKERS = [
  'Cannot find module',
  'ERR_MODULE_NOT_FOUND',
  'No API key found',
  'OAuth auth derivation failed'
]
// 确定性失败点标记——证明链路走到凭据解析→请求构建→HTTP 发出
const TERMINAL_PATTERN =
  /401|unauthorized|invalid[_ ]api|no auth credentials|incorrect api key|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|timed out/i

const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status === 200) return true
    } catch {
      // 未就绪，重试
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

function killTree(child: ChildProcess): void {
  try {
    child.kill('SIGTERM')
  } catch {
    // 已退出
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已退出
    }
  }, 2000).unref()
}

async function main(): Promise<void> {
  // 0. 前置：产物存在（缺则先构建——与 craft beforeAll 同款）
  const piBundle = join(distDir, 'pi-backend.mjs')
  const bridgeBundle = join(distDir, 'bridge.mjs')
  if (!existsSync(piBundle) || !existsSync(bridgeBundle)) {
    console.log('[smoke] dist-sidecar 产物缺失，先跑 spike:sidecar:build')
    const build = spawnSync(process.execPath, ['run', 'spike:sidecar:build'], {
      cwd: root,
      stdio: 'inherit'
    })
    if (build.status !== 0) throw new Error('sidecar build failed')
  }

  // 被测进程必须是系统 node，不是 bun
  const nodeProbe = spawnSync('node', ['-p', 'process.versions.bun ?? "node"'], {
    encoding: 'utf8'
  })
  const nodeKind = (nodeProbe.stdout ?? '').trim()
  check('系统 node 可用且非 bun', nodeKind === 'node', `node -p 探测结果: ${nodeKind}`)

  const scratch = mkdtempSync(join(tmpdir(), 'openpencil-sidecar-smoke-'))
  const piRoot = join(scratch, 'pi-root')
  const bridgeDiscovery = join(scratch, 'bridge', 'mcp.json')
  const piPort = await pickFreePort()
  const bridgePort = await pickFreePort()
  const piToken = 'smoke-pi-token-32hex-padding00'
  const bridgeToken = 'smoke-bridge-token'
  console.log(`[smoke] scratch=${scratch} piPort=${piPort} bridgePort=${bridgePort}`)

  const children: ChildProcess[] = []
  let piLog = ''
  let bridgeLog = ''
  try {
    // 1. spawn 两个产物（cwd=scratch，仓外——证明产物不依赖 cwd 解析仓库文件）
    const piEnv = { ...process.env }
    delete piEnv.OPENROUTER_API_KEY // 确定性：凭据只走 API 写入的假 key
    const pi = spawn('node', [piBundle], {
      cwd: scratch,
      env: {
        ...piEnv,
        OPENPENCIL_ROOT_DIR: piRoot,
        OPENPENCIL_PI_BACKEND_PORT: String(piPort),
        OPENPENCIL_PI_TOKEN: piToken
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.push(pi)
    pi.stdout.on('data', (c) => (piLog += c))
    pi.stderr.on('data', (c) => (piLog += c))

    const bridge = spawn('node', [bridgeBundle], {
      cwd: scratch,
      env: {
        ...process.env,
        PORT: String(bridgePort),
        OPENPENCIL_MCP_DISCOVERY_PATH: bridgeDiscovery,
        OPENPENCIL_MCP_AUTH_TOKEN: bridgeToken
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.push(bridge)
    bridge.stdout.on('data', (c) => (bridgeLog += c))
    bridge.stderr.on('data', (c) => (bridgeLog += c))

    // 2. /health 均 200
    const piBase = `http://127.0.0.1:${piPort}`
    const bridgeBase = `http://127.0.0.1:${bridgePort}`
    check('pi-backend /health 200', await waitForHealth(`${piBase}/health`, 20_000))
    check('bridge /health 200', await waitForHealth(`${bridgeBase}/health`, 20_000))
    if (failures.length) throw new Error('health check failed, aborting')

    const bridgeHealth = (await (await fetch(`${bridgeBase}/health`)).json()) as {
      status?: string
      authRequired?: boolean
    }
    check(
      'bridge /health 语义（no_app + authRequired）',
      bridgeHealth.status === 'no_app' && bridgeHealth.authRequired === true,
      JSON.stringify(bridgeHealth)
    )

    // 3. 写假凭据 → catalog 确认 configured（bundle 内 ModelRuntime.login 链路）
    const authHeaders = { authorization: `Bearer ${piToken}`, 'content-type': 'application/json' }
    const credRes = await fetch(`${piBase}/api/pi/credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ providerId: 'openrouter', apiKey: DUMMY_OPENROUTER_KEY })
    })
    check('POST /api/pi/credentials 200', credRes.status === 200, `status=${credRes.status}`)

    check(
      '凭据落盘在 OPENPENCIL_ROOT_DIR 下（rootDir env 生效）',
      existsSync(join(piRoot, '.openpencil', 'pi-agent', 'auth.json'))
    )

    const catalog = (await (await fetch(`${piBase}/api/pi/catalog`, { headers: authHeaders })).json()) as {
      providers?: Array<{ id: string; auth?: { configured?: boolean } }>
    }
    const openrouter = catalog.providers?.find((p) => p.id === 'openrouter')
    check(
      'GET /api/pi/catalog openrouter configured=true',
      openrouter?.auth?.configured === true,
      JSON.stringify(openrouter?.auth)
    )

    // 4. bridge /rpc 负向：无 app 附挂 → 502（传输不可达，RPC 管线本身活着）
    const rpcRes = await fetch(`${bridgeBase}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'smoke_noop', arguments: {} })
    })
    check('bridge /rpc 无 app → 502', rpcRes.status === 502, `status=${rpcRes.status}`)

    // 5. 最小 agent 链路：prompt 到确定性失败点。
    // 注意：终端模型错误（stopReason:'error' + errorMessage）落在会话 JSONL
    // 的 assistant message 上，SSE 只发 start/finish（mapping.ts 现状，
    // 源码形态同构——已用 bun 直跑 main.ts 对照实证），因此失败点断言
    // 读会话记录而非 SSE。
    const chatRes = await fetch(`${piBase}/api/pi-chat`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        sessionId: 'sidecar-bundle-smoke',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
      })
    })
    check('POST /api/pi-chat 200 (SSE 开流)', chatRes.status === 200, `status=${chatRes.status}`)
    const sseBody = await chatRes.text()
    check(
      'SSE 流式链路完整（start + finish）',
      sseBody.includes('"type":"start"') && sseBody.includes('"type":"finish"')
    )

    // 会话记录：stopReason=error 的 assistant message 携带 errorMessage
    const sessionsDir = join(piRoot, '.openpencil', 'pi-sessions')
    check('pi-sessions 目录创建（会话持久化链路）', existsSync(sessionsDir))
    let sessionErrorMessage = ''
    if (existsSync(sessionsDir)) {
      const jsonl = readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .at(-1)
      if (jsonl) {
        for (const line of readFileSync(join(sessionsDir, jsonl), 'utf8').trim().split('\n')) {
          try {
            const entry = JSON.parse(line) as {
              message?: { role?: string; stopReason?: string; errorMessage?: string }
            }
            if (entry.message?.role === 'assistant' && entry.message.stopReason === 'error') {
              sessionErrorMessage = entry.message.errorMessage ?? ''
            }
          } catch {
            // 非 message 行（session/model_change 头）跳过
          }
        }
      }
    }
    check('会话记录出现 terminal error（stopReason=error）', sessionErrorMessage.length > 0)
    const regressionHit = REGRESSION_MARKERS.find(
      (m) => sseBody.includes(m) || piLog.includes(m) || sessionErrorMessage.includes(m)
    )
    check('无单文件打包回归标记', regressionHit === undefined, regressionHit ?? '')
    check(
      '失败点落在凭据解析→请求构建之后（401/网络层）',
      TERMINAL_PATTERN.test(sessionErrorMessage),
      sessionErrorMessage.slice(0, 300)
    )
  } finally {
    for (const child of children) killTree(child)
    // 等子进程退出再清理 scratch（Windows 文件锁）
    await new Promise((r) => setTimeout(r, 1500))
    rmSync(scratch, { recursive: true, force: true })
    if (piLog && failures.length) console.log(`--- pi-backend log tail ---\n${piLog.slice(-2000)}`)
    if (bridgeLog && failures.length)
      console.log(`--- bridge log tail ---\n${bridgeLog.slice(-1000)}`)
  }

  if (failures.length) {
    console.error(`\n[smoke] FAILED (${failures.length}):`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('\n[smoke] all checks passed')
}

main().catch((error) => {
  console.error(`[smoke] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
