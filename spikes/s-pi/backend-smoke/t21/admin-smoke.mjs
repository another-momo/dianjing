/**
 * T21 冒烟①+②：pi 原生 provider/凭据管理 API + 无 env key 全链。
 *
 * 自起独立后端进程（端口 7703，临时 rootDir，env 中显式剔除
 * OPENROUTER_API_KEY），全流程：
 *  ① 空态 catalog → POST key → auth.json 落盘（0600 仅 POSIX 断言）→
 *     catalog configured → 自定义 provider upsert → DELETE → 回到空态；
 *     每一步断言响应体不含 key 本体（脱敏）
 *  ② 后端进程无 env key，凭 auth.json 里的 key 跑通真实聊天回合
 *    （start/text-delta/finish/[DONE]，回复含「2」）
 *
 * key 卫生：脚本进程 env 读取（set -a; source .dianjing/key-env; set +a），
 * 只经请求体传输，绝不打印（断言输出只给布尔/长度）。
 *
 * 运行：node spikes/s-pi/backend-smoke/t21/admin-smoke.mjs
 * 退出码 0 = 全过。
 *
 * T28（决策单 #1）：后端全端点鉴权——从 tempRoot 的 token 文件读 bearer
 * 带 Authorization 头；未鉴权请求断言 401。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authHeaders, readBackendToken } from '../pi-backend-auth.mjs'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const PORT = 7703
const BASE = `http://127.0.0.1:${PORT}`
const KEY = process.env.OPENROUTER_API_KEY ?? ''

const failures = []
function check(label, cond, detail) {
  if (cond) console.log(`  PASS ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

function assertRedacted(label, bodyText) {
  check(`${label}（响应体不含 key 本体）`, KEY.length === 0 || !bodyText.includes(KEY), `bodyLen=${bodyText.length}`)
}

async function api(method, path, payload, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? authHeaders(token) : {}) },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应留给调用方断言 */
  }
  return { status: res.status, text, json }
}

console.log(`T21 管理面冒烟 → ${BASE}`)

check('前置：OPENROUTER_API_KEY 在脚本环境（只用于请求体传输）', KEY.length > 0)
if (KEY.length === 0) {
  console.error('运行方式：set -a; source .dianjing/key-env; set +a; node t21/admin-smoke.mjs')
  process.exit(1)
}

// 临时 rootDir：只复制 pi-backend/studio/base.md（service.ts 读盘需要），state 全新
const tempRoot = mkdtempSync(join(tmpdir(), 't21-admin-'))
mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/studio'), { recursive: true })
copyFileSync(
  join(repoRoot, 'src/app/ai/pi-backend/studio/base.md'),
  join(tempRoot, 'src/app/ai/pi-backend/studio/base.md')
)
const agentDir = join(tempRoot, 'pi-agent')
const authPath = join(agentDir, 'auth.json')

// 后端进程 env 显式剔除 key——全链只能走 auth.json
// D2：后端状态根不再跟 cwd——显式 override 钉 tempRoot（直指根本身）
const backendEnv = { ...process.env, DIANJING_PI_BACKEND_PORT: String(PORT), DIANJING_ROOT_DIR: tempRoot }
delete backendEnv.OPENROUTER_API_KEY
const backend = spawn('bun', ['run', join(repoRoot, 'src/app/ai/pi-backend/main.ts')], {
  cwd: tempRoot,
  env: backendEnv,
  stdio: ['ignore', 'ignore', 'pipe']
})
let backendErr = ''
backend.stderr.on('data', (d) => (backendErr += d))

