/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * T87：GET/PUT /api/pi/capabilities 路由的 HTTP 往返。
 * T96：v2 形状（builtinTools 三档）+ PUT 三档校验 + 部分更新（缺省保留旧值）。
 *
 * 真 createPiBackendServer + mock pi-coding-agent（夹具同 chat-cancel-route）。
 * 覆盖：GET 缺省 DEFAULTS / PUT ON 落盘回读 / PUT 非布尔 400 / 方法白名单 /
 * 鉴权（无 token 401）。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
    async reload(): Promise<void> {
      // eslint-disable-next-line no-promise-executor-return -- 同步桩返回
      return Promise.resolve() as Promise<void>
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
  // 这里用 SDK 同等语义的 15 行纯函数（JSONL 逐行 JSON.parse，容错 skip）。
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

const TOKEN = 't87-cap-route-token'

let server: Server | null = null
let baseURL = ''
let rootDir = ''

async function boot(): Promise<void> {
  // 每测试独立 fresh rootDir：避免状态跨用例污染（capabilities.json 持久化）
  await teardown()
  rootDir = mkdtempSync(join(tmpdir(), 'pi-cap-route-'))
  mkdirSync(join(rootDir, 'pi-agent'), { recursive: true })
  const next = createPiBackendServer({ rootDir, authToken: TOKEN })
  await new Promise<void>((resolve) => {
    next.listen(0, '127.0.0.1', resolve)
  })
  const address = next.address()
  if (!address || typeof address === 'string') throw new Error('no ephemeral port')
  server = next
  baseURL = `http://127.0.0.1:${address.port}`
}

async function teardown(): Promise<void> {
  if (server) {
    const s = server
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
    })
    server = null
  }
  if (rootDir) {
    rmSync(rootDir, { recursive: true, force: true })
    rootDir = ''
  }
  baseURL = ''
}

afterAll(async () => {
  await teardown()
})

type CapabilitiesBody = { builtinTools: string; agentSkills: boolean }

async function getCapabilities(): Promise<{ status: number; body: CapabilitiesBody }> {
  const res = await fetch(`${baseURL}/api/pi/capabilities`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  return { status: res.status, body: (await res.json()) as CapabilitiesBody }
}

async function putCapabilities(payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseURL}/api/pi/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload)
  })
  return { status: res.status, body: await res.json() }
}

describe('GET/PUT /api/pi/capabilities（T87）', () => {
  beforeEach(async () => {
    await boot()
  })

  test('GET 缺省 DEFAULTS（2026-09-22 翻转 full+true）', async () => {
    const r = await getCapabilities()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ builtinTools: 'full', agentSkills: true })
  })

  test('PUT ON → 落盘 + 后续 GET 返 ON（同实例）', async () => {
    const put = await putCapabilities({ agentSkills: true, builtinTools: 'full' })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ builtinTools: 'full', agentSkills: true })

    const get1 = await getCapabilities()
    expect(get1.body).toEqual({ builtinTools: 'full', agentSkills: true })

    // 验证文件持久化：关闭 server，新 server 实例（同一 rootDir）应能读到 ON
    if (server) {
      const s = server
      await new Promise<void>((resolve) => {
        s.close(() => resolve())
      })
    }
    const next = createPiBackendServer({ rootDir, authToken: TOKEN })
    await new Promise<void>((resolve) => {
      next.listen(0, '127.0.0.1', resolve)
    })
    const address = next.address()
    server = next
    if (!address || typeof address === 'string') throw new Error('no ephemeral port')
    baseURL = `http://127.0.0.1:${address.port}`

    const get2 = await getCapabilities()
    expect(get2.body).toEqual({ builtinTools: 'full', agentSkills: true })
  })

  test('PUT 非布尔 → 400（不动落盘）', async () => {
    const put1 = await putCapabilities({ agentSkills: 'yes' })
    expect(put1.status).toBe(400)
    const put2 = await putCapabilities({ agentSkills: 1 })
    expect(put2.status).toBe(400)
    const get = await getCapabilities()
    expect(get.body).toEqual({ builtinTools: 'full', agentSkills: true })
  })

  test('T96 PUT 非法 builtinTools → 400（不动落盘）', async () => {
    const put1 = await putCapabilities({ agentSkills: true, builtinTools: 'everything' })
    expect(put1.status).toBe(400)
    const put2 = await putCapabilities({ agentSkills: true, builtinTools: 1 })
    expect(put2.status).toBe(400)
    const get = await getCapabilities()
    expect(get.body).toEqual({ builtinTools: 'full', agentSkills: true })
  })

  test('T96 PUT 只给 agentSkills → builtinTools 保留旧值（部分更新）', async () => {
    const put1 = await putCapabilities({ agentSkills: true, builtinTools: 'readonly' })
    expect(put1.status).toBe(200)
    const put2 = await putCapabilities({ agentSkills: false })
    expect(put2.status).toBe(200)
    expect(put2.body).toEqual({ builtinTools: 'readonly', agentSkills: false })
    const get = await getCapabilities()
    expect(get.body).toEqual({ builtinTools: 'readonly', agentSkills: false })
  })

  test('PUT OFF → 关闭后 skills=[]（listSkills 守门）', async () => {
    await putCapabilities({ agentSkills: false })
    const get = await getCapabilities()
    // builtinTools 缺省保留旧值（缺省 'full'）；agentSkills 显式 false
    expect(get.body).toEqual({ builtinTools: 'full', agentSkills: false })
  })

  test('POST/DELETE → 405（方法白名单）', async () => {
    const post = await fetch(`${baseURL}/api/pi/capabilities`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(post.status).toBe(405)
    const del = await fetch(`${baseURL}/api/pi/capabilities`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(del.status).toBe(405)
  })

  test('无 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/capabilities`)
    expect(res.status).toBe(401)
  })

  test('带错 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/capabilities`, {
      headers: { authorization: 'Bearer wrong-token' }
    })
    expect(res.status).toBe(401)
  })

  test('PUT 坏 JSON → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/capabilities`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not-json'
    })
    expect(res.status).toBe(400)
  })

  test('manifest 端点同时透传 capabilities + skills', async () => {
    const res = await fetch(`${baseURL}/api/pi/studio/manifest`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { capabilities?: unknown; skills?: unknown }
    expect(body.capabilities).toEqual({ builtinTools: 'full', agentSkills: true })
    expect(body.skills).toEqual([])
  })
})
