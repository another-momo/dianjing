/**
 * T22 历史回填 + 会话族谱冒烟（T22-plan D2/D3，验收 A1/A3/A6 的后端半）。
 *
 * 全程不需要 LLM key：会话族谱由合成 pi JSONL（../pi-session-fixture.mjs，
 * T28 自含化——不再依赖本机 .dianjing/pi-sessions 既有文件）+ 合成
 * index.json 键构造，直接打 GET /api/pi/history 验证：
 *  ① docKey 前缀解析族内最新会话（时间戳后缀字典序）
 *  ② 历史回填内容保真（user/assistant 文本 + 工具卡片折叠，reasoning 不回填）
 *  ③ sessionId 精确读取
 *  ④ 异族/未知前缀隔离
 *  ⑤ GET 全程只读（index.json 内容不变）
 *
 * T28（决策单 #1）：后端全端点鉴权——从 tempRoot 的 token 文件读 bearer
 * 带 Authorization 头；未鉴权请求断言 401。
 *
 * 运行：bun spikes/s-pi/backend-smoke/t22/history-smoke.mjs（仓根）
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authHeaders, readBackendToken } from '../pi-backend-auth.mjs'
import { buildSessionJsonl } from '../pi-session-fixture.mjs'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
// 随机端口：固定端口曾被上一次崩溃残留的孤儿后端占用，健康检查误打旧实例
const PORT = 7710 + Math.floor(Math.random() * 200)
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

// ── ① fixture：合成 pi JSONL（A 族两个会话 + B 族一个；A2 含 toolCall/toolResult
// 与 thinking part——覆盖工具卡片折叠 + reasoning 不回填两个断言面）
const USER_A1 = 'A 族旧会话的用户消息：请把卡片的背景改成蓝色'
const USER_A2 = 'A 族新会话的用户消息：创建一个 240×120 的 FRAME'
const USER_B = 'B 族的用户消息：营销海报文案来一版'
const TOOL_A2 = 'create_shape'

const fileA1 = 'fx-a1.jsonl'
const fileA2 = 'fx-a2.jsonl'
const fileB = 'fx-b.jsonl'

// ── ② 临时 rootDir + 合成会话族谱
const tempRoot = mkdtempSync(join(tmpdir(), 't22-history-'))
const sessionsDir = join(tempRoot, 'pi-sessions')
mkdirSync(sessionsDir, { recursive: true })
// pi-backend/studio/base.md：service 读盘需要（本冒烟不触发 prompt，仅为启动完整）
mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/studio'), { recursive: true })
copyFileSync(
  join(repoRoot, 'src/app/ai/pi-backend/studio/base.md'),
  join(tempRoot, 'src/app/ai/pi-backend/studio/base.md')
)

writeFileSync(
  join(sessionsDir, fileA1),
  buildSessionJsonl({
    id: 'fx-a1',
    messages: [
      { role: 'user', text: USER_A1 },
      { role: 'assistant', text: '好的，已改成蓝色。' }
    ]
  })
)
writeFileSync(
  join(sessionsDir, fileA2),
  buildSessionJsonl({
    id: 'fx-a2',
    messages: [
      { role: 'user', text: USER_A2 },
      { role: 'assistant', thinking: '先确认尺寸再建', text: '我来创建。' },
      {
        role: 'assistant',
        toolCall: { id: 'call_fx_a2', name: TOOL_A2, arguments: { type: 'FRAME', width: 240, height: 120 } }
      },
      { role: 'toolResult', toolCallId: 'call_fx_a2', toolName: TOOL_A2, text: 'Created FRAME (id=0:3)', details: { id: '0:3' } },
      { role: 'assistant', text: '已完成' }
    ]
  })
)
writeFileSync(
  join(sessionsDir, fileB),
  buildSessionJsonl({
    id: 'fx-b',
    messages: [
      { role: 'user', text: USER_B },
      { role: 'assistant', text: '给你一版。' }
    ]
  })
)

// 断言期望值的别名（合成 fixture 内容即常量，无需回读解析）
const a1User = USER_A1
const a2User = USER_A2
const a2Tool = TOOL_A2
const bUser = USER_B

const PREFIX_A = `doc-${'a'.repeat(40)}`
const PREFIX_B = `doc-${'b'.repeat(40)}`
const SID_A1 = `${PREFIX_A}-20260823T100000Z`
const SID_A2 = `${PREFIX_A}-20260823T110000Z`
const SID_B = `${PREFIX_B}-20260823T120000Z`
const index = {
  [SID_A1]: { file: join(sessionsDir, fileA1) },
  [SID_A2]: { file: join(sessionsDir, fileA2) },
  [SID_B]: { file: join(sessionsDir, fileB) },
  // 异构旧键：前缀过滤不得误捕
  'smoke-legacy-unrelated': { file: join(sessionsDir, fileA1) }
}
writeFileSync(join(sessionsDir, 'index.json'), JSON.stringify(index, null, 2))
const indexBefore = readFileSync(join(sessionsDir, 'index.json'), 'utf8')

// ── ③ 起后端（无 LLM 调用，env 无需 key；显式剔除防环境泄漏干扰）
// D2：后端状态根不再跟 cwd——显式 override 钉 tempRoot（直指根本身）
const backendEnv = { ...process.env, DIANJING_PI_BACKEND_PORT: String(PORT), DIANJING_ROOT_DIR: tempRoot }
delete backendEnv.OPENROUTER_API_KEY
const backend = spawn('bun', ['run', join(repoRoot, 'src/app/ai/pi-backend/main.ts')], {
  cwd: tempRoot,
  env: backendEnv,
  stdio: ['ignore', 'pipe', 'pipe']
})
let backendExited = false
backend.on('exit', () => {
  backendExited = true
})
backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    if (backendExited) return false // 启动即死（如端口占用），不误打别的实例
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return true
    } catch {
      // 未就绪
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function getHistory(query, token) {
  const res = await fetch(`${BASE}/api/pi/history?${query}`, {
    headers: token ? authHeaders(token) : {}
  })
  return { status: res.status, body: await res.json() }
}

try {
  check('后端就绪', await waitHealth())

  // T28：standalone 后端 token 落盘后可读（只进请求头，不打印）
  const token = readBackendToken(tempRoot)
  check('T28 前置：token 文件可读', typeof token === 'string' && token.length > 0)

  // T28 负向：未带 Authorization → 401
  const noAuth = await getHistory(`docKey=${PREFIX_A}`)
  check('T28 负向：未鉴权请求 → 401', noAuth.status === 401, `status=${noAuth.status}`)

  // ── ④ 断言
  const latest = await getHistory(`docKey=${PREFIX_A}`, token)
  check('① docKey 前缀解析回族内最新 sessionId', latest.body.sessionId === SID_A2)

  const texts = (latest.body.messages ?? [])
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  check('② 回填含 A2 用户消息文本', Boolean(a2User && texts.includes(a2User.slice(0, 30))))

  const toolParts = (latest.body.messages ?? [])
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === `tool-${a2Tool}`)
  check('② 工具卡片折叠（tool-<name> part 存在）', toolParts.length > 0)
  check(
    '② 工具结果折叠为 output-available 且带 output',
    toolParts.some((p) => p.state === 'output-available' && p.output != null)
  )
  check(
    '② reasoning 不回填',
    !(latest.body.messages ?? [])
      .flatMap((m) => m.parts ?? [])
      .some((p) => p.type === 'reasoning')
  )

  const exact = await getHistory(`sessionId=${SID_A1}`, token)
  const exactTexts = (exact.body.messages ?? [])
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  check(
    '③ sessionId 精确读取 A1 历史',
    exact.body.sessionId === SID_A1 && Boolean(a1User && exactTexts.includes(a1User.slice(0, 30)))
  )

  const other = await getHistory(`docKey=${PREFIX_B}`, token)
  const otherTexts = (other.body.messages ?? [])
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  check(
    '④ B 族解析到 B 会话且不含 A 内容',
    other.body.sessionId === SID_B &&
      Boolean(bUser && otherTexts.includes(bUser.slice(0, 30))) &&
      !(a2User && otherTexts.includes(a2User.slice(0, 30)))
  )

  const none = await getHistory(`docKey=doc-${'z'.repeat(40)}`, token)
  check(
    '④ 未知前缀 → 空族（sessionId null + messages []）',
    none.body.sessionId === null && none.body.messages?.length === 0
  )

  check(
    '⑤ GET 全程只读（index.json 内容不变）',
    readFileSync(join(sessionsDir, 'index.json'), 'utf8') === indexBefore
  )
} finally {
  // Windows：bun run 会再起子进程，进程树退出 + cwd 句柄释放都有延迟——
  // kill 树（taskkill /T）→ 等 exit（3s 兜底）→ 额外等待 → rmSync 重试
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    backend.kill('SIGTERM')
  }
  await new Promise((resolve) => {
    backend.once('exit', resolve)
    setTimeout(resolve, 3000)
  })
  await new Promise((r) => setTimeout(r, 500))
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
