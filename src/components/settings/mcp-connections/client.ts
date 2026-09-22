/**
 * MCP 连接设置面前端客户端（同构：只依赖 fetch/vue ref，不引 node 模块；
 * vite proxy '/api/pi' → 7700）。照 image-gen client 样板。
 *
 * 数据层契约（与后端 routes 同步）：
 *   GET    /api/pi/mcp/connections       → { connections: MCPConnectionPublic[] }
 *   PUT    /api/pi/mcp/connections/:slug →  body: { transport, url?, headers?,
 *                                                 command?, args?, env? }
 *                                          → { connection: MCPConnectionPublic }
 *                                          保存即触发后端健康检查，失败不阻断保存；
 *                                          headers/env 省略 = 保留旧值、非空 = 整体替换
 *   DELETE /api/pi/mcp/connections/:slug
 *
 * 凭据只进不出：编辑既有连接时 headers/env values 永不回显，hasHeaders/hasEnv
 * 元数据表示「已配置」态；新建/重写时 values 可由用户填写。
 */

import { ref } from 'vue'

import { requestPiJSON } from '@/app/ai/pi-backend/request-json'

import type { MCPConnection, MCPConnectionDraft, MCPConnectionStatus } from './types'

const API_PATH = '/api/pi/mcp/connections'

export const mcpConnectionList = ref<MCPConnection[]>([])
export const mcpConnectionListLoading = ref(false)
export const mcpConnectionListError = ref<string | null>(null)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStatus(value: unknown): MCPConnectionStatus {
  return value === 'connected' || value === 'failed' || value === 'untested' ? value : 'untested'
}

function asArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function parseAPIConnection(value: unknown): MCPConnection | null {
  if (!isRecord(value)) return null
  const slug = asString(value.slug)?.trim() ?? ''
  const transport =
    value.transport === 'http' || value.transport === 'stdio' ? value.transport : null
  if (!slug || !transport) return null
  const connection: MCPConnection = {
    slug,
    transport,
    hasHeaders: asBoolean(value.hasHeaders),
    hasEnv: asBoolean(value.hasEnv),
    status: asStatus(value.status)
  }
  const url = asString(value.url)
  if (url !== undefined) connection.url = url
  const command = asString(value.command)
  if (command !== undefined) connection.command = command
  const args = asArgs(value.args)
  if (args.length > 0) connection.args = args
  const toolCount = asNumber(value.toolCount)
  if (toolCount !== undefined) connection.toolCount = toolCount
  const error = asString(value.error)
  if (error !== undefined) connection.error = error
  return connection
}

export function parseAPIConnectionList(value: unknown): MCPConnection[] {
  if (!isRecord(value)) return []
  const raw = value.connections
  if (!Array.isArray(raw)) return []
  const out: MCPConnection[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const parsed = parseAPIConnection(item)
    if (parsed && !seen.has(parsed.slug)) {
      seen.add(parsed.slug)
      out.push(parsed)
    }
  }
  return out
}

export async function refreshMCPConnections(): Promise<void> {
  mcpConnectionListLoading.value = true
  mcpConnectionListError.value = null
  try {
    const body = await requestPiJSON<unknown>(API_PATH)
    mcpConnectionList.value = parseAPIConnectionList(body)
  } catch (error) {
    mcpConnectionList.value = []
    mcpConnectionListError.value = error instanceof Error ? error.message : String(error)
  } finally {
    mcpConnectionListLoading.value = false
  }
}

interface SavePayload {
  transport: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  headers?: Record<string, string>
  env?: Record<string, string>
}

function toRecord(entries: Array<{ key: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const key = entry.key.trim()
    // 空 value 行不进 payload——后端 Valibot 拒空值；「省略 = 保留旧值」语义兜底
    if (key && entry.value) out[key] = entry.value
  }
  return out
}

function buildSavePayload(draft: MCPConnectionDraft): SavePayload {
  const headers = toRecord(draft.headers)
  const env = toRecord(draft.env)
  const payload: SavePayload = { transport: draft.transport }
  if (draft.transport === 'http') {
    payload.url = draft.url.trim()
    // 省略 = 保留旧值（编辑既有连接不重填即保留）；非空 = 整体替换
    if (Object.keys(headers).length > 0) payload.headers = headers
  } else {
    payload.command = draft.command.trim()
    payload.args = draft.argsText
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0)
    if (Object.keys(env).length > 0) payload.env = env
  }
  return payload
}

export interface SaveResult {
  status: MCPConnectionStatus
  toolCount?: number
  error?: string
}

/** PUT 响应信封解析：{ connection: {...} }——坏形状按 failed 兜底 */
export function parseSaveResult(value: unknown): SaveResult {
  const connection = isRecord(value) ? value.connection : undefined
  if (!isRecord(connection)) return { status: 'failed', error: 'Invalid server response' }
  const result: SaveResult = { status: asStatus(connection.status) }
  const toolCount = asNumber(connection.toolCount)
  if (toolCount !== undefined) result.toolCount = toolCount
  const error = asString(connection.error)
  if (error !== undefined) result.error = error
  return result
}

export async function saveMCPConnection(draft: MCPConnectionDraft): Promise<SaveResult> {
  // 名称即 slug（编辑态 id 已钉死，新建取 name.trim()——form 层已校验合法性）
  const slug = draft.id ?? draft.name.trim()
  const payload = buildSavePayload(draft)
  const body = await requestPiJSON<unknown>(`${API_PATH}/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  await refreshMCPConnections()
  return parseSaveResult(body)
}

export async function deleteMCPConnection(slug: string): Promise<void> {
  await requestPiJSON<unknown>(`${API_PATH}/${encodeURIComponent(slug)}`, { method: 'DELETE' })
  await refreshMCPConnections()
}
