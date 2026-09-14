/**
 * T23 会话族谱清单冒烟（T23-plan E1，验收 B1/B2 的后端半）。
 *
 * 全程不需要 LLM key：会话族谱由合成 pi JSONL（../pi-session-fixture.mjs，
 * T28 自含化——不再依赖本机 .dianjing/pi-sessions 既有文件）+ 合成
 * index.json 键构造，直接打 GET /api/pi/sessions 验证：
 *  ① docKey 前缀返回族内全部会话（A 族两条），倒序最新在前
 *  ① 字段齐：sessionId/title（首条用户消息截断 40 字）/messageCount/updatedAtMs
 *  ① 未知前缀与缺参 → 空数组；非 GET → 405
 *  ② 全程只读（index.json 与各 JSONL 内容、mtime 不变）
 *  ④ 族谱隔离（B 族只列 B 会话；异构旧键不误捕）
 *
 * T28（决策单 #1）：后端全端点鉴权——从 tempRoot 的 token 文件读 bearer
 * 带 Authorization 头；未鉴权请求断言 401。
 *
 * 运行：bun spikes/s-pi/backend-smoke/t23/sessions-smoke.mjs（仓根）
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

// ── fixture：合成 pi JSONL（A 族两个会话 + B 族一个）
// A2 首条用户消息刻意超过 40 字符，验证 title 截断口径
const USER_A1 = 'A 族旧会话的用户消息：把背景改成蓝色'
const USER_A2 = 'A 族新会话的用户消息，这句话故意写得超过四十个字符用来验证标题截断口径'
const USER_B = 'B 族的用户消息：营销海报来一版'

const fileA1 = 'fx-a1.jsonl'
const fileA2 = 'fx-a2.jsonl'
const fileB = 'fx-b.jsonl'

// readPiHistoryFile 的折叠口径：toolResult 独立条目并入 assistant 工具卡，
// thinking 跳过——折叠后消息数 = user + assistant 条目数
function foldedMessageCount(file) {
  return readFileSync(join(sessionsDir, file), 'utf8')
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false
      const entry = JSON.parse(line)
      return (
        entry.type === 'message' &&
        (entry.message?.role === 'user' || entry.message?.role === 'assistant')
      )
    }).length
}

// ── 临时 rootDir + 合成会话族谱
const tempRoot = mkdtempSync(join(tmpdir(), 't23-sessions-'))
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
      { role: 'assistant', text: '好的，已改蓝。' }
    ]
  })
)
writeFileSync(
  join(sessionsDir, fileA2),
  buildSessionJsonl({
    id: 'fx-a2',
    messages: [
      { role: 'user', text: USER_A2 },
      { role: 'assistant', thinking: '先想尺寸', text: '我来创建。' },
      {
        role: 'assistant',
        toolCall: { id: 'call_fx_a2', name: 'create_shape', arguments: { type: 'FRAME' } }
      },
      { role: 'toolResult', toolCallId: 'call_fx_a2', toolName: 'create_shape', text: 'Created FRAME (id=0:3)', details: { id: '0:3' } },
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

const a1User = USER_A1
const a2User = USER_A2

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
const jsonlBefore = new Map(
  [fileA1, fileA2, fileB].map((f) => {
    const p = join(sessionsDir, f)
    return [f, { content: readFileSync(p, 'utf8'), mtimeMs: statSync(p).mtimeMs }]
  })
)

// ── 起后端（无 LLM 调用，env 无需 key；显式剔除防环境泄漏干扰）
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

async function getSessions(query, token) {
  const res = await fetch(`${BASE}/api/pi/sessions${query ? `?${query}` : ''}`, {
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
  const noAuth = await getSessions(`docKey=${PREFIX_A}`)
  check('T28 负向：未鉴权请求 → 401', noAuth.status === 401, `status=${noAuth.status}`)

  // ── B1 族谱清单
  const family = await getSessions(`docKey=${PREFIX_A}`, token)
  const sessions = family.body.sessions ?? []
  check('① A 族返回两条会话', sessions.length === 2, JSON.stringify(sessions.map((s) => s.sessionId)))
  check(
    '① 倒序最新在前（A2 先于 A1）',
    sessions[0]?.sessionId === SID_A2 && sessions[1]?.sessionId === SID_A1
  )
  const sA2 = sessions.find((s) => s.sessionId === SID_A2)
  check(
    '① 字段齐（title/messageCount/updatedAtMs）',
    Boolean(
      sA2 && typeof sA2.title === 'string' && sA2.messageCount > 0 && sA2.updatedAtMs > 0
    ),
    JSON.stringify(sA2)
  )
  check(
    '① title = 首条用户消息截断 40 字',
    Boolean(a2User && sA2 && sA2.title === a2User.slice(0, 40)),
    `${sA2?.title} vs ${a2User?.slice(0, 40)}`
  )
  check(
    '① messageCount = 折叠后消息数（user+assistant 条目）',
    sA2?.messageCount === foldedMessageCount(fileA2),
    `${sA2?.messageCount} vs ${foldedMessageCount(fileA2)}`
  )

  const unknown = await getSessions(`docKey=doc-${'z'.repeat(40)}`, token)
  check('① 未知前缀 → 空数组', unknown.body.sessions?.length === 0)
  const missing = await getSessions('', token)
  check('① 缺 docKey 参 → 空数组', missing.status === 200 && missing.body.sessions?.length === 0)
  // T28：405 断言须带鉴权头（未鉴权会先被 401 拦下）
  const posted = await fetch(`${BASE}/api/pi/sessions?docKey=${PREFIX_A}`, {
    method: 'POST',
    headers: authHeaders(token)
  })
  check('① 非 GET → 405', posted.status === 405)

  // ── ④ 隔离
  const familyB = await getSessions(`docKey=${PREFIX_B}`, token)
  check(
    '④ B 族只列 B 会话（异构旧键不误捕）',
    familyB.body.sessions?.length === 1 && familyB.body.sessions[0]?.sessionId === SID_B
  )

  // ── B2 只读
  check(
    '② 全程只读（index.json 内容不变）',
    readFileSync(join(sessionsDir, 'index.json'), 'utf8') === indexBefore
  )
  check(
    '② 全程只读（JSONL 内容与 mtime 不变）',
    [...jsonlBefore.entries()].every(([f, before]) => {
      const p = join(sessionsDir, f)
      return (
        readFileSync(p, 'utf8') === before.content && statSync(p).mtimeMs === before.mtimeMs
      )
    })
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
