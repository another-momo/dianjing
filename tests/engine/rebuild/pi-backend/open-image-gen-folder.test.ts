/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * 图片本地留存目录打开端点（POST /api/pi/open-image-gen-folder）——
 * 同 open-studio-folder.test.ts 形态：opener 注入桩、禁真起 explorer/open/xdg-open；
 * 覆盖 happy path / 目录兜底 mkdir / 同步抛错 ok:false 中文 / 异步 error 仅 warn /
 * 方法白名单 / 鉴权。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
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
      return Promise.resolve() as Promise<void>
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
        // oxlint-disable-next-line open-pencil/no-silent-catch -- 容错 skip 是 SDK 真语义
      } catch {
        // skip malformed
      }
    }
    return entries
  }
}))

import { type OpenFolderOpener, createPiBackendServer } from '@/app/ai/pi-backend/server'

const TOKEN = 'open-image-gen-folder-test-token'

let server: Server | null = null
let baseURL = ''
let rootDir = ''
let capturedOpens: string[] = []
let openerBehavior:
  | { kind: 'ok' }
  | { kind: 'syncThrow'; message: string }
  | { kind: 'asyncError'; message: string } = { kind: 'ok' }

const openFolder: OpenFolderOpener = (dir: string) => {
  capturedOpens.push(dir)
  if (openerBehavior.kind === 'syncThrow') {
    throw new Error(openerBehavior.message)
  }
  // oxlint-disable-next-line unicorn/prefer-event-target -- handler 用 child.once('error') 是 Node EventEmitter 契约
  const emitter = new EventEmitter() as EventEmitter & { unref: () => unknown }
  emitter.unref = () => undefined
  if (openerBehavior.kind === 'asyncError') {
    queueMicrotask(() => emitter.emit('error', new Error(openerBehavior.message)))
  }
  return emitter
}

async function boot(): Promise<void> {
  await teardown()
  rootDir = mkdtempSync(join(tmpdir(), 'pi-open-image-gen-folder-'))
  mkdirSync(join(rootDir, 'pi-agent'), { recursive: true })
  const next = createPiBackendServer({ rootDir, authToken: TOKEN, openFolder })
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
  capturedOpens = []
  openerBehavior = { kind: 'ok' }
}

afterAll(async () => {
  await teardown()
})

beforeEach(async () => {
  await boot()
})

afterEach(async () => {
  await teardown()
})

async function openFolder_(): Promise<{ status: number; body: { ok: boolean; error?: string } }> {
  const res = await fetch(`${baseURL}/api/pi/open-image-gen-folder`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } }
}

describe('POST /api/pi/open-image-gen-folder（图片本地留存目录）', () => {
  test('happy path：传 <rootDir>/image-gen-output 给 opener，目录不存在时兜底 mkdir', async () => {
    openerBehavior = { kind: 'ok' }
    const r = await openFolder_()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(capturedOpens).toHaveLength(1)
    expect((capturedOpens[0] ?? '').replaceAll('\\', '/')).toBe(
      join(rootDir, 'image-gen-output').replaceAll('\\', '/')
    )
    // 兜底 mkdir 落地
    const stat = (await import('node:fs')).statSync(join(rootDir, 'image-gen-output'))
    expect(stat.isDirectory()).toBe(true)
  })

  test('目录已存在 → 不抛，opener 仍拿到正确目录', async () => {
    openerBehavior = { kind: 'ok' }
    mkdirSync(join(rootDir, 'image-gen-output'), { recursive: true })
    const r = await openFolder_()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(capturedOpens).toHaveLength(1)
  })

  test('spawn 同步抛错 → ok:false + 中文 error', async () => {
    openerBehavior = { kind: 'syncThrow', message: 'spawn xdg-open ENOENT' }
    const r = await openFolder_()
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(false)
    expect(r.body.error).toContain('打开文件夹失败')
    expect(r.body.error).toContain('spawn xdg-open ENOENT')
  })

  test('spawn error 事件异步到达 → 响应已发（仍 ok:true），handler 仅记 warn', async () => {
    openerBehavior = { kind: 'asyncError', message: 'opener crashed' }
    const r = await openFolder_()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })
  })

  test('GET → 405', async () => {
    const res = await fetch(`${baseURL}/api/pi/open-image-gen-folder`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(405)
  })

  test('无 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/open-image-gen-folder`, { method: 'POST' })
    expect(res.status).toBe(401)
  })
})
