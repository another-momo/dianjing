/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * 2026-09-19 broker P1 件1：POST /api/pi/decision-answer 路由 HTTP 往返钉扎
 * （ask/authz 统一决断端点，kind 判别分流；并行线冻结契约 body 字段名禁改）。
 *
 * 真 createPiBackendServer + mock pi-coding-agent（夹具同 chat-cancel-route.test.ts）。
 * 覆盖：
 *  - kind：缺失/非法值 → 400
 *  - formId：缺失/空串/非 string → 400
 *  - ask 族：decision 'answer' + answers（per-entry 校验）→ 404（无 pending）；
 *    'answer' 缺 answers → 400；'skip'（含 note）→ 404；decision 非法 → 400
 *  - authz 族：'allow-once' → 404；'allow-rule' 缺 ruleText → 400、带 ruleText
 *    → 404；'deny' + note → 404；decision 非法 → 400
 *  - 405：GET；401：无 token；400：坏 JSON
 *  - A线尾单件3：旧 /api/pi/ask-answer 端点已删 → 404；ask 族 per-entry 校验
 *    矩阵（values/notes 形态）自 ask/answer-route.test.ts 迁移（统一端点
 *    kind:'ask' 重写——parser 单源已随件3搬入 decision-answer-route.ts）
 * resolve 真值（ok 路径）挂在 pending-decision.test.ts 单元层（store 无 HTTP 面）。
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({
    session: {
      prompt: () => Promise.resolve(),
      subscribe: () => () => undefined,
      abort: () => Promise.resolve(),
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

const TOKEN = 'decision-route-test-token'

let server: Server
let baseURL: string

async function boot(): Promise<void> {
  server = createPiBackendServer({
    rootDir: mkdtempSync(join(tmpdir(), 'pi-decision-route-')),
    authToken: TOKEN
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no ephemeral port')
  baseURL = `http://127.0.0.1:${address.port}`
}

function post(body: unknown): Promise<Response> {
  return fetch(`${baseURL}/api/pi/decision-answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  })
}

afterAll(() => {
  server?.close()
})

describe('POST /api/pi/decision-answer（2026-09-19 统一决断端点）', () => {
  beforeEach(async () => {
    if (!server) await boot()
  })

  test('kind 缺失 → 400', async () => {
    const res = await post({ formId: 'f', decision: 'deny' })
    expect(res.status).toBe(400)
  })

  test('kind 非法值 → 400', async () => {
    const res = await post({ kind: 'exec', formId: 'f', decision: 'deny' })
    expect(res.status).toBe(400)
  })

  test('formId 缺失 → 400', async () => {
    const res = await post({ kind: 'authz', decision: 'deny' })
    expect(res.status).toBe(400)
  })

  test('formId 空串 → 400', async () => {
    const res = await post({ kind: 'authz', formId: '', decision: 'deny' })
    expect(res.status).toBe(400)
  })

  test('formId 非 string → 400', async () => {
    const res = await post({ kind: 'authz', formId: 42, decision: 'deny' })
    expect(res.status).toBe(400)
  })

  test('ask + decision answer + answers 合法形态 → 404（无 pending，路由形态已过）', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-none',
      decision: 'answer',
      answers: { q1: { value: 'a' } }
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('no_pending_form')
  })

  test('ask + decision answer 缺 answers → 400', async () => {
    const res = await post({ kind: 'ask', formId: 'ask-x', decision: 'answer' })
    expect(res.status).toBe(400)
  })

  test('ask + decision answer + answers 非对象 → 400（复用 ask parser）', async () => {
    const res = await post({ kind: 'ask', formId: 'ask-x', decision: 'answer', answers: 'nope' })
    expect(res.status).toBe(400)
  })

  test('ask + decision skip → 404', async () => {
    const res = await post({ kind: 'ask', formId: 'ask-none', decision: 'skip' })
    expect(res.status).toBe(404)
  })

  test('ask + decision skip + note → 404（note 在契约接受之列）', async () => {
    const res = await post({ kind: 'ask', formId: 'ask-none', decision: 'skip', note: '先跳过' })
    expect(res.status).toBe(404)
  })

  test('ask + decision 非法值 → 400', async () => {
    const res = await post({ kind: 'ask', formId: 'ask-x', decision: 'allow-once' })
    expect(res.status).toBe(400)
  })

  test('authz + allow-once → 404', async () => {
    const res = await post({ kind: 'authz', formId: 'authz-none', decision: 'allow-once' })
    expect(res.status).toBe(404)
  })

  test('authz + allow-rule 缺 ruleText → 400', async () => {
    const res = await post({ kind: 'authz', formId: 'authz-x', decision: 'allow-rule' })
    expect(res.status).toBe(400)
  })

  test('authz + allow-rule + ruleText 空白 → 400', async () => {
    const res = await post({
      kind: 'authz',
      formId: 'authz-x',
      decision: 'allow-rule',
      ruleText: '   '
    })
    expect(res.status).toBe(400)
  })

  test('authz + allow-rule + ruleText → 404', async () => {
    const res = await post({
      kind: 'authz',
      formId: 'authz-none',
      decision: 'allow-rule',
      ruleText: 'bun test *'
    })
    expect(res.status).toBe(404)
  })

  test('authz + deny + note → 404', async () => {
    const res = await post({
      kind: 'authz',
      formId: 'authz-none',
      decision: 'deny',
      note: '别跑这个'
    })
    expect(res.status).toBe(404)
  })

  test('authz + decision 非法值 → 400', async () => {
    const res = await post({ kind: 'authz', formId: 'authz-x', decision: 'answer' })
    expect(res.status).toBe(400)
  })

  test('GET → 405', async () => {
    const res = await fetch(`${baseURL}/api/pi/decision-answer`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(405)
  })

  test('无 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/decision-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'authz', formId: 'f', decision: 'deny' })
    })
    expect(res.status).toBe(401)
  })

  test('坏 JSON → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/decision-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not-json'
    })
    expect(res.status).toBe(400)
  })
})

/**
 * 2026-09-19 A线尾单件3：旧 /api/pi/ask-answer 端点删除钉扎 + ask 族 per-entry
 * 校验矩阵迁移（原 ask/answer-route.test.ts 波2 组，统一端点 kind:'ask' 重写）。
 * 无 store 项时合法形态一律 404（端到端只测路由形态；resolve 真值在
 * pending-decision.test.ts / ask/user-question-tool.test.ts）。
 */
describe('A线尾单件3：旧端点删除与 ask 族校验矩阵迁移', () => {
  beforeEach(async () => {
    if (!server) await boot()
  })

  test('旧 /api/pi/ask-answer 端点已删除 → 404（带合法 token，穿过鉴权后无路由）', async () => {
    const res = await fetch(`${baseURL}/api/pi/ask-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ formId: 'ask-none', answers: { q1: { value: 'a' } } })
    })
    expect(res.status).toBe(404)
  })

  test('values 形态（非空 string 数组）→ 404（无 pending，路由形态已过）', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-none',
      decision: 'answer',
      answers: { q1: { values: ['a', 'b'] } }
    })
    expect(res.status).toBe(404)
  })

  test('values 空数组 + 无 value → 400（无合法 value/values）', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-x',
      decision: 'answer',
      answers: { q1: { values: [] } }
    })
    expect(res.status).toBe(400)
  })

  test('value 与 values 同时给 → 404（路由允许；两者形态合法）', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-none',
      decision: 'answer',
      answers: { q1: { value: 'a', values: ['a', 'b'] } }
    })
    expect(res.status).toBe(404)
  })

  test('values 含空白项 → 路由过滤后形态合法 → 404', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-none',
      decision: 'answer',
      answers: { q1: { values: ['a', '   ', 'b'] } }
    })
    expect(res.status).toBe(404)
  })

  test('values 含非 string 项 → 400', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-x',
      decision: 'answer',
      answers: { q1: { values: ['a', 2] } }
    })
    expect(res.status).toBe(400)
  })

  test('answers[qid] 非对象 → 400', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-x',
      decision: 'answer',
      answers: { q1: 'just-a-string' }
    })
    expect(res.status).toBe(400)
  })

  test('answers[qid].value 非 string 且无其他字段 → 400（无合法作答字段）', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-x',
      decision: 'answer',
      answers: { q1: { value: 123 } }
    })
    expect(res.status).toBe(400)
  })

  test('per-entry notes 字段 → 404（路由形态合法）', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-none',
      decision: 'answer',
      answers: { q1: { value: 'a', notes: '倾向 A' } }
    })
    expect(res.status).toBe(404)
  })

  test('notes 独存（无 value/values）→ 404（与 core normalizeQuestionAnswer 同律）', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-none',
      decision: 'answer',
      answers: { q1: { notes: '这题只想留备注' } }
    })
    expect(res.status).toBe(404)
  })

  test('answer + 顶层 note 透传 → 404（note 映射 payload.notes，契约接受之列）', async () => {
    const res = await post({
      kind: 'ask',
      formId: 'ask-none',
      decision: 'answer',
      answers: { q1: { value: 'a' } },
      note: '整体方向偏极简'
    })
    expect(res.status).toBe(404)
  })
})
