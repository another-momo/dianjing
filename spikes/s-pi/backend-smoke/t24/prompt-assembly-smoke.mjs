/**
 * T60（Phase 3 W3/T-B9）active_design 宿主路由 + 每回合组装冒烟——
 * 前身 = T24 prompt 四层装配冒烟（chatMode 链随 T60 退役，C1/C2/C3 旧断言
 * 整体改写为单槽语义）。
 *
 * 全程不需要真实 LLM key：
 *  - POST /api/pi/credentials 写 dummy key 过 pi 的 auth 预检（agent-session.js
 *    hasConfiguredAuth 拦截在 before_agent_start 之前——无 key 钩子根本不 fire）
 *  - 后端 env PI_PROMPT_PROBE_DIR=<tempRoot>/probe 开启探针 extension（登记在
 *    装配 extension 之后，runner 链式语义下 event.systemPrompt 即最终注入值，
 *    每 run 覆写 last-system-prompt.md）
 *  - provider 调用随后 401/断网失败无所谓——探针文件在 before_agent_start
 *    时已落盘；SSE 读到 error/finish 即收
 *
 * 断言（冒烟环境无浏览器 → 桥不可达 → 恒空槽组装；有槽/移槽判定归 bun 层
 * tests/engine/rebuild/pi-backend/active-design-host.test.ts）：
 *  C1 空槽组装：探针 == base.md body + 按需参考索引节 byte 级一致（无 workflow
 *     段、无 profile、无 cwd 尾巴——钩子 per-run 整体替换，baked 基底不露面；
 *     2026-09-16 起 base.md 声明 references，索引节每回合追加，见下方常量注释）
 *  C2 新建意图信封：首行剥离 → 历史里用户消息 = 剥离后文本（信封不进 JSONL）；
 *     表单作答信封不剥离（AI 须读答案原文）
 *  C3 兼容窗：请求面残留 chatMode/pickedProfileId 字段忽略不报错（正常进 run，
 *     组装口径同 C1）
 *  端点 POST /api/pi/active-design：401 未鉴权 / 405 非 POST / 400 坏体 /
 *     502 bridge_unavailable（无桥环境显式失败，红线 #8 不静默）
 *  路由 GET /api/pi/studio/manifest 形状 + 脱敏（无正文/无绝对路径）+ 405
 *  T87：manifest 透传 capabilities/skills 字段（缺省态）；capabilities 端点
 *   GET 缺省 DEFAULTS / PUT ON-OFF 往返 / 负向 400 / 未鉴权 401
 *
 * T45（S4 W1 / T-A3）改源：种子 config.yaml → studio 文件注册表（workflows/
 * + profiles/ 复制进 tempRoot）；端点更名 /api/pi/studio/manifest，契约改为
 * modes + profiles（摘要）+ failures（相对路径）。
 * T46（S4 W1 / T-A5）：base.md 落位——资产后端 failures 收零（base 缺失 +
 * 整体态断言移交无资产后端半），fixture 复制 base.md。
 * T62：type 机制删除——manifest modes 不再展开 types。
 * T60：chatMode 双模式链（注册表烘焙 + 驱逐重建 + 请求级 pickedProfileId）
 * 退役；组装数据源 = 落盘 active_design 三元组 + studio 注册表单例。
 *
 * 运行：bun spikes/s-pi/backend-smoke/t24/prompt-assembly-smoke.mjs（仓根）
 *
 * T28（决策单 #1）：后端全端点鉴权——两个后端各自 tempRoot 的 token 文件
 * 读 bearer 带 Authorization 头；未鉴权请求断言 401。
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authHeaders, readBackendToken } from '../pi-backend-auth.mjs'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const PORT = 7910 + Math.floor(Math.random() * 200)
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

const BASE_MARKER = 'You are a design assistant inside a vector design editor'
const WORKFLOW_MARKER = '# Marketing Design Workflow (MANDATORY)'

/** studio 资产 body = 剥 frontmatter 后的全文（parse.ts splitFrontmatter 同律：不 trim） */
function stripFrontmatter(raw) {
  const lines = raw.replace(/^﻿/, '').split('\n')
  if (lines[0]?.trim() !== '---') return raw
  const closeIndex = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  return closeIndex === -1 ? raw : lines.slice(closeIndex + 1).join('\n')
}

