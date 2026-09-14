/**
 * T98-路由：窗口感知路由钉扎（multi-window）。
 *
 * Bug 复盘：自动化桥是单槽位——两浏览器窗口同时开着同一 app 时，各自经
 * WebSocket 向桥 register，后注册者顶掉前者（last-wins），pi-backend/MCP
 * 的工具调用全进了当时占槽的窗口——agent 在用户另一个窗口里写文档。
 *
 * 修复方案 A：每个窗口注册时带 windowId（window-id.ts 模块级 UUID），
 * 桥维护 Map<windowId, ws>，调用方按发起窗口路由。
 *
 * 路由规则（sendRPC）：
 *  1) opts.windowId 显式存在：命中该窗槽位则发；缺窗立即 reject APP_NOT_CONNECTED_MESSAGE
 *  2) opts.windowId 缺省 + 仅一窗：发到该唯一窗
 *  3) opts.windowId 缺省 + 多窗：发到 lastRegisteredWindowId（最后注册窗）
 *  4) 零窗：走 waitForConnection 等待逻辑
 *
 * 本测试覆盖（参数化 helper 复用，避开 jscpd 克隆块门禁）：
 *  ① 两窗 register（不同 windowId）→ 按 windowId 路由到正确 socket
 *  ② 无 windowId 单窗 → 路由成功
 *  ③ 无 windowId 两窗 → 落最后注册窗
 *  ④ 显式 windowId 缺窗 → reject APP_NOT_CONNECTED_MESSAGE
 *  ⑤ 同 windowId 重复 register → 旧槽 pending 被 reject 'Browser reconnected'、
 *     旧 socket 被 close、另一窗不受影响
 *  ⑥ 关窗 → 只 reject 该窗 pending，另一窗 sendRPC 仍通
 *  ⑦ register 无 windowId（旧客户端）→ 服务端分配 id 正常工作
 *
 * 复用 bridge-errors.test.ts 的 server+WS 搭建风格（真实 server，避免
 * mock bridge-rpc 内的复杂状态机），通过 helper 集中构造测试拓扑。
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { startServer } from '@/app/bridge/server/server'

const TEST_AUTH_TOKEN = 'test-window-routing-token'

type FakeBrowser = {
  windowId: string
  ws: WebSocket
  receivedRequests: Array<{ id: string; command: string }>
  closed: boolean
}

type Topology = {
  handle: Awaited<ReturnType<typeof startServer>>
  port: number
  browsers: FakeBrowser[]
}

/**
 * 启动桥 + 注册 N 个带 windowId 的假浏览器。
 * 每个 ws 接收到的 request 记录到 receivedRequests，方便断言「只有目标窗收到」。
 */
async function startBridgeWithBrowsers(
  browsersSpec: Array<{ windowId: string; includeWindowIdInRegister: boolean }>
): Promise<Topology> {
  const handle = await startServer({
    httpPort: 0,
    withTcp: true,
    socketPath: null,
    authToken: TEST_AUTH_TOKEN
  })
  const port = handle.httpPort
  if (!port) throw new Error('withTcp: true did not produce an HTTP port')

  const browsers: FakeBrowser[] = []

  // 串行注册——确保 lastRegisteredWindowId 期望值在多窗测试里可控
  for (const spec of browsersSpec) {
    const fake: FakeBrowser = {
      windowId: spec.windowId,
      ws: new WebSocket(`ws://127.0.0.1:${port}`),
      receivedRequests: [],
      closed: false
    }
    const ws = fake.ws
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string
        id?: string
        command?: string
      }
      if (msg.type === 'request' && msg.id && msg.command) {
        fake.receivedRequests.push({ id: msg.id, command: msg.command })
        // 默认应答：ok:true 携带空 result（让 sendRPC resolve）
        ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result: {} }))
      }
    }
    ws.onclose = () => {
      fake.closed = true
    }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        const registerBody: Record<string, unknown> = {
          type: 'register',
          token: TEST_AUTH_TOKEN
        }
        if (spec.includeWindowIdInRegister) registerBody.windowId = spec.windowId
        ws.send(JSON.stringify(registerBody))
        resolve()
      }
      ws.onerror = () => reject(new Error('WebSocket connect failed'))
    })
    // 等桥把本窗计入 windows map（/health 反映 ok 即就位）
    await waitForHealthOk(port)
    browsers.push(fake)
  }

  return { handle, port, browsers }
}

