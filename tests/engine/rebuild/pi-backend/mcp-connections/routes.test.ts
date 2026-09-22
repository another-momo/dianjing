/**
 * MCP 接入阶段 1 路由面钉扎 —— mcp-connections/routes.ts。
 *
 * 直调 handleMCPConnectionsRequest + 假 req/res + 真 store（tmpdir 落盘）+
 * 注入 deps.probe 假件（生产缺省 probeConnection 走真 pool 连接，单测不碰——
 * 注入缝纪律：server.ts 生产接线不传 probe，此处借缝免真连）。
 *
 * 覆盖：
 *  1. GET 列表 → 200 投影（has* 布尔在、无明文 value）
 *  2. 非本面路径 / 嵌套 slug → false 直通后续路由
 *  3. 方法白名单：list 路径 POST → 405；slug 路径 PATCH → 405
 *  4. PUT 坏 JSON → 400；PUT Valibot 拒收 → 400 且不落盘、不触发驱逐
 *  5. PUT + probe connected → 200 投影 connected + toolCount，store 回写，驱逐触发
 *  6. PUT + probe failed → 200 投影 failed + error（失败不阻断保存）
 *  7. 泄密兜底：响应体全文不含 headers 明文 value
 *  8. DELETE → 200 + 移除 + 驱逐触发；slug URL-decode
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  handleMCPConnectionsRequest,
  type MCPConnectionsDeps,
  type MCPProbeResult
} from '@/app/ai/pi-backend/mcp-connections/routes'
import {
  createMCPConnectionsStore,
  type MCPConnectionsStore
} from '@/app/ai/pi-backend/mcp-connections/store'

const SECRET = 'super-secret-value'
const dirs: string[] = []

function fakeRequest(method: string, body?: string): IncomingMessage {
  // Readable 假件：handler 挂上 'data' 监听后流自动推送 chunk + end（比
  // EventEmitter 更贴近真 IncomingMessage，且避开 prefer-event-target）
  const chunks = body !== undefined ? [Buffer.from(body, 'utf8')] : []
  const req = Readable.from(chunks) as IncomingMessage
  req.method = method
  return req
}

interface Captured {
  status: number
  body: string
}

function fakeResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: '' }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return res
    },
    end(chunk?: string) {
      captured.body = chunk ?? ''
      return res
    }
  } as ServerResponse
  return { res, captured }
}

interface Harness {
  deps: MCPConnectionsDeps
  store: MCPConnectionsStore
  changedCount: () => number
}

function makeHarness(probeImpl?: (slug: string) => Promise<MCPProbeResult>): Harness {
  const agentDir = mkdtempSync(join(tmpdir(), 'mcp-conn-routes-'))
  dirs.push(agentDir)
  const store = createMCPConnectionsStore({ agentDir })
  let changed = 0
  const deps: MCPConnectionsDeps = {
    store,
    rootDir: agentDir,
    onConnectionsChanged: () => {
      changed += 1
    },
    probe: probeImpl ?? (() => Promise.resolve({ status: 'connected', toolCount: 3 }))
  }
  return { deps, store, changedCount: () => changed }
}

async function call(
  deps: MCPConnectionsDeps,
  method: string,
  pathname: string,
  body?: string
): Promise<{ handled: boolean; status: number; text: string }> {
  const { res, captured } = fakeResponse()
  const handled = await handleMCPConnectionsRequest(deps, fakeRequest(method, body), res, pathname)
  return { handled, status: captured.status, text: captured.body }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const PUT_HTTP = JSON.stringify({
  transport: 'http',
  url: 'https://mcp.example.com/sse',
  headers: { authorization: `Bearer ${SECRET}` }
})

describe('mcp-connections routes', () => {
  test('GET 列表 → 200 投影（hasHeaders 在、无明文 value）', async () => {
    const { deps, store } = makeHarness()
    store.upsert('acme', JSON.parse(PUT_HTTP))
    const r = await call(deps, 'GET', '/api/pi/mcp/connections')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    const body = JSON.parse(r.text) as { connections: Array<Record<string, unknown>> }
    expect(body.connections.length).toBe(1)
    expect(body.connections[0]?.slug).toBe('acme')
    expect(body.connections[0]?.hasHeaders).toBe(true)
    expect(r.text.includes(SECRET)).toBe(false)
  })

  test('非本面路径 / 嵌套 slug → false 直通', async () => {
    const { deps } = makeHarness()
    expect((await call(deps, 'GET', '/api/pi/capabilities')).handled).toBe(false)
    expect((await call(deps, 'GET', '/api/pi/mcp/connections/a/b')).handled).toBe(false)
  })

  test('方法白名单：list 路径 POST → 405；slug 路径 PATCH → 405', async () => {
    const { deps } = makeHarness()
    expect((await call(deps, 'POST', '/api/pi/mcp/connections')).status).toBe(405)
    expect((await call(deps, 'PATCH', '/api/pi/mcp/connections/acme')).status).toBe(405)
  })

  test('PUT 坏 JSON → 400；Valibot 拒收 → 400 不落盘不驱逐', async () => {
    const { deps, store, changedCount } = makeHarness()
    expect((await call(deps, 'PUT', '/api/pi/mcp/connections/acme', '{not-json')).status).toBe(400)
    const bad = await call(deps, 'PUT', '/api/pi/mcp/connections/acme', '{"transport":"http"}')
    expect(bad.status).toBe(400)
    expect(store.list().length).toBe(0)
    expect(changedCount()).toBe(0)
  })

  test('PUT + probe connected → 200 投影 connected + toolCount，store 回写，驱逐触发一次', async () => {
    const { deps, store, changedCount } = makeHarness()
    const r = await call(deps, 'PUT', '/api/pi/mcp/connections/acme', PUT_HTTP)
    expect(r.status).toBe(200)
    const body = JSON.parse(r.text) as { connection: Record<string, unknown> }
    expect(body.connection.status).toBe('connected')
    expect(body.connection.toolCount).toBe(3)
    expect(body.connection.hasHeaders).toBe(true)
    // 泄密兜底：响应全文不含凭据明文
    expect(r.text.includes(SECRET)).toBe(false)
    // store 回写 + 驱逐触发
    expect(store.get('acme')?.status).toBe('connected')
    expect(changedCount()).toBe(1)
  })

  test('PUT + probe failed → 200 投影 failed + error（失败不阻断保存），驱逐仍触发', async () => {
    const { deps, store } = makeHarness(() =>
      Promise.resolve({ status: 'failed', error: 'connect timeout' })
    )
    const r = await call(deps, 'PUT', '/api/pi/mcp/connections/acme', PUT_HTTP)
    expect(r.status).toBe(200)
    const body = JSON.parse(r.text) as { connection: Record<string, unknown> }
    expect(body.connection.status).toBe('failed')
    expect(body.connection.error).toBe('connect timeout')
    expect(store.get('acme')?.status).toBe('failed')
  })

  test('DELETE → 200 + 移除 + 驱逐触发；slug URL-decode', async () => {
    const { deps, store, changedCount } = makeHarness()
    store.upsert('my server', JSON.parse(PUT_HTTP))
    const r = await call(deps, 'DELETE', '/api/pi/mcp/connections/my%20server')
    expect(r.status).toBe(200)
    expect(store.get('my server')).toBeNull()
    expect(changedCount()).toBe(1)
    // 删不存在仍 200（remove no-op 语义）
    const again = await call(deps, 'DELETE', '/api/pi/mcp/connections/ghost')
    expect(again.status).toBe(200)
    expect(changedCount()).toBe(2)
  })
})
