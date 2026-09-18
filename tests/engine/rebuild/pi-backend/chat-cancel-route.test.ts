/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * T73 钉扎：POST /api/pi-chat/cancel 路由的 HTTP 往返。
 *
 * 真 createPiBackendServer + mock pi-coding-agent（夹具同 service-abort.test.ts）：
 * 先经 /api/pi-chat 建立会话（mock session.prompt 立即完成），再 POST cancel
 * 验证 service.abort 送达 session.abort。鉴权/方法/幂等语义无回归。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const abortSpy = mock(() => Promise.resolve())

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({
    session: {
      prompt: () => Promise.resolve(),
      subscribe: () => () => undefined,
      abort: () => abortSpy(),
      sessionManager: { getSessionFile: () => null }
    }
  }),
  DefaultResourceLoader: class {
    reload(): Promise<void> {
      return Promise.resolve()
    }
  },
  SessionManager: {
    create: () => ({ getSessionFile: () => null }),
    open: () => ({ getSessionFile: () => null })
  },
  defineTool: (def: unknown) => def,
  // T91c 修复：mock.module 是 process 级（bun:test 语义），
  // 同批跑的 marketing/ask-user-question-roundtrip.test.ts 用 readPiHistoryFile
  // 依赖真 parseSessionEntries；stub 成 () => [] 会让 roundtrip 测试拿到空历史。
  parseSessionEntries: (content: string): unknown[] => {
    const entries: unknown[] = []
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
        // oxlint-disable-next-line open-pencil/no-silent-catch -- 容错 skip 是 SDK 真语义：malformed 行静默跳过，非错误吞没
      } catch {
        // skip malformed
      }
    }
    return entries
  }
}))

import { createPiBackendServer } from '@/app/ai/pi-backend/server'

const TOKEN = 't73-test-token'

let server: Server
let baseURL: string

async function boot(): Promise<void> {
  server = createPiBackendServer({
    rootDir: mkdtempSync(join(tmpdir(), 'pi-cancel-route-')),
    authToken: TOKEN
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no ephemeral port')
  baseURL = `http://127.0.0.1:${address.port}`
}

afterAll(() => {
  server?.close()
})

async function postChat(sessionId: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/pi-chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      sessionId,
      // T100：spec 必填——seed openrouter/free，与测试夹具自洽
      model: { providerId: 'openrouter', modelId: 'openrouter/free' },
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }]
    })
  })
  await res.text() // 读完 SSE 至 [DONE]
}

describe('POST /api/pi-chat/cancel（T73 显式取消端点）', () => {
  beforeEach(async () => {
    abortSpy.mockReset()
    abortSpy.mockImplementation(() => Promise.resolve())
    if (!server) await boot()
  })

  test('已建会话 + 合法 token → 204 且 session.abort 送达', async () => {
    await postChat('sess-route-t73')
    expect(abortSpy).toHaveBeenCalledTimes(0)

    const res = await fetch(`${baseURL}/api/pi-chat/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: 'sess-route-t73' })
    })
    expect(res.status).toBe(204)
    expect(abortSpy).toHaveBeenCalledTimes(1)
  })

  test('未知 sessionId → 204 幂等 no-op（abortSpy 零调用）', async () => {
    const res = await fetch(`${baseURL}/api/pi-chat/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: 'sess-never-seen' })
    })
    expect(res.status).toBe(204)
    expect(abortSpy).toHaveBeenCalledTimes(0)
  })

  test('无 token → 401（T28 鉴权伞覆盖本端点）', async () => {
    const res = await fetch(`${baseURL}/api/pi-chat/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-route-t73' })
    })
    expect(res.status).toBe(401)
  })

  test('GET → 405；坏 JSON → 400；缺 sessionId → 400', async () => {
    const getRes = await fetch(`${baseURL}/api/pi-chat/cancel`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(getRes.status).toBe(405)

    const badJSON = await fetch(`${baseURL}/api/pi-chat/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{oops'
    })
    expect(badJSON.status).toBe(400)

    const noSession = await fetch(`${baseURL}/api/pi-chat/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({})
    })
    expect(noSession.status).toBe(400)
  })
})
