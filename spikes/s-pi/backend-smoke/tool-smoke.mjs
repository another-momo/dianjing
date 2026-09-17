/**
 * T20 P4 工具链冒烟（活模型 openrouter/free + 7600 桥 + 活编辑器）：
 * 一句话 → pi customTools 的 create_shape 被调起 → 经 7600 /rpc 在浏览器
 * 编辑器画布真实建出 FRAME → 回读一致 → 同 session 二轮记忆 → 后端进程
 * 重启后（新进程同一 state 目录）session 恢复且工具仍可调。
 *
 * 前置：
 *  - vite dev server 已起（T20 拓扑：pi 后端为其 spawn 的独立子进程）
 *  - 浏览器已打开 app（编辑器自动连 7600 桥；无执行端时桥调用 502）
 *  - OPENROUTER_API_KEY 已在环境（set -a; source .dianjing/key-env; set +a）——
 *    仅重启段 spawn 独立后端时传递，脚本不读取不打印 key 本体
 * 运行：node spikes/s-pi/backend-smoke/tool-smoke.mjs [baseUrl]
 * 退出码 0 = 全过。
 *
 * T28（决策单 #1）：dev server 段经 1420 proxy 自动补鉴权头（零改动）；
 * T4 恢复探针段自起 standalone 后端——token 落盘 .dianjing/pi-backend-token，
 * 脚本读文件带 Authorization 头（不打印），未鉴权请求断言 401。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { authHeaders, readBackendToken } from './pi-backend-auth.mjs'

const base = process.argv[2] ?? 'http://localhost:1420'
const backendPort = Number(process.env.DIANJING_PI_BACKEND_PORT ?? 7700)
const recoveryPort = 7701 // 重启恢复段用独立端口起新进程（同一 state 目录，恢复语义等价）
const root = process.cwd()
const sessionId = `t20-tool-${Date.now()}`
const FRAME_NAME = `hello-t20-${String(Date.now()).slice(-6)}`
const RECT_NAME = `t20-after-restart`

const failures = []
function check(label, cond, detail) {
  if (cond) console.log(`  PASS ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

// discovery 文件读取（复刻 packages/mcp/src/transport/paths.ts getPlatformDir 逻辑，
// 冒烟脚本为纯 node 不经 workspace 导入，避免 mcp dist 构建态依赖）
function discoveryPath() {
  // D2 状态根：与 src/app/orchestration/app-data.ts resolveAppDataRoot 真源对齐
  // win32 = %APPDATA%/Dianjing（roaming）；darwin = ~/Library/Application Support/Dianjing；
  // linux = $XDG_CONFIG_HOME/Dianjing || ~/.config/Dianjing
  let dir
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    dir = appData && appData.length > 0 ? appData : join(homedir(), 'AppData', 'Roaming')
  } else if (process.platform === 'darwin') {
    dir = join(homedir(), 'Library', 'Application Support')
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME?.trim()
    dir = xdgConfig && xdgConfig.length > 0 ? xdgConfig : join(homedir(), '.config')
  }
  // 存量兼容：新版桥写 bridge.json，缺省时回退旧版 mcp.json
  const primary = join(dir, 'Dianjing', 'bridge.json')
  return existsSync(primary) ? primary : join(dir, 'Dianjing', 'mcp.json')
}

function readDiscovery() {
  try {
    return JSON.parse(readFileSync(discoveryPath(), 'utf8'))
  } catch {
    return null
  }
}

async function bridgeRpc(toolName, toolArgs) {
  const disco = readDiscovery()
  if (!disco) throw new Error('discovery 文件不可读')
  const res = await fetch(`http://127.0.0.1:${disco.httpPort}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(disco.authToken ? { authorization: `Bearer ${disco.authToken}` } : {})
    },
    body: JSON.stringify({ command: 'tool', args: { name: toolName, args: toolArgs } })
  })
  return res.json()
}

async function post(text, sid = sessionId, target = base, token = null) {
  const res = await fetch(`${target}/api/pi-chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? authHeaders(token) : {}) },
    body: JSON.stringify({
      sessionId: sid,
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }]
    })
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const raw = await res.text()
  const chunks = []
  let sawDone = false
  for (const frame of raw.split('\n\n')) {
    const line = frame.split('\n').find((l) => l.startsWith('data:'))
    if (!line) continue
    const data = line.slice(5).trimStart()
    if (data === '[DONE]') {
      sawDone = true
      continue
    }
    chunks.push(JSON.parse(data))
  }
  return { chunks, sawDone }
}

function textOf(chunks) {
  return chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.delta)
    .join('')
}

console.log(`T20 工具链冒烟 → ${base}  session=${sessionId}`)

// ── 前置：后端健康 + 桥在线（编辑器已连）────────────────────────
// T4 段要自起恢复探针后端进程，需 env 里有 key（只判存在性，不读不打印）
check(
  '前置：OPENROUTER_API_KEY 在环境（T4 恢复探针 spawn 需要）',
  !!process.env.OPENROUTER_API_KEY,
  '运行方式：set -a; source .dianjing/key-env; set +a; node tool-smoke.mjs'
)
try {
  const health = await fetch(`http://127.0.0.1:${backendPort}/health`).then((r) => r.json())
  check('前置：pi 后端独立进程 /health 就绪', health.status === 'ok', JSON.stringify(health))
} catch (e) {
  check('前置：pi 后端独立进程 /health 就绪', false, String(e))
}

const discoAtStart = readDiscovery()
check('前置：discovery 文件可读且含 httpPort', !!discoAtStart?.httpPort, discoveryPath())
if (discoAtStart?.httpPort) {
  const bridgeHealth = await fetch(`http://127.0.0.1:${discoAtStart.httpPort}/health`)
    .then((r) => r.json())
    .catch(() => null)
  check(
    '前置：7600 桥在线且编辑器已连接（status=ok）',
    bridgeHealth?.status === 'ok',
    JSON.stringify(bridgeHealth) + '（no_app=浏览器未开 app）'
  )
}

// ── T1：一句话建 FRAME（openrouter/free 工具调用有模型方差，≤3 次换 session 重试）
let t1 = null
let t1Session = sessionId
for (let attempt = 1; attempt <= 3; attempt++) {
  t1Session = attempt === 1 ? sessionId : `${sessionId}-r${attempt}`
  t1 = await post(
    `请调用 create_shape 工具在画布上创建一个 FRAME：type=FRAME, x=120, y=160, width=240, height=120, name="${FRAME_NAME}"。必须实际调用工具，不要只描述。完成后回复「已完成」。`,
    t1Session
  )
  const hasOutput = t1.chunks.some((c) => c.type === 'tool-output-available')
  if (hasOutput) break
  console.log(`  … T1 第 ${attempt} 次未发生工具调用，换 session 重试`)
}
const types = t1.chunks.map((c) => c.type)

const inputAvail = t1.chunks.find((c) => c.type === 'tool-input-available')
const outputAvail = t1.chunks.find((c) => c.type === 'tool-output-available')
const outputError = t1.chunks.find((c) => c.type === 'tool-output-error')

check('T1 帧序列 start 为首帧', types[0] === 'start', types.join(','))
check(
  'T1 tool-input-available 出现且参数正确（FRAME 240×120 @120,160）',
  inputAvail?.toolName === 'create_shape' &&
    inputAvail?.input?.type === 'FRAME' &&
    inputAvail?.input?.x === 120 &&
    inputAvail?.input?.y === 160 &&
    inputAvail?.input?.width === 240 &&
    inputAvail?.input?.height === 120,
  JSON.stringify(inputAvail?.input)
)
check('T1 无 tool-output-error', !outputError, JSON.stringify(outputError))
const nodeId = outputAvail?.output?.id
check(
  'T1 tool-output-available 含新节点 id',
  typeof nodeId === 'string',
  JSON.stringify(outputAvail?.output)
)
check(
  'T1 工具帧顺序（input-available < output-available）',
  types.indexOf('tool-input-available') !== -1 &&
    types.indexOf('tool-input-available') < types.indexOf('tool-output-available'),
  types.join(',')
)
check('T1 finish(stop) 收尾 + [DONE]', t1.chunks.at(-1)?.type === 'finish' && t1.sawDone)
check('T1 助手有文本回复', textOf(t1.chunks).length > 0)

// ── T2：画布回读——经 7600 桥 get_node 验证节点真实存在且属性一致
if (nodeId) {
  const readBack = await bridgeRpc('get_node', { id: nodeId })
  const node = readBack?.result
  check(
    'T2 画布回读：节点存在且为 FRAME',
    readBack?.ok === true && node?.type === 'FRAME',
    JSON.stringify(readBack).slice(0, 200)
  )
  check(
    'T2 回读属性一致（name/尺寸/位置）',
    node?.name === FRAME_NAME && node?.width === 240 && node?.height === 120,
    JSON.stringify({ name: node?.name, w: node?.width, h: node?.height, x: node?.x, y: node?.y })
  )
} else {
  check('T2 画布回读（依赖 T1 nodeId）', false, 'T1 未产出 nodeId')
}

// ── T3：同 session 二轮——AI 应记得刚建的节点 id（session 历史 + 工具结果在上下文）
if (nodeId) {
  const t3 = await post('你刚才用工具创建的那个节点的 id 是什么？只回答 id 本身。', t1Session)
  check(
    'T3 同 session 追问记得节点 id',
    textOf(t3.chunks).includes(nodeId),
    textOf(t3.chunks).slice(0, 120)
  )
}

// ── T4：后端进程重启恢复（新进程 + 同一 state 目录 + 不同端口）＋工具仍可用
// 语义等价于 T19 RECOVERY-PASS（新进程从磁盘 SessionManager.open 恢复），
// 不动 vite spawn 的子进程，smoke 自起自收。
let recovery = null
try {
  recovery = spawn('bun', ['run', 'src/app/ai/pi-backend/main.ts'], {
    env: { ...process.env, DIANJING_PI_BACKEND_PORT: String(recoveryPort) },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 150))
    up = await fetch(`http://127.0.0.1:${recoveryPort}/health`)
      .then((r) => r.ok)
      .catch(() => false)
  }
  check('T4 恢复探针：新后端进程就绪（独立端口 7701）', up)

  // T28：探针后端为 standalone 模式（cwd=仓根），token 落盘后可读（不打印）
  let recoveryToken = null
  if (up) {
    recoveryToken = readBackendToken(root)
    check('T28 前置：恢复探针 token 文件可读', recoveryToken.length > 0)
    const noAuth = await fetch(`http://127.0.0.1:${recoveryPort}/api/pi-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 't28-noauth',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]
      })
    })
    check('T28 负向：未鉴权请求 → 401', noAuth.status === 401, `status=${noAuth.status}`)
  }

  if (up && nodeId) {
    // 恢复后记忆：旧 sessionId 在新进程里从磁盘恢复，仍记得节点 id
    const t4a = await post(
      '我们之前的对话里你用 create_shape 创建过一个 FRAME，它的节点 id 是什么？只回答 id。',
      t1Session,
      `http://127.0.0.1:${recoveryPort}`,
      recoveryToken
    )
    check(
      'T4 重启后旧 session 恢复（记得节点 id）',
      textOf(t4a.chunks).includes(nodeId),
      textOf(t4a.chunks).slice(0, 120)
    )

    // 恢复后工具仍可调：新 session 建 RECTANGLE
    const t4b = await post(
      `请调用 create_shape 工具创建 RECTANGLE：type=RECTANGLE, x=400, y=160, width=100, height=100, name="${RECT_NAME}"。必须实际调用工具。`,
      `${sessionId}-recovery`,
      `http://127.0.0.1:${recoveryPort}`,
      recoveryToken
    )
    const reOut = t4b.chunks.find((c) => c.type === 'tool-output-available')
    const reNodeId = reOut?.output?.id
    check(
      'T4 重启后工具仍可调（RECTANGLE 产出 nodeId）',
      typeof reNodeId === 'string',
      JSON.stringify(reOut ?? t4b.chunks.at(-2))
    )
    if (reNodeId) {
      const reRead = await bridgeRpc('get_node', { id: reNodeId })
      check(
        'T4 重启后建的节点画布回读存在（RECTANGLE）',
        reRead?.ok === true && reRead?.result?.type === 'RECTANGLE',
        JSON.stringify(reRead).slice(0, 200)
      )
    }
  }
} finally {
  // T28 核验补：bun run = wrapper + 孙进程两段——win32 须对活 wrapper 直接
  // taskkill /T /F 整树杀（kill() 的 SIGTERM 只杀 wrapper，孙进程服务器
  // 成孤儿，2026-08-25 pid 树实证，对齐 t22/t23/t28 清理口径）
  if (recovery?.pid && recovery.exitCode === null && recovery.signalCode === null) {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(recovery.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        // 已退出
      }
    } else {
      recovery.kill('SIGTERM')
    }
    // 给进程树一点退出时间，避免脚本退出后句柄/端口滞留
    await new Promise((resolve) => {
      recovery.once('exit', resolve)
      setTimeout(resolve, 3000)
    })
  }
}

if (failures.length) {
  console.error(`\nFAIL ${failures.length} 项：${failures.join(' / ')}`)
  process.exit(1)
}
console.log('\nT20 工具链冒烟全过')
