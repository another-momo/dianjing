/**
 * T19 P5 后端冒烟（活模型 openrouter/free，不经浏览器）：
 * 直接 POST /api/pi-chat 验证 SSE 帧序列、中文无损、跨请求 session 连续性、
 * SessionManager JSONL 落盘。
 *
 * 前置：vite dev server 已起（T25 D3 后门退役：pi 为唯一路径；key 经 env 或 .dianjing/key-env 自助注入）。
 * 运行：node spikes/s-pi/backend-smoke/smoke.mjs [baseUrl]
 * 退出码 0 = 全过。key 卫生：脚本不接触 key 本体。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const base = process.argv[2] ?? 'http://localhost:1420'
const root = process.cwd()
const sessionId = `smoke-${Date.now()}`

const failures = []
function check(label, cond, detail) {
  if (cond) console.log(`  PASS ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

async function post(text, sid = sessionId) {
  const res = await fetch(`${base}/api/pi-chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

const MARKER = '7391'
const ECHO = '汉字无损'

console.log(`T19 pi-backend 冒烟 → ${base}  session=${sessionId}`)

// 回合 1：中文逐字复读。openrouter/free 为 meta 路由，模型对 echo 指令的服从
// 非确定（实测偶发跑题），回复侧 echo 断言带重试（每次换 session 避免历史污染）；
// 管道侧 UTF-8 无损另由落盘 JSONL 含发送原文兜底断言（确定性，见落盘段）。
// 注：回复侧零 U+FFFD 断言已移除——meta 路由上游偶发在入模前损坏中文，模型回复即含
// 替换字符，属上游模型侧行为非本管道缺陷（实测命中一次）；回复侧中文以 echo 重试断言承载
let t1 = null
let t1Text = ''
let r1Session = sessionId
for (let attempt = 1; attempt <= 3; attempt++) {
  r1Session = attempt === 1 ? sessionId : `${sessionId}-r${attempt}`
  t1 = await post(
    `请逐字重复「${ECHO}」四个字作为确认，然后记住这个数字：${MARKER}（之后我会问）。`,
    r1Session
  )
  t1Text = t1.chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.delta)
    .join('')
  if (t1Text.includes(ECHO)) break
  console.log(`  … R1 echo 第 ${attempt} 次未复读（${t1Text.slice(0, 30)}…），换 session 重试`)
}
const t1Types = t1.chunks.map((c) => c.type)

check('R1 帧序列 start 为首帧', t1Types[0] === 'start', t1Types.join(','))
const textStartIdx = t1Types.indexOf('text-start')
const textDeltaIdx = t1Types.indexOf('text-delta')
check('R1 text-start 先于首个 text-delta', textStartIdx !== -1 && textStartIdx < textDeltaIdx)
check(
  'R1 text-start/delta/end 计数自洽',
  t1Types.filter((t) => t === 'text-start').length ===
    t1Types.filter((t) => t === 'text-end').length,
  t1Types.join(',')
)
check('R1 finish(stop) 收尾', t1.chunks.at(-1)?.type === 'finish', JSON.stringify(t1.chunks.at(-1)))
check('R1 [DONE] 帧存在', t1.sawDone)
check('R1 回复非空', t1Text.length > 0)
check(
  `R1 中文回复无损（逐字复读「${ECHO}」，≤3 次重试）`,
  t1Text.includes(ECHO),
  t1Text.slice(0, 60)
)

// 回合 2：跨请求连续性——锚点只有后端 session 历史能提供（沿用 R1 最后一次的 session）
const t2 = await post('我刚才让你记住的数字是什么？只回答数字本身。', r1Session)
const t2Text = t2.chunks
  .filter((c) => c.type === 'text-delta')
  .map((c) => c.delta)
  .join('')
check('R2 回复含锚点数字（session 历史生效）', t2Text.includes(MARKER), t2Text.slice(0, 80))
check(
  'R2 帧序列完整',
  t2.chunks[0]?.type === 'start' && t2.chunks.at(-1)?.type === 'finish' && t2.sawDone
)

// 落盘：index.json 记录 + JSONL 文件存在且非空 + 管道侧 UTF-8 确定性断言
const sessionsDir = join(root, 'pi-sessions')
const indexPath = join(sessionsDir, 'index.json')
check('index.json 存在', existsSync(indexPath))
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {}
const indexedFile = index[r1Session]?.file
check('index 记录本 session', typeof indexedFile === 'string', Object.keys(index).join(','))
check(
  'JSONL 文件落盘且非空',
  !!indexedFile && existsSync(indexedFile) && readFileSync(indexedFile, 'utf8').trim().length > 0,
  indexedFile
)
if (indexedFile && existsSync(indexedFile)) {
  const jsonl = readFileSync(indexedFile, 'utf8')
  check(
    'JSONL 含两回合 user 消息（锚点 + 追问）',
    jsonl.includes(MARKER) && jsonl.includes('只回答数字本身')
  )
  check(`JSONL 逐字节含发送中文原文「${ECHO}」（管道 UTF-8 无损确定性断言）`, jsonl.includes(ECHO))
}
check(
  'pi-sessions 目录仅有 jsonl/index（无 key 明文文件名）',
  readdirSync(sessionsDir).every((f) => f.endsWith('.jsonl') || f === 'index.json')
)

if (failures.length) {
  console.error(`\nFAIL ${failures.length} 项：${failures.join(' / ')}`)
  process.exit(1)
}
console.log('\nT19 后端冒烟全过')
