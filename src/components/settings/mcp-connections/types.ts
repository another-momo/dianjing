/**
 * MCP 连接设置面类型定义（阶段 1 设置面拷改 + 路径分离，新路径
 * src/components/settings/mcp-connections/）。
 *
 * 设计要点：
 * - 名称即 slug：后端以连接名称为唯一键（URL 末段直传），无独立 display name；
 *   校验 = 非空 + ≤80 字符 + 不含 '/'（路由末段约束）+ 唯一性（form 层查重）
 * - transport 双档：http | stdio（砍 sse）
 * - headers/env value 永不回显：编辑既有连接时仅显示「已配置」态；保存时省略 =
 *   保留旧值、非空 = 整体替换（后端 upsert 凭据保留语义）
 * - 状态徽章三态：untested | connected | failed（砍 needs_auth）
 */

export type MCPConnectionTransport = 'http' | 'stdio'

export type MCPConnectionStatus = 'untested' | 'connected' | 'failed'

/** 列表/投影形——与后端 GET /api/pi/mcp/connections 投影对齐（无凭据明文） */
export interface MCPConnection {
  slug: string
  transport: MCPConnectionTransport
  url?: string
  command?: string
  args?: string[]
  /** True 时后端已存头部值（编辑既有连接不回显原值）。 */
  hasHeaders: boolean
  /** True 时后端已存环境变量值（编辑既有连接不回显原值）。 */
  hasEnv: boolean
  status: MCPConnectionStatus
  toolCount?: number
  error?: string
}

/** 编辑器表单草稿：覆盖所有可编辑字段；headers/env values 仅用于新建/重写。 */
export interface MCPConnectionDraft {
  /** 既有连接的 slug（= 保存时的名称）；新建为 null，保存时取 name.trim() */
  id: string | null
  /** 连接名称——即后端 slug；编辑态不可改（改名 = 删除重建） */
  name: string
  transport: MCPConnectionTransport
  url: string
  command: string
  argsText: string
  /** 键值对列表：编辑既有连接时空 value 行被压缩丢弃（省略 = 保留旧值）。 */
  headers: Array<{ key: string; value: string }>
  /** 键值对列表：同上。 */
  env: Array<{ key: string; value: string }>
}

export interface MCPConnectionFieldErrors {
  name?: string
  url?: string
  command?: string
  args?: string
}

export const MCP_CONNECTION_NAME_MAX_LENGTH = 80
const MAX_URL_LENGTH = 2048
const MAX_COMMAND_LENGTH = 512

export function isMCPConnectionTransport(value: unknown): value is MCPConnectionTransport {
  return value === 'http' || value === 'stdio'
}

export function isMCPConnectionStatus(value: unknown): value is MCPConnectionStatus {
  return value === 'untested' || value === 'connected' || value === 'failed'
}

export function createEmptyMCPConnectionDraft(): MCPConnectionDraft {
  return {
    id: null,
    name: '',
    transport: 'http',
    url: '',
    command: '',
    argsText: '',
    headers: [],
    env: []
  }
}

/**
 * 名称（= slug）校验：trim 后非空 + ≤80 字符 + 不含 '/'（slug 走 URL 末段，
 * 裸 '/' 会被路由判成嵌套路径而漏到后续路由）。唯一性在 form 层查列表。
 */
export function validateMCPConnectionName(rawValue: string): string {
  const value = rawValue.trim()
  if (!value || value.length > MCP_CONNECTION_NAME_MAX_LENGTH || value.includes('/')) {
    throw new Error('Invalid connection name')
  }
  return value
}

/**
 * URL 安全校验：HTTPS-only + loopback HTTP 例外 + 禁内嵌凭证 + 长度上限。
 * 与上游同款钉扎规则（前端 client 独立校验，给用户即时反馈）。
 */
export function validateMCPConnectionURL(rawValue: string): URL {
  const value = rawValue.trim()
  if (!value || value.length > MAX_URL_LENGTH) {
    throw new Error('Enter a valid MCP server URL')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Enter a valid MCP server URL')
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP server URLs cannot contain credentials')
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('MCP servers must use HTTPS, except on loopback addresses')
  }
  return parsed
}

/** command 字段校验：非空 + 长度上限 + 拒绝 shell 注入字符。 */
export function validateMCPConnectionCommand(rawValue: string): string {
  const value = rawValue.trim()
  if (!value) {
    throw new Error('Enter a command to run')
  }
  if (value.length > MAX_COMMAND_LENGTH) {
    throw new Error('Command is too long')
  }
  // 拒绝 shell 控制字符与重定向（表单输入不可能带 NUL，不列 \0）
  if (/[\r\n;&|`$<>(){}\\]/.test(value)) {
    throw new Error('Command must not contain shell metacharacters')
  }
  return value
}

/** args 行：按空白分词，长度上限。空字符串视为无参。 */
export function parseMCPConnectionArgs(rawValue: string): string[] {
  const trimmed = rawValue.trim()
  if (!trimmed) return []
  const parts = trimmed.split(/\s+/).filter((part) => part.length > 0)
  if (parts.length > 64) {
    throw new Error('Too many arguments')
  }
  return parts
}

/** 键值对表：合并同 key（后写覆盖前写），过滤空 key。 */
export function compactKeyValuePairs(
  entries: Array<{ key: string; value: string }>
): Array<{ key: string; value: string }> {
  const seen = new Map<string, string>()
  for (const entry of entries) {
    const key = entry.key.trim()
    if (!key) continue
    seen.set(key, entry.value)
  }
  return Array.from(seen, ([key, value]) => ({ key, value }))
}
