/**
 * MCP 接入阶段 1 装配展开钉扎 —— mcp-connections/proxy-tools.ts。
 *
 * defineTool 是恒等函数（SDK types.js），故 buildProxyCustomTools 返回对象
 * 可直接字段断言；pool 用结构假件（getProxyToolDefs / callTool），不碰真连接。
 *
 * 覆盖：
 *  1. label：剥 `mcp__{slug}__` 前缀 + 点/下划线切词逐词首字母大写
 *     （内层驼峰不拆——'createIssue' → 'CreateIssue'）；无前缀名直通
 *  2. promptSnippet：description 直用；>200 截 200 + '…'；空描述退工具名
 *  3. parameters 同引用透传（池侧已剥 $schema，本层不动）
 *  4. execute → pool.callTool(name, params) 回传 {content, details.isError}；
 *     sourceSlug 有值才进 details（缺席时不造 undefined 键）
 */
import { describe, expect, test } from 'bun:test'

import { buildProxyCustomTools } from '@/app/ai/pi-backend/mcp-connections/proxy-tools'
import type { MCPClientPool, ProxyToolDef } from '@/app/ai/pi-backend/mcp/mcp-pool'

interface BuiltTool {
  name: string
  label: string
  description: string
  promptSnippet?: string
  parameters: unknown
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>
    details: { isError: boolean; sourceSlug?: string }
  }>
}

interface FakeCall {
  name: string
  params: Record<string, unknown>
}

function makePool(
  defs: ProxyToolDef[],
  callResult: { content: string; isError: boolean; sourceSlug?: string }
): { pool: MCPClientPool; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const pool = {
    getProxyToolDefs: () => defs,
    callTool: (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params })
      return Promise.resolve(callResult)
    }
  } as MCPClientPool
  return { pool, calls }
}

function build(pool: MCPClientPool): BuiltTool[] {
  return buildProxyCustomTools(pool) as BuiltTool[]
}

function def(name: string, description: string): ProxyToolDef {
  return { name, description, inputSchema: { type: 'object' } }
}

describe('buildProxyCustomTools', () => {
  test('label：剥前缀 + 切词首字母大写；驼峰不拆；无前缀名直通', () => {
    const { pool } = makePool(
      [
        def('mcp__linear__create_issue', 'a'),
        def('mcp__acme_corp__get.time', 'b'),
        def('mcp__s__createIssue', 'c'),
        def('standalone', 'd')
      ],
      { content: '', isError: false }
    )
    const tools = build(pool)
    expect(tools.map((t) => t.label)).toEqual([
      'Create Issue',
      'Get Time',
      'CreateIssue',
      'Standalone'
    ])
    // name 原样保留（proxyToolName 单源）
    expect(tools[0]?.name).toBe('mcp__linear__create_issue')
  })

  test('promptSnippet：description 直用；>200 截 200 + …；空/空白退工具名', () => {
    const long = 'x'.repeat(250)
    const { pool } = makePool(
      [def('mcp__a__t1', 'short desc'), def('mcp__a__t2', long), def('mcp__a__t3', '   ')],
      { content: '', isError: false }
    )
    const tools = build(pool)
    expect(tools[0]?.promptSnippet).toBe('short desc')
    expect(tools[1]?.promptSnippet?.length).toBe(201)
    expect(tools[1]?.promptSnippet?.endsWith('…')).toBe(true)
    expect(tools[2]?.promptSnippet).toBe('mcp__a__t3')
  })

  test('parameters 同引用透传', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } }
    const { pool } = makePool([{ name: 'mcp__a__t', description: 'd', inputSchema: schema }], {
      content: '',
      isError: false
    })
    const tools = build(pool)
    expect(tools[0]?.parameters).toBe(schema)
  })

  test('execute → pool.callTool 回传 content/isError；sourceSlug 有值才进 details', async () => {
    const { pool, calls } = makePool([def('mcp__a__t', 'd')], {
      content: 'tool output',
      isError: false
    })
    const tools = build(pool)
    const tool = tools[0]
    if (!tool) throw new Error('fixture missing')
    const result = await tool.execute('tc1', { q: 'x' })
    expect(calls).toEqual([{ name: 'mcp__a__t', params: { q: 'x' } }])
    expect(result.content).toEqual([{ type: 'text', text: 'tool output' }])
    expect(result.details.isError).toBe(false)
    expect('sourceSlug' in result.details).toBe(false)

    const withSlug = makePool([def('mcp__a__t', 'd')], {
      content: 'boom',
      isError: true,
      sourceSlug: 'a'
    })
    const tool2 = build(withSlug.pool)[0]
    if (!tool2) throw new Error('fixture missing')
    const failed = await tool2.execute('tc2', {})
    expect(failed.details.isError).toBe(true)
    expect(failed.details.sourceSlug).toBe('a')
  })
})
