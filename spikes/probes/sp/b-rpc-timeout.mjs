/**
 * Phase 3 SP-b 探针：工具执行链路超时上限实证（15 册 R1）。
 *
 * 问题（S4 §2 SP-b）：240s 生图调用会不会被框架掐断？要否覆盖手段？
 *
 * 静态证据（2026-08-30 代码走查）：
 * - pi agent loop（@earendil-works/pi-coding-agent dist/core/agent-session*.js）
 *   无任何 setTimeout/AbortSignal —— 框架对工具执行无墙钟上限；
 * - pi-backend → 桥 fetch（src/app/ai/pi-backend/tools.ts callBridgeTool）
 *   裸 fetch 无 client 超时；
 * - MCP 桥 WS 中继（packages/mcp/src/browser-rpc.ts:11）有 RPC_TIMEOUT =
 *   env DIANJING_RPC_TIMEOUT_MS || 20_000 —— 链路唯一墙钟上限在此。
 *
 * 本探针实证桥层行为（动态）：
 *   default  模式：mock app 延迟 25s 应答 → 期望 ~20s 被掐（502 RPC timeout）；
 *   override 模式：DIANJING_RPC_TIMEOUT_MS=60000（模块加载前设置）→ 期望 25s 成功。
 *
 * 运行：bun spikes/probes/sp/b-rpc-timeout.mjs default|override
 * 注意：RPC_TIMEOUT 是模块加载期常量，两种模式必须分进程跑（由驱动模式 all 编排）。
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'

const MODE = process.argv[2] ?? 'all'
const AUTH_TOKEN = 'sp-b-probe-token'
const SLOW_DELAY_MS = 25_000
const OVERRIDE_MS = 60_000

async function waitAppConnected(port) {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${AUTH_TOKEN}` }
      })
      const body = await res.json()
      if (body.status === 'ok') return
    } catch {
      // 服务器尚未就绪，继续轮询
    }
    if (Date.now() > deadline) throw new Error('等待 app 注册超时')
    await sleep(100)
  }
}

/** mock 编辑器：WS 注册后对所有 request 延迟 delayMs 才应答 */
async function connectSleepyApp(port, delayMs) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  ws.send(JSON.stringify({ type: 'register', token: AUTH_TOKEN }))
  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type !== 'request' || !msg.id) return
    await sleep(delayMs)
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result: { slept: delayMs } }))
    }
  })
  return { close: () => ws.close() }
}

async function runScenario(label) {
  // RPC_TIMEOUT 是模块加载期常量——override 模式必须先设 env 再动态 import
  const override = label === 'override'
  if (override) process.env.DIANJING_RPC_TIMEOUT_MS = String(OVERRIDE_MS)
  const { startServer } = await import('../../packages/mcp/src/server.ts')

  const handle = await startServer({
    httpPort: 0,
    withTcp: true,
    socketPath: null,
    authToken: AUTH_TOKEN,
    enableEval: false,
    mcpRoot: null
  })
  const port = handle.httpPort
  console.log(`\n[${label}] server 起在 :${port}，mock app 延迟 ${SLOW_DELAY_MS}ms 应答`)

  const app = await connectSleepyApp(port, SLOW_DELAY_MS)
  await waitAppConnected(port)

  const t0 = Date.now()
  let outcome
  let pass
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${AUTH_TOKEN}`
      },
      body: JSON.stringify({ command: 'tool', args: { name: 'sleep', args: {} } })
    })
    const body = await res.json()
    const elapsed = Date.now() - t0
    outcome = `HTTP ${res.status} ${JSON.stringify(body)} @ ${elapsed}ms`
    if (override) {
      pass = res.status === 200 && body.ok === true && elapsed >= SLOW_DELAY_MS
    } else {
      pass = res.status === 502 && /RPC timeout \(20s\)/.test(body.error ?? '') && elapsed < SLOW_DELAY_MS
    }
  } catch (e) {
    const elapsed = Date.now() - t0
    outcome = `fetch 异常 ${e instanceof Error ? e.message : e} @ ${elapsed}ms`
    pass = false
  }

  console.log(`[${label}] 结果: ${outcome}`)
  console.log(`[${label}] 判定: ${pass ? '✅ 符合预期' : '❌ 不符合预期'}`)

  app.close()
  await handle.close()
  return pass
}

async function main() {
  console.log('== SP-b 探针：桥层 RPC_TIMEOUT 实证 ==')
  if (MODE === 'all') {
    // 模块加载期常量要求分进程；用 bun 自spawn 编排两个模式
    const { spawnSync } = await import('node:child_process')
    let allPass = true
    for (const mode of ['default', 'override']) {
      const r = spawnSync('bun', [import.meta.filename, mode], { stdio: 'inherit' })
      if (r.status !== 0) allPass = false
    }
    console.log(`\n== SP-b 总判定: ${allPass ? '✅ 两模式均符合预期' : '❌ 有模式不符'} ==`)
    process.exit(allPass ? 0 : 1)
  }
  const pass = await runScenario(MODE)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('探针失败:', e)
  process.exit(1)
})
