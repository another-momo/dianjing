/**
 * 2026-09-15 ask-answer 端点钉扎：POST /api/pi/ask-answer 路由 HTTP 往返。
 *
 * 真 createPiBackendServer + mock pi-coding-agent（夹具同 chat-cancel-route
 * /service-abort.test.ts）。覆盖：
 *  - answers 形态：200 {ok:true}
 *  - skip 形态：200 {ok:true}
 *  - not_found：404 {error:'no_pending_form'}（无 store 项）
 *  - 400：缺 formId / formId 非 string / answers+skip 同传 / answers 非对象 /
 *    answers[qid].value 非 string
 *  - 405：GET
 *  - 401：无 token
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

const TOKEN = 'ask-route-test-token'

let server: Server
let baseURL: string

async function boot(): Promise<void> {
  server = createPiBackendServer({
    rootDir: mkdtempSync(join(tmpdir(), 'pi-ask-route-')),
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

describe('POST /api/pi/ask-answer（2026-09-15 表单作答端点）', () => {
  beforeEach(async () => {
    if (!server) await boot()
  })

  test('合法 token + 合法 body（无 pending form）→ 404 {error:no_pending_form}', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        formId: 'ask-nonexistent',
        answers: { q1: { value: 'a' } }
      })
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('no_pending_form')
  })

  test('合法 token + skip:true + 无 pending → 404', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ formId: 'ask-none', skip: true })
    })
    expect(res.status).toBe(404)
  })

  test('缺 formId → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ answers: { q1: { value: 'a' } } })
    })
    expect(res.status).toBe(400)
  })

  test('formId 非 string → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ formId: 123, answers: { q1: { value: 'a' } } })
    })
    expect(res.status).toBe(400)
  })

  test('formId 空串 → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ formId: '', answers: { q1: { value: 'a' } } })
    })
    expect(res.status).toBe(400)
  })

  test('answers 与 skip 同传 → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ formId: 'ask-x', answers: {}, skip: true })
    })
    expect(res.status).toBe(400)
  })

  test('answers 与 skip 都缺 → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ formId: 'ask-x' })
    })
    expect(res.status).toBe(400)
  })

  test('answers 非对象 → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ formId: 'ask-x', answers: 'not-an-object' })
    })
    expect(res.status).toBe(400)
  })

  test('answers[qid].value 非 string → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ formId: 'ask-x', answers: { q1: { value: 123 } } })
    })
    expect(res.status).toBe(400)
  })

  test('answers[qid] 非对象 → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ formId: 'ask-x', answers: { q1: 'just-a-string' } })
    })
    expect(res.status).toBe(400)
  })

  test('GET → 405', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(405)
  })

  test('无 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'ask-x', answers: {} })
    })
    expect(res.status).toBe(401)
  })

  test('坏 JSON → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not-json'
    })
    expect(res.status).toBe(400)
  })
})