// ── fixture 布置：studio 资产集复制进 tempRoot（T45 改源；T60 起 prompt 段
// 文件不再参与组装，不再复制 prompts/ 与旧 ui 基底）
function layoutRoot(withStudioAssets) {
  const tempRoot = mkdtempSync(join(tmpdir(), 't60-assembly-'))
  if (withStudioAssets) {
    mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/studio'), { recursive: true })
    copyFileSync(
      join(repoRoot, 'src/app/ai/pi-backend/studio/base.md'),
      join(tempRoot, 'src/app/ai/pi-backend/studio/base.md')
    )
    // T85：workflow references 按资产分目录（workflows/<id>/references/，如 art-directed）——
    // 改递归整目录复制，references 文件随资产进 temp 布局（缺文件会进 manifest failures）
    // 2026-09-16：base.md 声明 references/render-jsx.md（base references 首个消费者）——
    // 复制清单补 'references'（缺文件会进 manifest failures，CI 34992857596 实证红）
    for (const sub of ['workflows', 'profiles', 'references']) {
      const srcDir = join(repoRoot, 'src/app/ai/pi-backend/studio', sub)
      const dstDir = join(tempRoot, 'src/app/ai/pi-backend/studio', sub)
      mkdirSync(dstDir, { recursive: true })
      cpSync(srcDir, dstDir, { recursive: true })
    }
  }
  mkdirSync(join(tempRoot, 'probe'), { recursive: true })
  return tempRoot
}

const tempRoot = layoutRoot(true)
const emptyAssetsRoot = layoutRoot(false)
// 空槽组装的精确口径 = base.md body（剥 frontmatter）全文
const baseBody = stripFrontmatter(
  readFileSync(join(repoRoot, 'src/app/ai/pi-backend/studio/base.md'), 'utf8')
)
// 2026-09-16：base.md frontmatter 声明 references/render-jsx.md（base references
// 首个消费者）→ collectActiveReferences 每回合非空，finishTurn 把索引节拼进
// systemPrompt 尾段（joinSegments 以 \n\n 连接）。索引节标题与行格式是运行时契约
// （active-design-host REFERENCES_INDEX_HEADING + `- path —— description（source）`），
// 此处 byte 级钉住——base.md references 声明或契约格式改动需同步重钉（CI
// 34992857596 二轮红实证：fixture 补复制 references/ 后陈旧 byte 钉浮出）。
// 2026-09-16 A3 波4：base.md frontmatter 二条 references（render-jsx + design-basics）
// → 索引节由 1 行扩 2 行；B7 装配段冠来源头 `# studio base` —— 空槽 expected
// 同步重钉（baseBody 前冠来源头）
const REFERENCES_INDEX_SECTION = [
  '## 按需参考（load_reference 工具按需读取）',
  '- references/render-jsx.md —— render 工具的 JSX 语法大全（props 全集 / 布局规则 / 禁用项 / 修复纪律）——首次 render 调用前必读（base）',
  '- references/design-basics.md —— 通用设计基础（设计令牌 / 版式 / 组合原语 / 画布预设）——搭建类设计任务开工前必读（base）'
].join('\n')
const EMPTY_SLOT_EXPECTED = `# studio base\n${baseBody}\n\n${REFERENCES_INDEX_SECTION}`

