/**
 * T87：pi 原生 skill 支持端到端冒烟——capabilities ON + fixture skill 落盘
 * + POST /skill:<name> <text> → 后端 SDK 宿主侧 _expandSkillCommand 展开
 *  → 第一条 user message 形如 `<skill name="...">...正文...</skill>...<args>`。
 *
 * 端到端不依赖真实 LLM key：
 *  - dummy key 经凭据路由写入（过 pi auth 预检）
 *  - provider 调用随后 401/失败无所谓——展开发生在 session.prompt() 入栈前
 *    （host-side），与 provider 调用并行（run 还没跑到 prompt turn）。
 *  - 用户消息落 JSONL 后经 GET /api/pi/history 回读，断言展开块标记。
 *
 * 运行：bun spikes/s-pi/backend-smoke/t87/skill-toggle-smoke.mjs（仓根）
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authHeaders, readBackendToken } from '../pi-backend-auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../')
const PORT = 5793 // 避开 t22/t23/t24/t28 常用段
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

async function waitHealth(base, exited) {
  for (let i = 0; i < 60; i++) {
    if (exited()) return false
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
    await res.text() // SSE → [DONE]
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ── fixture：内置 studio 资产集复制 + 一份 fixture skill
// （用户层单源 <rootDir>/workspace/.agents/skills，2026-09-18 userdata 重排）
const tempRoot = mkdtempSync(join(tmpdir(), 't87-skill-'))
mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/studio'), { recursive: true })
copyFileSync(
  join(repoRoot, 'src/app/ai/pi-backend/studio/base.md'),
  join(tempRoot, 'src/app/ai/pi-backend/studio/base.md')
)
// 2026-09-16：base.md 声明 references/render-jsx.md——复制清单补 'references'
for (const sub of ['workflows', 'profiles', 'references']) {
  const srcDir = join(repoRoot, 'src/app/ai/pi-backend/studio', sub)
  const dstDir = join(tempRoot, 'src/app/ai/pi-backend/studio', sub)
  mkdirSync(dstDir, { recursive: true })
  cpSync(srcDir, dstDir, { recursive: true })
}
mkdirSync(join(tempRoot, 'pi-agent'), { recursive: true })

// 单源 fixture — 仅落一份 <rootDir>/workspace/.agents/skills/t87-demo/SKILL.md
// （resolveSkillsDir 归位 workspace/.agents/ 下随行）
const userSkillDir = join(tempRoot, 'workspace', '.agents', 'skills', 't87-demo')
mkdirSync(userSkillDir, { recursive: true })
writeFileSync(
  join(userSkillDir, 'SKILL.md'),
  [
    '---',
    'name: t87-demo',
    'description: T87 端到端冒烟 fixture',
    '---',
    '',
    'T87_SKILL_PROBE_USER_BODY',
    ''
  ].join('\n'),
  'utf8'
)

// ── 起后端
const backendEnv = {
  ...process.env,
  DIANJING_PI_BACKEND_PORT: String(PORT),
  DIANJING_ROOT_DIR: tempRoot,
  PI_PROMPT_PROBE_DIR: join(tempRoot, 'probe')
}
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

const ready = await waitHealth(BASE, () => backendExited)
if (!ready) {
  console.error('  ✗ 后端未就绪')
  backend.kill()
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(1)
}

try {
  const token = readBackendToken(tempRoot)

  // ── ① 缺省 DEFAULTS（2026-09-18 翻转 readonly+true）：agentSkills 缺省 ON，
  //    fixture skill 就位 → manifest.skills 即含 t87-demo；OFF 态由 ④ 显式关验证
  const m0 = await (
    await fetch(`${BASE}/api/pi/studio/manifest`, { headers: authHeaders(token) })
  ).json()
  check(
    'T87 端到端①：缺省 capabilities ON → manifest.skills 含 fixture t87-demo',
    m0.capabilities?.agentSkills === true &&
      m0.capabilities?.builtinTools === 'readonly' &&
      (m0.skills ?? []).some((s) => s.name === 't87-demo'),
    JSON.stringify({ capabilities: m0.capabilities, skills: m0.skills })
  )

  // ── ② PUT ON → manifest.skills 出现单源 fixture（T89：双源改单源）
  const put = await fetch(`${BASE}/api/pi/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ agentSkills: true })
  })
  const cap = await put.json()
  check(
    'T87 端到端②：PUT agentSkills=true → 200 + 返 true',
    put.ok && cap.agentSkills === true,
    JSON.stringify(cap)
  )

  const m1 = await (
    await fetch(`${BASE}/api/pi/studio/manifest`, { headers: authHeaders(token) })
  ).json()
  const names = (m1.skills ?? []).map((s) => s.name).sort()
  check(
    'T87 端到端②：manifest.skills 含单源 fixture（仅 t87-demo）且脱敏（无 filePath/baseDir）',
    names.length === 1 &&
      names[0] === 't87-demo' &&
      m1.skills.every((s) => !('filePath' in s) && !('baseDir' in s)),
    JSON.stringify(m1.skills)
  )

  // ── ③ dummy 凭据 + POST /skill:t87-demo <text> → 第一条 user message 含展开块
  const cred = await fetch(`${BASE}/api/pi/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ providerId: 'openrouter', apiKey: 'sk-or-smoke-key-12345' })
  })
  check('T87 端到端③：dummy 凭据写入（过 auth 预检）', cred.ok)

  const sessionId = 't87-smoke-session-' + Date.now()
  const ok = await sendPrompt(
    BASE,
    {
      sessionId,
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '/skill:t87-demo T87_USER_ARG_HELLO' }] }
      ]
    },
    token
  )
  check('T87 端到端③：POST /skill:t87-demo <text> → 200（SSE 收尾）', ok)

  // ── ④ 经 history 端点回读 user message，断言展开块含 SKILL.md 正文
  const histRes = await fetch(`${BASE}/api/pi/history?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: authHeaders(token)
  })
  const hist = await histRes.json()
  check(
    'T87 端到端④：history 端点返 200 + sessionId 命中',
    histRes.ok && hist.sessionId === sessionId,
    JSON.stringify({ status: histRes.status, sessionId: hist.sessionId })
  )
  const userMessage = (hist.messages ?? []).find((m) => m.role === 'user')
  const userText = (userMessage?.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
  check(
    'T87 端到端④：user message 包含 <skill name="t87-demo"> 展开块',
    userText.includes('<skill name="t87-demo"'),
    userText.slice(0, 240)
  )
  check(
    'T87 端到端④：user message 包含 SKILL.md 正文（T87_SKILL_PROBE_USER_BODY）',
    userText.includes('T87_SKILL_PROBE_USER_BODY'),
    userText.slice(0, 240)
  )
  check(
    'T87 端到端④：user message 含用户原文（/skill:t87-demo 后参数）',
    userText.includes('T87_USER_ARG_HELLO'),
    userText.slice(0, 240)
  )

  // ── ⑤ PUT OFF → 再发消息（不带 /skill 前缀；OFF 态下 SDK 不展开）
  await fetch(`${BASE}/api/pi/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ agentSkills: false })
  })
  const sessionId2 = 't87-smoke-off-' + Date.now()
  await sendPrompt(
    BASE,
    {
      sessionId: sessionId2,
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'OFF 态普通文本' }] }]
    },
    token
  )
  const hist2 = await (
    await fetch(`${BASE}/api/pi/history?sessionId=${encodeURIComponent(sessionId2)}`, {
      headers: authHeaders(token)
    })
  ).json()
  const offUserText = ((hist2.messages ?? []).find((m) => m.role === 'user')?.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
  check(
    'T87 端到端⑤：OFF 态新建会话 user message = 原文本（不展开、无 <skill 块）',
    offUserText.includes('OFF 态普通文本') && !offUserText.includes('<skill'),
    offUserText.slice(0, 240)
  )
} finally {
  backend.kill('SIGKILL')
  // Windows EBUSY 缓冲——后端进程退出 + 文件句柄释放需要几秒
  await new Promise((r) => setTimeout(r, 2000))
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch (e) {
    // Windows 偶发 EBUSY 残留——临时目录交给 OS 清理（不冒烟断言）
    console.warn('tempRoot 清理告警：', e instanceof Error ? e.message : String(e))
  }
}

console.log(`\n  ${pass} pass / ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
