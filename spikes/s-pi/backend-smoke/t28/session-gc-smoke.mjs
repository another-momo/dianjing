/**
 * T28 会话 GC 冒烟（决策单 #2，owner 拍板 2026-08-25：归档不删除）。
 *
 * 全程不需要真实 LLM key：合成 pi JSONL fixture（../pi-session-fixture.mjs）
 * + 合成 index.json + dummy 凭据过 auth 预检（provider 随后失败无所谓——
 * GC 挂在铸新会话路径上，session 落盘即触发，provider 401 在其后）。
 *
 * 两相隔离验证两条规则（GC 触发点 = createSession，即 POST /api/pi-chat 新 sessionId）：
 *  A 数量规则：DIANJING_MAX_SESSIONS=3，4 条存量 + 1 条新建 → 最老 2 条归档
 *  B 年龄规则：DIANJING_MAX_SESSIONS=100（数量不触发），backdate 一条 mtime
 *    到 40 天前（默认 MAX_AGE_DAYS=30）→ 仅该条归档
 * 归档语义：移动到 <rootDir>/pi-sessions-archive/（保持文件名、不建索引），
 * index.json 同步除条；listSessionFamily 不含归档、readHistory 归档返回空、
 * 未归档会话不受影响。
 *
 * T28（决策单 #1）：后端全端点鉴权——token 从 tempRoot 文件读取（不打印），
 * 未鉴权请求断言 401。
 *
 * 运行：bun spikes/s-pi/backend-smoke/t28/session-gc-smoke.mjs（仓根）
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authHeaders, readBackendToken } from '../pi-backend-auth.mjs'
import { buildSessionJsonl } from '../pi-session-fixture.mjs'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
// 随机端口：固定端口曾被上一次崩溃残留的孤儿后端占用，健康检查误打旧实例
const PORT_A = 7710 + Math.floor(Math.random() * 200)
const PORT_B = PORT_A + 500 > 7989 ? PORT_A - 500 : PORT_A + 500
const BASE_A = `http://127.0.0.1:${PORT_A}`
const BASE_B = `http://127.0.0.1:${PORT_B}`

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

const PREFIX_C = `doc-${'c'.repeat(40)}`
const SID_A1 = `${PREFIX_C}-20260823T100000Z`
const SID_A2 = `${PREFIX_C}-20260823T110000Z`
const SID_A3 = `${PREFIX_C}-20260823T120000Z`
const SID_A4 = `${PREFIX_C}-20260823T130000Z`
const SID_NEW = `${PREFIX_C}-20260825T010000Z`
const SID_NEW2 = `${PREFIX_C}-20260825T020000Z`

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// ── 临时 rootDir + 4 条合成会话（mtime 递增：A1 最老 … A4 最新）
const tempRoot = mkdtempSync(join(tmpdir(), 't28-gc-'))
const sessionsDir = join(tempRoot, 'pi-sessions')
const archiveDir = join(tempRoot, 'pi-sessions-archive')
mkdirSync(sessionsDir, { recursive: true })
// pi-backend/studio/base.md：service 读盘需要
mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/studio'), { recursive: true })
copyFileSync(
  join(repoRoot, 'src/app/ai/pi-backend/studio/base.md'),
  join(tempRoot, 'src/app/ai/pi-backend/studio/base.md')
)

const USER_A3 = 'A3 会话的用户消息：保留我'
const fixtures = [
  { sid: SID_A1, file: 'gc-a1.jsonl', ageMs: 4 * HOUR, text: 'A1 会话的用户消息' },
  { sid: SID_A2, file: 'gc-a2.jsonl', ageMs: 3 * HOUR, text: 'A2 会话的用户消息' },
  { sid: SID_A3, file: 'gc-a3.jsonl', ageMs: 2 * HOUR, text: USER_A3 },
  { sid: SID_A4, file: 'gc-a4.jsonl', ageMs: 1 * HOUR, text: 'A4 会话的用户消息' }
]
const index = {}
for (const f of fixtures) {
  const p = join(sessionsDir, f.file)
  writeFileSync(
    p,
    buildSessionJsonl({
      id: f.sid,
      messages: [
        { role: 'user', text: f.text },
        { role: 'assistant', text: '好的。' }
      ]
    })
  )
  const mtime = new Date(Date.now() - f.ageMs)
  utimesSync(p, mtime, mtime)
  index[f.sid] = { file: p }
}
writeFileSync(join(sessionsDir, 'index.json'), JSON.stringify(index, null, 2))

// ── 起后端 helper（显式剔除真实 key 防环境泄漏干扰）
function spawnBackend(port, envExtra) {
  const backendEnv = {
    ...process.env,
    DIANJING_PI_BACKEND_PORT: String(port),
    DIANJING_ROOT_DIR: tempRoot,
    ...envExtra
  }
  delete backendEnv.OPENROUTER_API_KEY
  const proc = spawn('bun', ['run', join(repoRoot, 'src/app/ai/pi-backend/main.ts')], {
    cwd: tempRoot,
    env: backendEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let exited = false
  proc.on('exit', () => {
    exited = true
  })
  proc.stderr.on('data', (d) => process.stderr.write(`[backend:${port}] ${d}`))
  return { proc, isExited: () => exited }
}

async function waitHealth(base, isExited) {
  for (let i = 0; i < 60; i++) {
    if (isExited()) return false
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return true
    } catch {
      // 未就绪
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** POST /api/pi-chat 并排空 SSE（provider 失败=预期；30s 竞时兜底防挂死） */
async function sendPrompt(base, body, token) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${base}/api/pi-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok || !res.body) return `HTTP ${res.status}`
    const reader = res.body.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    return 'done'
  } catch (error) {
    return `aborted: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(base, path, token) {
  const res = await fetch(`${base}${path}`, { headers: token ? authHeaders(token) : {} })
  return { status: res.status, body: await res.json() }
}

function readIndexFile() {
  return JSON.parse(readFileSync(join(sessionsDir, 'index.json'), 'utf8'))
}

const backendA = spawnBackend(PORT_A, { DIANJING_MAX_SESSIONS: '3' })

try {
  check('A 后端就绪（MAX_SESSIONS=3）', await waitHealth(BASE_A, backendA.isExited))
  const tokenA = readBackendToken(tempRoot)
  check('T28 前置：token 文件可读', tokenA.length > 0)

  // T28 负向：未带 Authorization → 401
  const noAuth = await getJson(BASE_A, `/api/pi/sessions?docKey=${PREFIX_C}`)
  check('T28 负向：未鉴权请求 → 401', noAuth.status === 401, `status=${noAuth.status}`)

  // dummy 凭据过 pi auth 预检（写 tempRoot 自带 agentDir，不碰真实 .dianjing）
  const cred = await fetch(`${BASE_A}/api/pi/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(tokenA) },
    body: JSON.stringify({ providerId: 'openrouter', apiKey: 'sk-or-test-key-12345' })
  })
  check('前置：dummy 凭据写入（过 auth 预检用）', cred.ok)

  // ── A 相：铸新会话触发 GC——5 条 > 3，最老 A1/A2 归档
  const drainA = await sendPrompt(
    BASE_A,
    {
      sessionId: SID_NEW,
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: [{ role: 'user', parts: [{ type: 'text', text: '触发 GC' }] }]
    },
    tokenA
  )
  check('A 相：新会话 prompt 排空（provider 失败不影响 GC）', drainA === 'done', drainA)

  check(
    'A 相：A1/A2 移动到 archive（保持文件名）',
    existsSync(join(archiveDir, 'gc-a1.jsonl')) && existsSync(join(archiveDir, 'gc-a2.jsonl'))
  )
  check(
    'A 相：sessionsDir 不再含 A1/A2，仍含 A3/A4',
    !existsSync(join(sessionsDir, 'gc-a1.jsonl')) &&
      !existsSync(join(sessionsDir, 'gc-a2.jsonl')) &&
      existsSync(join(sessionsDir, 'gc-a3.jsonl')) &&
      existsSync(join(sessionsDir, 'gc-a4.jsonl'))
  )
  check(
    'A 相：sessionsDir 剩余 3 条会话（阈值归一）',
    readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')).length === 3
  )
  const indexA = readIndexFile()
  check(
    'A 相：index 除条 A1/A2，保留 A3/A4/新会话',
    !(SID_A1 in indexA) &&
      !(SID_A2 in indexA) &&
      SID_A3 in indexA &&
      SID_A4 in indexA &&
      SID_NEW in indexA,
    JSON.stringify(Object.keys(indexA))
  )
  const familyA = await getJson(BASE_A, `/api/pi/sessions?docKey=${PREFIX_C}`, tokenA)
  const idsA = (familyA.body.sessions ?? []).map((s) => s.sessionId)
  check(
    'A 相：listSessionFamily 不含归档（A1/A2 消失，剩 3 条最新在前）',
    idsA.length === 3 && idsA[0] === SID_NEW && !idsA.includes(SID_A1) && !idsA.includes(SID_A2),
    JSON.stringify(idsA)
  )
  const histA1 = await getJson(BASE_A, `/api/pi/history?sessionId=${SID_A1}`, tokenA)
  check(
    'A 相：readHistory 已归档 sessionId 返回空（前端按无历史处理）',
    histA1.status === 200 && histA1.body.messages?.length === 0,
    JSON.stringify(histA1.body).slice(0, 120)
  )
  const histA3 = await getJson(BASE_A, `/api/pi/history?sessionId=${SID_A3}`, tokenA)
  const histA3Texts = (histA3.body.messages ?? [])
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  check('A 相：未归档会话 A3 历史不受影响', histA3Texts.includes(USER_A3))
  check('A 相：archive 目录不建索引', !existsSync(join(archiveDir, 'index.json')))

  // ── B 相：年龄规则隔离——MAX_SESSIONS=100（数量不触发），backdate A3 到 40 天前
  const a3Path = join(sessionsDir, 'gc-a3.jsonl')
  const old = new Date(Date.now() - 40 * DAY)
  utimesSync(a3Path, old, old)

  const backendB = spawnBackend(PORT_B, { DIANJING_MAX_SESSIONS: '100' })
  try {
    check('B 后端就绪（MAX_SESSIONS=100）', await waitHealth(BASE_B, backendB.isExited))
    // B 后端同 tempRoot——token 文件被 B 覆写，重读
    const tokenB = readBackendToken(tempRoot)
    const drainB = await sendPrompt(
      BASE_B,
      {
        sessionId: SID_NEW2,
        // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
        model: { providerId: 'openrouter', modelId: 'openrouter/free' },
        messages: [{ role: 'user', parts: [{ type: 'text', text: '触发 GC' }] }]
      },
      tokenB
    )
    check('B 相：新会话 prompt 排空', drainB === 'done', drainB)

    check(
      'B 相：仅超龄 A3 归档（数量规则未触发）',
      existsSync(join(archiveDir, 'gc-a3.jsonl')) &&
        !existsSync(join(sessionsDir, 'gc-a3.jsonl')) &&
        existsSync(join(sessionsDir, 'gc-a4.jsonl')),
      `sessions=${readdirSync(sessionsDir).join(',')}`
    )
    const indexB = readIndexFile()
    check('B 相：index 除条 A3，保留 A4/新会话', !(SID_A3 in indexB) && SID_A4 in indexB && SID_NEW2 in indexB)
    const histA3Archived = await getJson(BASE_B, `/api/pi/history?sessionId=${SID_A3}`, tokenB)
    check('B 相：readHistory 超龄归档 sessionId 返回空', histA3Archived.body.messages?.length === 0)
    const familyB = await getJson(BASE_B, `/api/pi/sessions?docKey=${PREFIX_C}`, tokenB)
    const idsB = (familyB.body.sessions ?? []).map((s) => s.sessionId)
    check(
      'B 相：listSessionFamily 不含超龄归档（A3 消失，A4/新会话在）',
      !idsB.includes(SID_A3) && idsB.includes(SID_A4) && idsB.includes(SID_NEW2),
      JSON.stringify(idsB)
    )
  } finally {
    await stopBackend(backendB.proc)
  }
} finally {
  await stopBackend(backendA.proc)
  // Windows：bun run 会再起子进程，进程树退出 + cwd 句柄释放都有延迟——rmSync 重试
  await new Promise((r) => setTimeout(r, 500))
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}

async function stopBackend(proc) {
  if (!proc.pid || proc.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    proc.kill('SIGTERM')
  }
  await new Promise((resolve) => {
    proc.once('exit', resolve)
    setTimeout(resolve, 3000)
  })
  if (proc.exitCode === null && process.platform !== 'win32') {
    proc.kill('SIGKILL')
    await new Promise((resolve) => {
      proc.once('exit', resolve)
      setTimeout(resolve, 2000)
    })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