// ── 起后端（显式剔除真实 key 防环境泄漏干扰；dummy key 经凭据路由写入）
const backendEnv = {
  ...process.env,
  DIANJING_PI_BACKEND_PORT: String(PORT),
  // D2：后端状态根不再跟 cwd——显式 override 钉 tempRoot（直指根本身）
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

// 无资产后端（base 缺失断言）：同仓库代码、另一端口、另一 rootDir
const PORT2 = PORT + 500 > 7989 ? PORT - 500 : PORT + 500
const BASE2 = `http://127.0.0.1:${PORT2}`
const backendEnv2 = {
  ...process.env,
  DIANJING_PI_BACKEND_PORT: String(PORT2),
  DIANJING_ROOT_DIR: emptyAssetsRoot,
  PI_PROMPT_PROBE_DIR: join(emptyAssetsRoot, 'probe')
}
delete backendEnv2.OPENROUTER_API_KEY
const backend2 = spawn('bun', ['run', join(repoRoot, 'src/app/ai/pi-backend/main.ts')], {
  cwd: emptyAssetsRoot,
  env: backendEnv2,
  stdio: ['ignore', 'pipe', 'pipe']
})
let backend2Exited = false
backend2.on('exit', () => {
  backend2Exited = true
})
backend2.stderr.on('data', (d) => process.stderr.write(`[backend2] ${d}`))

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

function probeText(root) {
  const file = join(root, 'probe', 'last-system-prompt.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

function userMessage(text) {
  return [{ role: 'user', parts: [{ type: 'text', text }] }]
}

/** GET /api/pi/history?sessionId=… → 末条 user 文本（历史回填读取面，T22） */
async function lastUserText(base, sessionId, token) {
  const res = await fetch(`${base}/api/pi/history?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: authHeaders(token)
  })
  if (!res.ok) return null
  const body = await res.json()
  const users = (body.messages ?? []).filter((m) => m.role === 'user')
  const last = users.at(-1)
  return (last?.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

try {
  check(
    '后端就绪（注册表后端 + 无资产后端）',
    (await waitHealth(BASE, () => backendExited)) && (await waitHealth(BASE2, () => backend2Exited))
  )

  // T28：两个 standalone 后端各自的 token（只进请求头，不打印）
  const token = readBackendToken(tempRoot)
  const token2 = readBackendToken(emptyAssetsRoot)
  check(
    'T28 前置：两后端 token 文件可读且不相同',
    token.length > 0 && token2.length > 0 && token !== token2
  )

  // T28 负向：未带 Authorization → 401
  const noAuth = await fetch(`${BASE}/api/pi/studio/manifest`)
  check('T28 负向：未鉴权请求 → 401', noAuth.status === 401, `status=${noAuth.status}`)

  // ── manifest 路由
  const manifestRes = await fetch(`${BASE}/api/pi/studio/manifest`, { headers: authHeaders(token) })
  const manifest = await manifestRes.json()
  check(
    "路由 manifest：modes = general + art-directed + longform-hero-kv-first + longform-structure-first（T62：无 types 数据面；P1-5 重命名+P1-6 general.md 落位——文件名序 'a'<'l'，共同前缀后 'h'<'s'）",
    manifestRes.ok &&
      Array.isArray(manifest.modes) &&
      manifest.modes.length === 4 &&
      manifest.modes[0]?.id === 'general' &&
      manifest.modes[1]?.id === 'art-directed' &&
      manifest.modes[2]?.id === 'longform-hero-kv-first' &&
      manifest.modes[3]?.id === 'longform-structure-first' &&
      manifest.modes.every((m) => !('types' in m)),
    JSON.stringify(manifest).slice(0, 160)
  )
  check(
    '路由 manifest：failures 数据面——内置集零失败（T46 base.md 落位后收零；base 缺失+整体态由无资产后端半覆盖）',
    Array.isArray(manifest.failures) && manifest.failures.length === 0,
    JSON.stringify(manifest.failures).slice(0, 160)
  )
  check(
    // P2-4（2026-09-07）：applicableTo → modes（语义「在哪些 mode 下可用」）；
    // P2-10 启用运行时过滤（chips 菜单 + prompt 注入两层按 modes 筛选）
    // 2026-09-16：v2_zh 删除（owner 裁决——与调优 v2 已漂移），单精品 v2
    '路由 manifest：profiles 单精品摘要含 watercolor_poster_v2（modes[0]=longform-hero-kv-first；v2_zh 删除 2026-09-16 owner 裁决）',
    Array.isArray(manifest.profiles) &&
      manifest.profiles.length === 1 &&
      manifest.profiles.some(
        (p) =>
          p.id === 'watercolor_poster_v2' &&
          p.label === '水彩海报 v2' &&
          Array.isArray(p.modes) &&
          p.modes[0] === 'longform-hero-kv-first'
      )
  )
  check(
    '路由 manifest：脱敏——任何 profile 不带 body/markdown 正文',
    Array.isArray(manifest.profiles) &&
      manifest.profiles.every((p) => !('body' in p) && !('markdown' in p))
  )
  const manifest405 = await fetch(`${BASE}/api/pi/studio/manifest`, {
    method: 'POST',
    headers: authHeaders(token)
  })
  check('路由 manifest：非 GET → 405', manifest405.status === 405)
  const emptyManifest = await (
    await fetch(`${BASE2}/api/pi/studio/manifest`, { headers: authHeaders(token2) })
  ).json()
  check(
    '路由 manifest：无资产后端 → general 恒在 + 空 profiles + failures 非空（含整体态）',
    Array.isArray(emptyManifest.modes) &&
      emptyManifest.modes.length === 1 &&
      emptyManifest.modes[0]?.id === 'general' &&
      Array.isArray(emptyManifest.profiles) &&
      emptyManifest.profiles.length === 0 &&
      Array.isArray(emptyManifest.failures) &&
      emptyManifest.failures.some((f) => f.kind === 'studio')
  )
  check(
    '路由 manifest：failures 路径脱敏——base 缺失 path=base.md 相对路径，无绝对路径泄漏',
    emptyManifest.failures.some((f) => f.kind === 'base' && f.path === 'base.md') &&
      emptyManifest.failures.every((f) => !f.path.includes(':') && !f.path.startsWith('/'))
  )

  // ── T87：capabilities 路由
  // 缺省 DEFAULTS（首次请求 capabilities.json 不存在；2026-09-18 翻转 readonly+true）
  const capRes0 = await fetch(`${BASE}/api/pi/capabilities`, { headers: authHeaders(token) })
  const cap0 = await capRes0.json()
  check(
    'T87 路由 capabilities：缺省 DEFAULTS（capabilities.json 不存在 → 兜底 readonly+true）',
    capRes0.ok && cap0.builtinTools === 'readonly' && cap0.agentSkills === true,
    JSON.stringify(cap0)
  )
  // manifest.skills 同步透传（缺省 ON 但 fixture 目录无 skill → []）
  check(
    'T87 路由 manifest：capabilities 缺省 readonly+true + skills=[] 透传',
    manifest.capabilities?.builtinTools === 'readonly' &&
      manifest.capabilities?.agentSkills === true &&
      Array.isArray(manifest.skills) &&
      manifest.skills.length === 0,
    JSON.stringify({ capabilities: manifest.capabilities, skills: manifest.skills })
  )

  // PUT ON → 落盘 + 后续 GET 返 ON
  const capPutOn = await fetch(`${BASE}/api/pi/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ agentSkills: true })
  })
  const capOn = await capPutOn.json()
  check(
    'T87 路由 capabilities：PUT ON → 200 + 返 ON',
    capPutOn.ok && capOn.agentSkills === true,
    JSON.stringify(capOn)
  )
  const capRes1 = await fetch(`${BASE}/api/pi/capabilities`, { headers: authHeaders(token) })
  const cap1 = await capRes1.json()
  check(
    'T87 路由 capabilities：PUT ON 后 GET 返 ON（持久化）',
    capRes1.ok && cap1.agentSkills === true,
    JSON.stringify(cap1)
  )

  // 二次拉 manifest（缓存还在原 fetch 值，验后端无状态改动；
  // 真实场景需调 ensurePiStudioManifest 重拉；冒烟只看后端语义）
  // OFF → 落 ON 后能跑通；为保持 t24 后续流程不依赖 ON 状态，写回 OFF
  const capPutOff = await fetch(`${BASE}/api/pi/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ agentSkills: false })
  })
  check('T87 路由 capabilities：PUT OFF → 200', capPutOff.ok)

  // 负向：PUT 非布尔 → 400
  const capBad = await fetch(`${BASE}/api/pi/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ agentSkills: 'yes' })
  })
  check('T87 路由 capabilities：PUT 非布尔 → 400', capBad.status === 400, `status=${capBad.status}`)

  // 负向：未鉴权 → 401
  const capNoAuth = await fetch(`${BASE}/api/pi/capabilities`)
  check(
    'T87 路由 capabilities：未鉴权 → 401',
    capNoAuth.status === 401,
    `status=${capNoAuth.status}`
  )

  // ── dummy 凭据过 auth 预检（写 tempRoot 自带 agentDir，不碰真实 .dianjing）
  const cred = await fetch(`${BASE}/api/pi/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ providerId: 'openrouter', apiKey: 'sk-or-test-key-12345' })
  })
  check('前置：dummy 凭据写入（过 auth 预检用）', cred.ok)
  const cred2 = await fetch(`${BASE2}/api/pi/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token2) },
    body: JSON.stringify({ providerId: 'openrouter', apiKey: 'sk-or-test-key-12345' })
  })
  check('前置：无资产后端 dummy 凭据写入', cred2.ok)

  // ── C1：空槽（无桥）→ 探针 == base.md body + 按需参考索引节（钩子整体替换，无 cwd 尾巴）
  await sendPrompt(
    BASE,
    {
      sessionId: 't60-probe-empty-slot',
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: userMessage('你好')
    },
    token
  )
  const emptySlotProbe = probeText(tempRoot)
  check('C1 空槽：探针落盘', emptySlotProbe !== null)
  check(
    'C1 空槽：与 base.md body + 按需参考索引节 byte 级一致（无 workflow 段、无 profile、无 cwd 尾巴）',
    emptySlotProbe === EMPTY_SLOT_EXPECTED,
    emptySlotProbe === null
      ? 'probe missing'
      : `len ${emptySlotProbe.length} vs expected ${EMPTY_SLOT_EXPECTED.length}`
  )
  check('C1 空槽：不含旧 marketing 工作流段句式', !(emptySlotProbe ?? '').includes(WORKFLOW_MARKER))
  check('C1 空槽：含 base 正文句式', (emptySlotProbe ?? '').includes(BASE_MARKER))

  // ── C2：新建意图信封首行剥离 → 历史里用户消息 = 剥离后文本
  await sendPrompt(
    BASE,
    {
      sessionId: 't60-envelope',
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: userMessage(
        '[新建意图确认 modeId=longform-hero-kv-first profileId=watercolor_poster_v2]\n帮我做一张长图'
      )
    },
    token
  )
  const strippedText = await lastUserText(BASE, 't60-envelope', token)
  check(
    'C2 信封剥离：历史中用户消息 = 剥离后文本（信封不进 JSONL/模型视野）',
    strippedText === '帮我做一张长图',
    JSON.stringify(strippedText)
  )

  // ── C2：表单作答信封不剥离（AI 须读答案原文；无映射不移槽——未知 formId 静默）
  const answerText =
    '[表单作答 formId=form-smoke-aaaaaa]\n{"aborted":false,"answers":{"q1":"清爽方向"}}'
  await sendPrompt(
    BASE,
    {
      sessionId: 't60-answer',
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: userMessage(answerText)
    },
    token
  )
  const answerReadBack = await lastUserText(BASE, 't60-answer', token)
  check(
    'C2 表单作答：信封原文不剥离（run 终止续跑语义，T56 链不动）',
    answerReadBack === answerText,
    JSON.stringify(answerReadBack)
  )

  // ── C3 兼容窗：残留 chatMode/pickedProfileId 字段忽略不报错，组装不受影响
  const legacyResult = await sendPrompt(
    BASE,
    {
      sessionId: 't60-legacy-fields',
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: userMessage('兼容窗消息'),
      chatMode: 'marketing',
      pickedProfileId: 'watercolor_poster_v2'
    },
    token
  )
  check('C3 兼容窗：带残留字段的请求正常进 run（SSE 排空）', legacyResult === 'done', legacyResult)
  const legacyProbe = probeText(tempRoot)
  check(
    'C3 兼容窗：残留字段不改变组装（仍空槽 = 口径同 C1 byte 级一致）',
    legacyProbe === EMPTY_SLOT_EXPECTED,
    legacyProbe === null ? 'probe missing' : `len ${legacyProbe.length}`
  )

  // ── 端点 POST /api/pi/active-design（无桥环境）
  const endpointNoAuth = await fetch(`${BASE}/api/pi/active-design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: '1:2' })
  })
  check('端点：未鉴权 → 401', endpointNoAuth.status === 401, `status=${endpointNoAuth.status}`)
  const endpointGet = await fetch(`${BASE}/api/pi/active-design`, { headers: authHeaders(token) })
  check('端点：非 POST → 405', endpointGet.status === 405, `status=${endpointGet.status}`)
  const endpointBad = await fetch(`${BASE}/api/pi/active-design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({})
  })
  check('端点：缺 nodeId → 400', endpointBad.status === 400, `status=${endpointBad.status}`)
  const endpointNoBridge = await fetch(`${BASE}/api/pi/active-design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ nodeId: '1:2' })
  })
  const endpointBody = await endpointNoBridge.json().catch(() => null)
  check(
    '端点：桥不可达 → 502 + bridge_unavailable（显式失败不静默）',
    endpointNoBridge.status === 502 && endpointBody?.error === 'bridge_unavailable',
    `status=${endpointNoBridge.status} body=${JSON.stringify(endpointBody)}`
  )

  // ── 无资产后端：base 缺失 → 空槽组装 = 空 systemPrompt（failures 数据面已断言）
  await sendPrompt(
    BASE2,
    {
      sessionId: 't60-probe-empty',
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: userMessage('probe empty')
    },
    token2
  )
  const noBaseProbe = probeText(emptyAssetsRoot)
  check('无资产后端：base 缺失 → 探针为空串（不崩溃、不混入旧基底）', noBaseProbe === '')
} finally {
  // Windows 清理纪律：bun run 是 wrapper + 孙进程两段——SIGTERM 只杀 wrapper
  // （信号致死 exitCode 恒 null，「exitCode===null 再升级」判据事后失效），
  // 孙进程服务器成孤儿（2026-08-25 T28 核验 pid 树复现：本套件曾泄漏双后端）。
  // win32 必须对活 wrapper 直接 taskkill /T /F 整树杀；posix 走 SIGTERM→SIGKILL。
  // kill 后须等 exit 事件；rmSync 对句柄释放滞后做有限重试
  const { once } = await import('node:events')
  const waitExit = (proc, ms) =>
    Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, ms))])
  const stop = async (proc) => {
    if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        // 已退出
      }
      await waitExit(proc, 3000)
      return
    }
    proc.kill('SIGTERM')
    await waitExit(proc, 2000)
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL')
      await waitExit(proc, 2000)
    }
  }
  await stop(backend)
  await stop(backend2)
  for (const dir of [tempRoot, emptyAssetsRoot]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
