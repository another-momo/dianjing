/**
 * T19 P5 恢复探针：对 pi-backend-smoke.mjs 已建立的 session 在 dev server 重启后
 * 追问锚点数字——命中即证明 SessionManager.open 从 JSONL 恢复了历史。
 *
 * 前置：vite dev server 已起 + 活模型 key（不经浏览器）。
 * 运行：node spikes/s-pi/backend-smoke/recovery-probe.mjs <sessionId> <marker> [baseUrl]
 * （T27 修正头注释 stale 路径——本脚本 T19 从 tests/engine/rebuild/ 迁来后未更新）
 * 退出码 0 = 恢复命中。
 */

const [, , sessionId, marker, base = 'http://localhost:1420'] = process.argv
if (!sessionId || !marker) {
  console.error('usage: node recovery-probe.mjs <sessionId> <marker> [baseUrl]')
  process.exit(2)
}

const res = await fetch(`${base}/api/pi-chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sessionId,
    // T100：spec 必填——seed openrouter/free，与前置 smoke 一致
    model: { providerId: 'openrouter', modelId: 'openrouter/free' },
    messages: [
      {
        role: 'user',
        parts: [{ type: 'text', text: '重启后追问：我之前让你记住的数字是什么？只回答数字本身。' }]
      }
    ]
  })
})
if (!res.ok || !res.body) {
  console.error(`HTTP ${res.status}`)
  process.exit(1)
}
const raw = await res.text()
const text = raw
  .split('\n\n')
  .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
  .filter(Boolean)
  .map((line) => line.slice(5).trimStart())
  .filter((data) => data !== '[DONE]')
  .map((data) => JSON.parse(data))
  .filter((chunk) => chunk.type === 'text-delta')
  .map((chunk) => chunk.delta)
  .join('')

console.log('reply:', text.slice(0, 120))
if (text.includes(marker)) {
  console.log(`RECOVERY-PASS: 重启后 session ${sessionId} 恢复，锚点 ${marker} 命中`)
} else {
  console.error(`RECOVERY-FAIL: 锚点 ${marker} 未命中`)
  process.exit(1)
}