try {
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 150))
    up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)
  }
  check('后端无 env key 启动就绪（keyless boot）', up, backendErr.slice(0, 200))
  if (!up) throw new Error('backend not up')

  // T28：standalone 后端 token 落盘后可读（只进请求头，不打印）
  const token = readBackendToken(tempRoot)
  check('T28 前置：token 文件可读', typeof token === 'string' && token.length > 0)
  if (process.platform !== 'win32') {
    const tokenMode = statSync(join(tempRoot, 'pi-backend-token')).mode & 0o777
    check('T28 token 文件权限 0600', tokenMode === 0o600, `mode=${tokenMode.toString(8)}`)
  }

  // T28 负向：未带 Authorization → 401
  const noAuth = await api('GET', '/api/pi/catalog')
  check('T28 负向：未鉴权请求 → 401', noAuth.status === 401, `status=${noAuth.status}`)

  // ── ① 空态 catalog
  const empty = await api('GET', '/api/pi/catalog', undefined, token)
  const emptyRouter = empty.json?.providers?.find((p) => p.id === 'openrouter')
  check(
    '空态 catalog：openrouter 存在且未配置',
    empty.status === 200 && !!emptyRouter && emptyRouter.auth.configured === false,
    JSON.stringify(emptyRouter?.auth)
  )
  check(
    '空态 catalog：内置目录含模型列表（>100）',
    (emptyRouter?.models?.length ?? 0) > 100,
    `models=${emptyRouter?.models?.length}`
  )
  assertRedacted('空态 catalog 脱敏', empty.text)

  // ── ① POST key → auth.json 落盘 → catalog configured
  const setRes = await api('POST', '/api/pi/credentials', { providerId: 'openrouter', apiKey: KEY }, token)
  check('POST /credentials 成功', setRes.status === 200 && setRes.json?.ok === true, setRes.text.slice(0, 120))
  assertRedacted('POST /credentials 脱敏', setRes.text)

  check('auth.json 落盘', existsSync(authPath))
  if (existsSync(authPath)) {
    const doc = JSON.parse(readFileSync(authPath, 'utf8'))
    check(
      'auth.json 为 pi 格式（type=api_key，key 匹配）',
      doc?.openrouter?.type === 'api_key' && doc?.openrouter?.key === KEY
    )
    if (process.platform !== 'win32') {
      check('auth.json 权限 0600', (statSync(authPath).mode & 0o777) === 0o600)
    }
  }

  const configured = await api('GET', '/api/pi/catalog', undefined, token)
  const confRouter = configured.json?.providers?.find((p) => p.id === 'openrouter')
  check(
    '配置后 catalog：openrouter configured=true（stored credential）',
    confRouter?.auth?.configured === true && /stored/i.test(confRouter?.auth?.source ?? ''),
    JSON.stringify(confRouter?.auth)
  )
  assertRedacted('配置后 catalog 脱敏', configured.text)

  // ── ② 无 env key 全链聊天（凭 auth.json 里的 key）
  const chat = await fetch(`${BASE}/api/pi-chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({
      sessionId: `t21-admin-${Date.now()}`,
      // T100：spec 必填——seed openrouter/free，spike 一致沿用此档位
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: [{ role: 'user', parts: [{ type: 'text', text: '1+1等于几？只回答一个数字。' }] }]
    })
  })
  const chatText = await chat.text()
  const frames = chatText
    .split('\n\n')
    .map((f) => f.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trimStart())
    .filter(Boolean)
  const types = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f).type)
  const reply = frames
    .filter((f) => f !== '[DONE]')
    .map((f) => JSON.parse(f))
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.delta)
    .join('')
  check('无 env key 聊天：HTTP 200', chat.status === 200, chatText.slice(0, 150))
  check(
    '无 env key 聊天：start 首帧 + finish 收尾 + [DONE]',
    types[0] === 'start' && types.at(-1) === 'finish' && frames.at(-1) === '[DONE]',
    types.join(',')
  )
  check('无 env key 聊天：回复含「2」', reply.includes('2'), reply.slice(0, 60))
  assertRedacted('无 env key 聊天脱敏', chatText)

  // ── ① 自定义 provider upsert
  const upsert = await api('POST', '/api/pi/providers', {
    id: 'my-gw',
    baseUrl: 'https://example.com/v1',
    api: 'openai-completions',
    models: ['m1', 'm2']
  }, token)
  check('POST /providers 自定义 provider 成功', upsert.status === 200 && upsert.json?.ok === true, upsert.text.slice(0, 120))
  const afterUpsert = await api('GET', '/api/pi/catalog', undefined, token)
  const gw = afterUpsert.json?.providers?.find((p) => p.id === 'my-gw')
  check(
    '自定义 provider 出现在 catalog（2 模型、未配置）',
    !!gw && gw.models.length === 2 && gw.auth.configured === false,
    JSON.stringify(gw?.auth)
  )
  check(
    'models.json 落盘含 my-gw',
    readFileSync(join(agentDir, 'models.json'), 'utf8').includes('my-gw')
  )

  // ── ① DELETE → 回到空态
  const del = await api('DELETE', '/api/pi/credentials', { providerId: 'openrouter' }, token)
  check('DELETE /credentials 成功', del.status === 200 && del.json?.ok === true, del.text.slice(0, 120))
  const cleared = await api('GET', '/api/pi/catalog', undefined, token)
  const clearedRouter = cleared.json?.providers?.find((p) => p.id === 'openrouter')
  check(
    '清除后 catalog：openrouter 回到未配置',
    clearedRouter?.auth?.configured === false,
    JSON.stringify(clearedRouter?.auth)
  )
  if (existsSync(authPath)) {
    const doc = JSON.parse(readFileSync(authPath, 'utf8'))
    check('auth.json 不再含 openrouter 条目', doc?.openrouter === undefined)
  }
} finally {
  // Windows：进程 cwd 锁目录，须等退出后再删；rmSync 重试兜底句柄延迟释放。
  // bun run = wrapper + 孙进程两段——win32 须对活 wrapper 直接 taskkill /T /F
  // 整树杀（kill() 的 SIGTERM 只杀 wrapper，孙进程服务器成孤儿，
  // 2026-08-25 T28 核验 pid 树实证，对齐 t22/t23/t28 清理口径）
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // 已退出
    }
  } else {
    backend.kill('SIGTERM')
  }
  await new Promise((resolve) => {
    backend.once('exit', resolve)
    setTimeout(resolve, 3000)
  })
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}

if (failures.length) {
  console.error(`\nFAIL ${failures.length} 项：${failures.join(' / ')}`)
  process.exit(1)
}
console.log('\nT21 管理面冒烟全过')
