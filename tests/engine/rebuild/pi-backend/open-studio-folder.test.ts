/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * ai-panel-ux-consolidation：POST /api/pi/open-studio-folder 路由测试。
 *
 * opener 注入位禁真起 explorer/open/xdg-open（测试纪律 + 跨平台可靠性）。
 * 用 fake ChildProcess 桩（once('error', ...) 可调）覆盖：
 *  - win32 路径参数正确（注入桩断言传给桩的目录字符串）
 *  - spawn 同步抛错 → ok:false + 中文 error
 *  - 目录不存在时兜底 mkdir（用户目录由 service seed 本应已建；本测试不
 *    触发 seed，验证 handler 独立兜底——先删后 POST，仍应 ok:true 且目录回来）
 *  - 方法白名单 / 鉴权
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
        // oxlint-disable-next-line open-pencil/no-silent-catch -- 容错 skip 是 SDK 真语义：malformed 行静默跳过，非错误吞没
      } catch {
        // skip malformed
      }
    }
    return entries
  }
}))

import { type OpenStudioFolderResult } from '@/app/ai/pi-backend/client'
import { type OpenFolderOpener, createPiBackendServer } from '@/app/ai/pi-backend/server'

const TOKEN = 'open-folder-test-token'

let server: Server | null = null
let baseURL = ''
let rootDir = ''
let capturedOpens: string[] = []
let openerBehavior:
  | { kind: 'ok' }
  | { kind: 'syncThrow'; message: string }
  | { kind: 'asyncError'; message: string } = { kind: 'ok' }

/** 测试桩：opener 注入形态（接口同 server.ts 的 OpenFolderOpener）；
 *  返回 fake ChildProcess——同步抛错 / error 事件两边界均可模拟。
 *  不走真 spawn，符合测试纪律（禁 explorer/open/xdg-open）。 */
const openFolder: OpenFolderOpener = (dir: string) => {
  capturedOpens.push(dir)
  if (openerBehavior.kind === 'syncThrow') {
    throw new Error(openerBehavior.message)
  }
  // oxlint-disable-next-line unicorn/prefer-event-target -- server.ts handler 用 child.once('error') 是 Node EventEmitter 契约；测试桩必须同源接口
  const emitter = new EventEmitter() as EventEmitter & { unref: () => unknown }
  emitter.unref = () => undefined
  if (openerBehavior.kind === 'asyncError') {
    // 异步触发——响应已发，handler 仅记 warn 不改响应
    queueMicrotask(() => emitter.emit('error', new Error(openerBehavior.message)))
  }
  return emitter
}

async function boot(): Promise<void> {
  await teardown()
  rootDir = mkdtempSync(join(tmpdir(), 'pi-open-folder-'))
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

// 响应体形复用 client.ts 的 OpenStudioFolderResult（= PiVerifyResult）——
// 本地重声明会同形撞 type-shapes 重复门禁
async function openFolder_(headers: Record<string, string> = {}): Promise<{
  status: number
  body: OpenStudioFolderResult
}> {
  const res = await fetch(`${baseURL}/api/pi/open-studio-folder`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, ...headers }
  })
  return { status: res.status, body: (await res.json()) as OpenStudioFolderResult }
}

describe('POST /api/pi/open-studio-folder（ai-panel-ux-consolidation）', () => {
  test('happy path：传 userDir 给 opener，目录不存在时兜底 mkdir', async () => {
    openerBehavior = { kind: 'ok' }
    const r = await openFolder_()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    // opener 收到的目录 = rootDir/workspace/.agents（userDir 随 rootDir 走，
    // 2026-09-18 userdata 重排）
    expect(capturedOpens).toHaveLength(1)
    expect((capturedOpens[0] ?? '').replaceAll('\\', '/')).toBe(
      join(rootDir, 'workspace', '.agents').replaceAll('\\', '/')
    )
    // 兜底 mkdir 落地
    const stat = (await import('node:fs')).statSync(join(rootDir, 'workspace', '.agents'))
    expect(stat.isDirectory()).toBe(true)
  })

  test('目录已存在 → 不抛，opener 仍拿到 userDir', async () => {
    openerBehavior = { kind: 'ok' }
    // seed 应已建；显式再 mkdir 一次（验证幂等不误伤）
    mkdirSync(join(rootDir, 'workspace', '.agents'), { recursive: true })
    writeFileSync(join(rootDir, 'workspace', '.agents', 'README.md'), '# 占位', 'utf8')
    const r = await openFolder_()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(capturedOpens).toHaveLength(1)
  })

  test('spawn 同步抛错 → ok:false + 中文 error（响应未发先回）', async () => {
    openerBehavior = { kind: 'syncThrow', message: 'spawn xdg-open ENOENT' }
    const r = await openFolder_()
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(false)
    expect(r.body.error).toContain('打开文件夹失败')
    expect(r.body.error).toContain('spawn xdg-open ENOENT')
  })

  test('spawn error 事件异步到达 → 响应已发（仍 ok:true），handler 仅记 warn', async () => {
    // 桩内 queueMicrotask 派 error，handler 200 已先回；error 事件不污染响应。
    openerBehavior = { kind: 'asyncError', message: 'opener crashed' }
    const r = await openFolder_()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    // 让 microtask 跑完（避免 handler warn 影响后续）
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })
  })

  test('win32 路径参数正确——注入桩断言收到的字符串形态', async () => {
    // 测试桩不依赖 platform：handler 总是把 userDir 绝对路径当首参递给 opener。
    // 我们已通过 capturedOpens[0] 断言：它是 userDir（带反斜杠或正斜杠由 OS 决定）。
    // 该断言用 replaceAll('\\', '/') 跨平台比对，验证参数确实传入。
    openerBehavior = { kind: 'ok' }
    await openFolder_()
    const got = capturedOpens[0] ?? ''
    expect(got.length).toBeGreaterThan(0)
    expect(got.replaceAll('\\', '/').endsWith('/workspace/.agents')).toBe(true)
  })

  test('GET → 405', async () => {
    const res = await fetch(`${baseURL}/api/pi/open-studio-folder`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(405)
  })

  test('无 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/open-studio-folder`, { method: 'POST' })
    expect(res.status).toBe(401)
  })
})
