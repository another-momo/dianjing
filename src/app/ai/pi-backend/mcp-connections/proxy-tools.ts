/**
 * MCP 接入阶段 1 装配展开 helper —— 把 MCPClientPool 当前的 proxy tool defs
 * 转成 pi SDK `defineTool` 形态，逐件注入 customTools 数组（详 session/assembly.ts）。
 *
 * 每件字段（提案 §5.3 装配规格）：
 *  - name（原样 proxy 名 = `mcp__{slug}__{tool}`，proxyToolName 单源）
 *  - label（剥 `mcp__{slug}__` 前缀 + 点/下划线切词逐词首字母大写）
 *  - description（MCP 原描述）
 *  - promptSnippet（description 截 200 派生；空描述退用工具名兜底）
 *  - parameters（def.inputSchema 直塞，TSchema 透传，池侧已剥 $schema）
 *  - execute → pool.callTool(name, args) → AgentToolResult
 *
 * 单件鲁棒性的真实落点（明示——本层刻意不包 try/catch）：
 *  - defineTool 是恒等函数（SDK types.js），本层无可抛点；
 *  - $schema 已在池侧 getProxyToolDefs 剥除（AJV 未注册元 schema 的经典炸点）；
 *  - 更深层的第三方 schema 不兼容会在该工具首次调用的参数校验处报错，
 *    由 pi 收敛为单次 tool call 的 error 结果回模型——不炸整池装配。
 *
 * 边界（明示）：
 *  - 不改 description（第三方原文）；label 走最朴素格式化（切词 + 首字母大写）
 *  - execute 失败 / isError=true → 透传 `{content:[{text}], details:{isError}}`
 *    给模型（与 load-reference 等同款细节契约）
 */

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'

import type { MCPClientPool, ProxyToolDef } from '../mcp/mcp-pool'

/** proxy 名剥 `mcp__{slug}__` 前缀后剩余的尾部（驼峰 / 点 / 空格皆可能） */
function stripProxyPrefix(proxyName: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.*)$/.exec(proxyName)
  return m?.[1] || proxyName
}

/** 点 / 下划线切词 + 逐词首字母大写（内层驼峰不拆，保留原词形） */
function humanize(raw: string): string {
  return raw
    .replace(/[._]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** description 截 200——空退工具名兜底 */
function derivePromptSnippet(def: ProxyToolDef): string {
  const base = def.description.trim()
  if (base) return base.length > 200 ? `${base.slice(0, 200)}…` : base
  return def.name
}

/** MCPClientPool 当前 proxy tool defs → pi defineTool[] 形态 */
export function buildProxyCustomTools(pool: MCPClientPool): ReturnType<typeof defineTool>[] {
  return pool.getProxyToolDefs().map((def) => {
    // 池侧已剥 $schema；TSchema 是 TypeBox 联合，此处透传（与 tools.ts
    // `as TSchema` cast 同款形态）——pi 侧 AJV 仅做参数 shape 校验
    const parameters = def.inputSchema as TSchema
    return defineTool({
      name: def.name,
      label: humanize(stripProxyPrefix(def.name)),
      description: def.description,
      promptSnippet: derivePromptSnippet(def),
      parameters,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>
      ): Promise<AgentToolResult<{ isError: boolean; sourceSlug?: string }>> {
        const result = await pool.callTool(def.name, params)
        return {
          content: [{ type: 'text', text: result.content }],
          details: {
            isError: result.isError,
            ...(result.sourceSlug ? { sourceSlug: result.sourceSlug } : {})
          }
        }
      }
    })
  })
}
