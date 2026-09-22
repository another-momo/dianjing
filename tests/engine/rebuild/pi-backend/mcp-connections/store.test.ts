/**
 * MCP 接入阶段 1 凭据 store 钉扎 —— mcp-connections/store.ts。
 *
 * 覆盖：
 *  1. upsert http / stdio + get/list 回读（status 强制 untested，入参 status 被剥）
 *  2. listPublic / toPublic 投影——headers / env value 永不外露，只给 has* 布尔
 *  3. Valibot 拒收：坏 transport / http 缺 url / stdio 缺 command / 空 header value
 *  4. 持久化：reloadForTests 重读盘仍在；坏文件回空集（fail-safe 不抛）
 *  5. updateStatus：connected 写 toolCount 且清旧 error；failed 写 error；未知 slug no-op
 *  6. remove：删空后 unlink 文件（exists() false）；删不存在 no-op
 *  7. get/list 深拷贝隔断——调用方改返回值不污染缓存
 *  8. toSdkConfig 派生：http/stdio 形态 + headers/env 直通（pool 装配面，非投影面）
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMCPConnectionsStore,
  toPublic,
  toSdkConfig,
  type MCPConnection,
  type MCPConnectionConfig,
  type MCPConnectionsStore
} from '@/app/ai/pi-backend/mcp-connections/store'

const dirs: string[] = []

function makeStore(): { store: MCPConnectionsStore; agentDir: string; filePath: string } {
  const agentDir = mkdtempSync(join(tmpdir(), 'mcp-conn-store-'))
  dirs.push(agentDir)
  return {
    store: createMCPConnectionsStore({ agentDir }),
    agentDir,
    filePath: join(agentDir, 'mcp-connections.json')
  }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const HTTP_INPUT: MCPConnectionConfig = {
  transport: 'http',
  url: 'https://mcp.example.com/sse',
  headers: { authorization: 'Bearer super-secret-value' }
}

const STDIO_INPUT: MCPConnectionConfig = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@acme/mcp-server'],
  env: { ACME_TOKEN: 'env-secret-value' }
}

describe('mcp-connections store', () => {
  test('upsert http + get/list 回读，status 强制 untested（入参 status 被 schema 剥除）', () => {
    const { store } = makeStore()
    // 前端恶意/误带 status 字段——Valibot object 只取已知键，落盘形强制 untested
    // JSON.parse 模拟线上入包（返回值 any，单断言传 upsert 形）
    const input = JSON.parse(
      '{"transport":"http","url":"https://mcp.example.com/sse","headers":{"authorization":"Bearer super-secret-value"},"status":"connected","toolCount":99}'
    ) as MCPConnectionConfig
    const saved = store.upsert('acme', input)
    expect(saved.status).toBe('untested')
    expect(saved.toolCount).toBeUndefined()

    const got = store.get('acme')
    expect(got?.url).toBe('https://mcp.example.com/sse')
    expect(got?.headers).toEqual({ authorization: 'Bearer super-secret-value' })
    expect(store.list().length).toBe(1)
    expect(store.get('missing')).toBeNull()
  })

  test('upsert stdio + 回读 args/env', () => {
    const { store } = makeStore()
    store.upsert('local', STDIO_INPUT)
    const got = store.get('local')
    expect(got?.transport).toBe('stdio')
    expect(got?.command).toBe('npx')
    expect(got?.args).toEqual(['-y', '@acme/mcp-server'])
    expect(got?.env).toEqual({ ACME_TOKEN: 'env-secret-value' })
  })

  test('listPublic 投影：has* 布尔在、headers/env 键与明文 value 永不外露', () => {
    const { store } = makeStore()
    store.upsert('acme', HTTP_INPUT)
    store.upsert('local', STDIO_INPUT)
    const publicList = store.listPublic()
    expect(publicList.length).toBe(2)

    const acme = publicList.find((c) => c.slug === 'acme')
    expect(acme?.hasHeaders).toBe(true)
    expect(acme?.url).toBe('https://mcp.example.com/sse')
    expect('headers' in (acme ?? {})).toBe(false)

    const local = publicList.find((c) => c.slug === 'local')
    expect(local?.hasEnv).toBe(true)
    expect(local?.command).toBe('npx')
    expect(local?.args).toEqual(['-y', '@acme/mcp-server'])
    expect('env' in (local ?? {})).toBe(false)

    // 序列化全文不含任何凭据明文（响应面兜底钉扎）
    const serialized = JSON.stringify(publicList)
    expect(serialized.includes('super-secret-value')).toBe(false)
    expect(serialized.includes('env-secret-value')).toBe(false)
  })

  test('toPublic 直连：toolCount/error 仅在有值时投影；无凭据连接 has* = false', () => {
    const conn: MCPConnection = {
      slug: 's',
      transport: 'http',
      url: 'https://x.example.com',
      status: 'failed',
      error: 'boom'
    }
    const pub = toPublic(conn)
    expect(pub.hasHeaders).toBe(false)
    expect(pub.hasEnv).toBe(false)
    expect(pub.error).toBe('boom')
    expect(pub.toolCount).toBeUndefined()
  })

  test('Valibot 拒收：坏 transport / http 缺 url / stdio 缺 command / 空 header value', () => {
    const { store } = makeStore()
    // 非法形状经 JSON.parse 构造（any 单断言）——直接字面量会被 TS 提前拦下
    const bad1 = JSON.parse('{"transport":"websocket","url":"https://x"}') as MCPConnectionConfig
    expect(() => store.upsert('a', bad1)).toThrow()
    const bad2: MCPConnectionConfig = { transport: 'http' }
    expect(() => store.upsert('b', bad2)).toThrow()
    const bad3: MCPConnectionConfig = { transport: 'stdio' }
    expect(() => store.upsert('c', bad3)).toThrow()
    const bad4: MCPConnectionConfig = {
      transport: 'http',
      url: 'https://x',
      headers: { authorization: '' }
    }
    expect(() => store.upsert('d', bad4)).toThrow()
    expect(store.list().length).toBe(0)
    expect(store.exists()).toBe(false)
  })

  test('持久化：reloadForTests 重读盘仍在；文件落盘含凭据明文（存储面非投影面）', () => {
    const { store, filePath } = makeStore()
    store.upsert('acme', HTTP_INPUT)
    expect(existsSync(filePath)).toBe(true)
    const onDisk = readFileSync(filePath, 'utf8')
    expect(onDisk.includes('super-secret-value')).toBe(true)

    store.reloadForTests()
    const got = store.get('acme')
    expect(got?.headers).toEqual({ authorization: 'Bearer super-secret-value' })
  })

  test('坏文件回空集不抛（凭据面 fail-safe）', () => {
    const { store, filePath } = makeStore()
    writeFileSync(filePath, '{not-json', 'utf8')
    store.reloadForTests()
    expect(store.list()).toEqual([])
    // 形状坏（version 错）同律
    writeFileSync(filePath, JSON.stringify({ version: 2, connections: {} }), 'utf8')
    store.reloadForTests()
    expect(store.list()).toEqual([])
  })

  test('updateStatus：connected 写 toolCount 且清旧 error；failed 写 error；未知 slug no-op', () => {
    const { store } = makeStore()
    store.upsert('acme', HTTP_INPUT)
    store.updateStatus('acme', { status: 'failed', error: 'connect timeout' })
    expect(store.get('acme')?.status).toBe('failed')
    expect(store.get('acme')?.error).toBe('connect timeout')

    store.updateStatus('acme', { status: 'connected', toolCount: 7 })
    const ok = store.get('acme')
    expect(ok?.status).toBe('connected')
    expect(ok?.toolCount).toBe(7)
    expect(ok?.error).toBeUndefined()

    // 未知 slug no-op（不抛、不造记录）
    store.updateStatus('ghost', { status: 'connected', toolCount: 1 })
    expect(store.get('ghost')).toBeNull()
  })

  test('remove：删空后 unlink 文件；删不存在 no-op', () => {
    const { store, filePath } = makeStore()
    store.remove('ghost')
    expect(store.exists()).toBe(false)

    store.upsert('a', HTTP_INPUT)
    store.upsert('b', HTTP_INPUT)
    store.remove('a')
    expect(store.get('a')).toBeNull()
    expect(store.exists()).toBe(true)
    store.remove('b')
    expect(store.list()).toEqual([])
    expect(existsSync(filePath)).toBe(false)
  })

  test('get/list 深拷贝隔断——调用方改返回值不污染缓存', () => {
    const { store } = makeStore()
    store.upsert('acme', HTTP_INPUT)
    const got = store.get('acme')
    if (got?.headers) got.headers.authorization = 'tampered'
    if (got) got.status = 'connected'
    const again = store.get('acme')
    expect(again?.headers?.authorization).toBe('Bearer super-secret-value')
    expect(again?.status).toBe('untested')
  })

  test('toSdkConfig 派生：http/stdio 形态 + headers/env 直通 pool 装配面', () => {
    const { store } = makeStore()
    store.upsert('acme', HTTP_INPUT)
    store.upsert('local', STDIO_INPUT)
    const acme = store.get('acme')
    const local = store.get('local')
    if (!acme || !local) throw new Error('fixture missing')
    expect(toSdkConfig(acme)).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/sse',
      headers: { authorization: 'Bearer super-secret-value' }
    })
    expect(toSdkConfig(local)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/mcp-server'],
      env: { ACME_TOKEN: 'env-secret-value' }
    })
  })
})
