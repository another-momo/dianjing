/**
 * MCP 连接设置面前端单测 —— src/components/settings/mcp-connections/。
 *
 * 覆盖（上游 mcp-connections.test.ts 用例改造 + 本仓契约新增）：
 *  1. 名称即 slug 校验：非空 / ≤80 / 不含 '/'（路由末段约束）
 *  2. URL 安全：HTTPS-only + loopback HTTP 例外 + 禁内嵌凭证 + file:// 拒绝
 *  3. command shell 元字符拒绝；args 分词与上限
 *  4. compactKeyValuePairs：空 key 丢弃、同 key 后写覆盖
 *  5. client 解析：投影列表过滤非法件 + slug 去重；PUT 响应信封 { connection } 解包
 *  6. mutations：同 slug 串行队列（后入队等前序落定）
 */
import { describe, expect, test } from 'bun:test'

import {
  parseAPIConnection,
  parseAPIConnectionList,
  parseSaveResult
} from '@/components/settings/mcp-connections/client'
import { enqueueMCPConnectionMutation } from '@/components/settings/mcp-connections/mutations'
import {
  compactKeyValuePairs,
  MCP_CONNECTION_NAME_MAX_LENGTH,
  parseMCPConnectionArgs,
  validateMCPConnectionCommand,
  validateMCPConnectionName,
  validateMCPConnectionURL
} from '@/components/settings/mcp-connections/types'

describe('validateMCPConnectionName（名称即 slug）', () => {
  test('合法名通过并返回 trim 后值', () => {
    expect(validateMCPConnectionName('  my-server ')).toBe('my-server')
    expect(validateMCPConnectionName('含 中文')).toBe('含 中文')
  })

  test('空 / 超长 / 含斜杠拒绝', () => {
    expect(() => validateMCPConnectionName('   ')).toThrow()
    expect(() =>
      validateMCPConnectionName('x'.repeat(MCP_CONNECTION_NAME_MAX_LENGTH + 1))
    ).toThrow()
    expect(() => validateMCPConnectionName('a/b')).toThrow()
  })
})

describe('validateMCPConnectionURL', () => {
  test('https 通过；http 仅 loopback 例外', () => {
    expect(validateMCPConnectionURL('https://mcp.example.com/sse').protocol).toBe('https:')
    expect(validateMCPConnectionURL('http://localhost:8080/mcp').protocol).toBe('http:')
    expect(validateMCPConnectionURL('http://127.0.0.1:8080/mcp').protocol).toBe('http:')
    expect(() => validateMCPConnectionURL('http://remote.example.com/mcp')).toThrow()
  })

  test('禁内嵌凭证 / file:// 拒绝 / 非 URL 拒绝', () => {
    expect(() => validateMCPConnectionURL('https://user:pass@mcp.example.com')).toThrow()
    expect(() => validateMCPConnectionURL('file:///etc/passwd')).toThrow()
    expect(() => validateMCPConnectionURL('not a url')).toThrow()
    expect(() => validateMCPConnectionURL('')).toThrow()
  })
})

describe('validateMCPConnectionCommand / parseMCPConnectionArgs', () => {
  test('command：空与 shell 元字符拒绝，正常命令通过', () => {
    expect(() => validateMCPConnectionCommand('  ')).toThrow()
    expect(() => validateMCPConnectionCommand('npx; rm -rf /')).toThrow()
    expect(() => validateMCPConnectionCommand('a|b')).toThrow()
    expect(() => validateMCPConnectionCommand('a$(b)')).toThrow()
    expect(validateMCPConnectionCommand(' npx ')).toBe('npx')
  })

  test('args：空白分词 / 空串为无参 / 超 64 拒绝', () => {
    expect(parseMCPConnectionArgs('')).toEqual([])
    expect(parseMCPConnectionArgs('-y  @acme/mcp-server   /tmp')).toEqual([
      '-y',
      '@acme/mcp-server',
      '/tmp'
    ])
    expect(() => parseMCPConnectionArgs(Array.from({ length: 65 }, () => 'a').join(' '))).toThrow()
  })
})

describe('compactKeyValuePairs', () => {
  test('空 key 丢弃；同 key 后写覆盖前写', () => {
    expect(
      compactKeyValuePairs([
        { key: ' authorization ', value: 'Bearer a' },
        { key: '', value: 'dropped' },
        { key: 'authorization', value: 'Bearer b' }
      ])
    ).toEqual([{ key: 'authorization', value: 'Bearer b' }])
  })
})

describe('client 解析（与后端投影契约对齐）', () => {
  test('parseAPIConnectionList：过滤非法件 + slug 去重 + 字段透传', () => {
    const list = parseAPIConnectionList({
      connections: [
        {
          slug: 'acme',
          transport: 'http',
          url: 'https://mcp.example.com/sse',
          hasHeaders: true,
          hasEnv: false,
          status: 'connected',
          toolCount: 3
        },
        { slug: 'acme', transport: 'stdio' },
        { slug: '', transport: 'http' },
        { slug: 'x', transport: 'websocket' },
        'garbage'
      ]
    })
    expect(list.length).toBe(1)
    const acme = list[0]
    expect(acme?.slug).toBe('acme')
    expect(acme?.hasHeaders).toBe(true)
    expect(acme?.status).toBe('connected')
    expect(acme?.toolCount).toBe(3)
    // 投影面不含凭据字段——解析器不构造 headers/env 键
    expect(acme && 'headers' in acme).toBe(false)
    expect(acme && 'enabled' in acme).toBe(false)
    expect(acme && 'name' in acme).toBe(false)
  })

  test('parseAPIConnection：坏形状回 null；list 非信封回空', () => {
    expect(parseAPIConnection(null)).toBeNull()
    expect(parseAPIConnection({ transport: 'http' })).toBeNull()
    expect(parseAPIConnectionList({})).toEqual([])
    expect(parseAPIConnectionList(null)).toEqual([])
  })

  test('parseSaveResult：{ connection } 信封解包；坏形状兜底 failed', () => {
    expect(parseSaveResult({ connection: { status: 'connected', toolCount: 5 } })).toEqual({
      status: 'connected',
      toolCount: 5
    })
    const failed = parseSaveResult({ connection: { status: 'failed', error: 'boom' } })
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('boom')
    expect(parseSaveResult({}).status).toBe('failed')
    expect(parseSaveResult(null).status).toBe('failed')
  })
})

describe('enqueueMCPConnectionMutation', () => {
  test('同 slug 串行：后入队等前序落定', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = enqueueMCPConnectionMutation('s1', async () => {
      await gate
      order.push('first')
    })
    const second = enqueueMCPConnectionMutation('s1', () => {
      order.push('second')
      return Promise.resolve()
    })
    const third = enqueueMCPConnectionMutation('s2', () => {
      order.push('other-slug')
      return Promise.resolve()
    })
    release()
    await Promise.all([first, second, third])
    expect(order.indexOf('first')).toBeLessThan(order.indexOf('second'))
    expect(order.includes('other-slug')).toBe(true)
  })
})