async function waitForHealthOk(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const health = (await (
      await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}` }
      })
    ).json()) as { status: string }
    if (health.status === 'ok') return
    await new Promise((r) => {
      setTimeout(r, 20)
    })
  }
}

type RPCBody = { ok?: boolean; error?: string; [key: string]: unknown }

async function rpc(
  port: number,
  body: Record<string, unknown>
): Promise<{ status: number; json: RPCBody }> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TEST_AUTH_TOKEN}`
    },
    body: JSON.stringify(body)
  })
  const json = (await response.json().catch(() => ({}))) as RPCBody
  return { status: response.status, json }
}

describe('窗口感知路由（multi-window routing）', () => {
  let topology: Topology | null = null
  afterEach(async () => {
    if (topology) {
      for (const b of topology.browsers) {
        try {
          b.ws.close()
        } catch (e) {
          // 关闭竞态忽略——ws.close 可能因已关闭抛 InvalidStateError
          console.debug('[window-routing] ws.close failed during teardown:', e)
        }
      }
      await topology.handle.close()
      topology = null
    }
  })

  // ① 两窗 register（不同 windowId）→ 按 windowId 路由到正确 socket
  test('① 两窗不同 windowId → 显式 windowId 路由到目标窗', async () => {
    topology = await startBridgeWithBrowsers([
      { windowId: 'win-A', includeWindowIdInRegister: true },
      { windowId: 'win-B', includeWindowIdInRegister: true }
    ])
    const { port, browsers } = topology

    // 路由到 win-A
    const resA = await rpc(port, { command: 'tool', args: { name: 'noop' }, windowId: 'win-A' })
    expect(resA.status).toBe(200)
    expect(resA.json.ok).toBe(true)

    // 路由到 win-B
    const resB = await rpc(port, { command: 'tool', args: { name: 'noop' }, windowId: 'win-B' })
    expect(resB.status).toBe(200)
    expect(resB.json.ok).toBe(true)

    // 各自只收到自己的 request
    expect(browsers[0]?.receivedRequests.length).toBe(1)
    expect(browsers[1]?.receivedRequests.length).toBe(1)
    expect(browsers[0]?.receivedRequests[0]?.command).toBe('tool')
    expect(browsers[1]?.receivedRequests[0]?.command).toBe('tool')
  })

  // ② 无 windowId 单窗 → 路由成功
  test('② 无 windowId 单窗 → 路由到唯一窗', async () => {
    topology = await startBridgeWithBrowsers([
      { windowId: 'only-win', includeWindowIdInRegister: true }
    ])
    const { port, browsers } = topology

    const res = await rpc(port, { command: 'tool', args: { name: 'noop' } })
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(browsers[0]?.receivedRequests.length).toBe(1)
  })

  // ③ 无 windowId 两窗 → 落最后注册窗
  test('③ 无 windowId 两窗 → 落最后注册窗（win-B）', async () => {
    topology = await startBridgeWithBrowsers([
      { windowId: 'win-A', includeWindowIdInRegister: true },
      { windowId: 'win-B', includeWindowIdInRegister: true }
    ])
    const { port, browsers } = topology

    // 无 windowId → 落最后注册窗（win-B）
    const res = await rpc(port, { command: 'tool', args: { name: 'noop' } })
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)

    expect(browsers[0]?.receivedRequests.length).toBe(0)
    expect(browsers[1]?.receivedRequests.length).toBe(1)
  })

  // ④ 显式 windowId 缺窗 → reject APP_NOT_CONNECTED_MESSAGE
  test('④ 显式 windowId 缺窗 → 502 + APP_NOT_CONNECTED_MESSAGE', async () => {
    topology = await startBridgeWithBrowsers([
      { windowId: 'win-A', includeWindowIdInRegister: true }
    ])
    const { port, browsers } = topology

    const res = await rpc(port, {
      command: 'tool',
      args: { name: 'noop' },
      windowId: 'non-existent-win'
    })
    expect(res.status).toBe(502)
    expect(res.json.ok).toBe(false)
    const errMsg = String(res.json.error ?? '')
    expect(errMsg).toContain('not connected')
    // 唯一真窗不应收到 request
    expect(browsers[0]?.receivedRequests.length).toBe(0)
  })

  // ⑤ 同 windowId 重复 register → 旧槽 pending 被 reject 'Browser reconnected'、
  //     旧 socket 被 close、另一窗不受影响
  test('⑤ 同 windowId 重复 register → 旧槽 pending reject + 旧 ws close + 另一窗不受影响', async () => {
    topology = await startBridgeWithBrowsers([
      { windowId: 'shared-id', includeWindowIdInRegister: true },
      { windowId: 'other-win', includeWindowIdInRegister: true }
    ])
    const { port, browsers } = topology

    // 启动一个长回合 request 到 shared-id（故意不立即应答，让它留在旧槽 pending）
    let pendingResolve: ((value: unknown) => void) | null = null
    let pendingReject: ((reason: Error) => void) | null = null
    const sharedBrowser = browsers[0]
    if (!sharedBrowser) throw new Error('test fixture missing first browser')
    // 注册 pending 控制句柄供收尾时手动 settle；Promise 本身未 await（桥层
    // reject 时不需要消费者介入），仅持有 resolve/reject 以防 unhandled rejection。
    void new Promise<unknown>((resolve, reject) => {
      pendingResolve = resolve
      pendingReject = reject
    })
    sharedBrowser.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; id?: string }
      if (msg.type === 'request' && msg.id) {
        sharedBrowser.receivedRequests.push({ id: msg.id, command: 'tool' })
        // 不应答——让 pending 留在旧槽
      }
    }
    const rpcPromise = fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`
      },
      body: JSON.stringify({
        command: 'tool',
        args: { name: 'noop' },
        windowId: 'shared-id'
      })
    }).then((r) => r.json())

    // 等请求抵达旧 ws
    for (let i = 0; i < 50 && sharedBrowser.receivedRequests.length === 0; i++) {
      await new Promise((r) => {
        setTimeout(r, 10)
      })
    }
    expect(sharedBrowser.receivedRequests.length).toBe(1)

    // 同一 windowId 注册新 ws——应顶掉旧槽并 reject 旧 pending
    const newSharedWs = new WebSocket(`ws://127.0.0.1:${port}`)
    let newSharedFake: FakeBrowser | null = null
    await new Promise<void>((resolve, reject) => {
      newSharedWs.onopen = () => {
        newSharedWs.send(
          JSON.stringify({
            type: 'register',
            token: TEST_AUTH_TOKEN,
            windowId: 'shared-id'
          })
        )
        newSharedFake = {
          windowId: 'shared-id',
          ws: newSharedWs,
          receivedRequests: [],
          closed: false
        }
        newSharedWs.onmessage = (event) => {
          const msg = JSON.parse(String(event.data)) as {
            type: string
            id?: string
            command?: string
          }
          if (msg.type === 'request' && msg.id && msg.command) {
            newSharedFake?.receivedRequests.push({ id: msg.id, command: msg.command })
            newSharedWs.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result: {} }))
          }
        }
        newSharedWs.onclose = () => {
          if (newSharedFake) newSharedFake.closed = true
        }
        resolve()
      }
      newSharedWs.onerror = () => reject(new Error('WebSocket connect failed'))
    })

    // 旧 ws 应被 close
    for (let i = 0; i < 50 && !sharedBrowser.closed; i++) {
      await new Promise((r) => {
        setTimeout(r, 10)
      })
    }
    expect(sharedBrowser.closed).toBe(true)

    // 旧 rpc 应 reject（桥层 'Browser reconnected'）
    const oldRPCResult = (await rpcPromise) as { ok?: boolean; error?: string }
    expect(oldRPCResult.ok).toBe(false)
    expect(String(oldRPCResult.error ?? '')).toContain('Browser reconnected')

    // 另一窗（other-win）应不受影响——能继续路由
    const otherRes = await rpc(port, {
      command: 'tool',
      args: { name: 'noop' },
      windowId: 'other-win'
    })
    expect(otherRes.status).toBe(200)
    expect(otherRes.json.ok).toBe(true)

    // 显式 windowId='shared-id' 现在应路由到新 ws（lastRegisteredWindowId 也是它）
    const newRes = await rpc(port, {
      command: 'tool',
      args: { name: 'noop' },
      windowId: 'shared-id'
    })
    expect(newRes.status).toBe(200)
    expect(newRes.json.ok).toBe(true)
    expect(newSharedFake?.receivedRequests.length).toBe(1)

    // 清理 newSharedWs（不在 topology.browsers 里）
    newSharedWs.close()
    pendingResolve?.(undefined)
    pendingReject?.(new Error('cleanup'))
  })

  // ⑥ 关窗 → 只 reject 该窗 pending，另一窗 sendRPC 仍通
  test('⑥ 关窗 → 只 reject 该窗 pending，另一窗 sendRPC 仍通', async () => {
    topology = await startBridgeWithBrowsers([
      { windowId: 'win-A', includeWindowIdInRegister: true },
      { windowId: 'win-B', includeWindowIdInRegister: true }
    ])
    const { port, browsers } = topology

    // 启动一个长回合 request 到 win-A（故意不立即应答）
    const winA = browsers[0]
    if (!winA) throw new Error('test fixture missing first browser')
    winA.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; id?: string }
      if (msg.type === 'request' && msg.id) {
        winA.receivedRequests.push({ id: msg.id, command: 'tool' })
        // 不应答——留在 pending
      }
    }
    const rpcPromise = fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`
      },
      body: JSON.stringify({ command: 'tool', args: { name: 'noop' }, windowId: 'win-A' })
    }).then(async (r) => {
      const json = (await r.json()) as { ok?: boolean; error?: string }
      return json
    })

    // 等请求抵达 win-A
    for (let i = 0; i < 50 && winA.receivedRequests.length === 0; i++) {
      await new Promise((r) => {
        setTimeout(r, 10)
      })
    }
    expect(winA.receivedRequests.length).toBe(1)

    // 关闭 win-A
    winA.ws.close()

    // 旧 rpc 应 reject（'Browser disconnected'）
    const oldRPC = await rpcPromise
    expect(oldRPC.ok).toBe(false)
    expect(String(oldRPC.error ?? '')).toContain('Browser disconnected')

    // 另一窗（win-B）应不受影响
    const otherRes = await rpc(port, {
      command: 'tool',
      args: { name: 'noop' },
      windowId: 'win-B'
    })
    expect(otherRes.status).toBe(200)
    expect(otherRes.json.ok).toBe(true)

    // 显式 windowId='win-A' 缺窗 → 502（APP_NOT_CONNECTED_MESSAGE）
    const missingRes = await rpc(port, {
      command: 'tool',
      args: { name: 'noop' },
      windowId: 'win-A'
    })
    expect(missingRes.status).toBe(502)
    expect(String(missingRes.json.error ?? '')).toContain('not connected')
  })

  // ⑦ register 无 windowId（旧客户端）→ 服务端分配 id 正常工作
  test('⑦ register 无 windowId（旧客户端）→ 服务端分配 id 正常工作', async () => {
    topology = await startBridgeWithBrowsers([
      { windowId: 'placeholder', includeWindowIdInRegister: false }
    ])
    const { port, browsers } = topology

    // 显式 windowId='placeholder' 应路由不到（旧客户端无 windowId，服务端分配了一个）
    const missingRes = await rpc(port, {
      command: 'tool',
      args: { name: 'noop' },
      windowId: 'placeholder'
    })
    expect(missingRes.status).toBe(502)

    // 无 windowId → 路由到该唯一窗（服务端分配的 id 在 lastRegisteredWindowId）
    const noWindowIdRes = await rpc(port, { command: 'tool', args: { name: 'noop' } })
    expect(noWindowIdRes.status).toBe(200)
    expect(noWindowIdRes.json.ok).toBe(true)
    expect(browsers[0]?.receivedRequests.length).toBe(1)
  })
})
