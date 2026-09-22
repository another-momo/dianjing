/**
 * MCP 接入阶段 1 凭据 store —— 用户配置的第三方 MCP 连接（http / stdio）落
 * `<rootDir>/pi-agent/mcp-connections.json`。headers / env 值含第三方 key，凭据
 * 五件化（path-decision.ts 的 protectedCredentialFiles 五件 + key-guard 读
 * 侧 deny 自动覆盖）。
 *
 * 写盘纪律（与 image-gen credentials 同源）：tmp + rename 原子写、0o600；
 * 0o600 在 win 下不可断言，仅在 POSIX 平台生效。
 *
 * 脱敏投影：list() / get() 的脱敏形态只暴露 slug / transport / url / command
 * / args / status / toolCount / error，**headers / env 的 value 永不进任何
 * 响应投影**——只暴露 hasHeaders / hasEnv 布尔（前端展示形态需求）。保存
 * 侧保留原始 headers / env 对象（含明文 value）供 mcp pool 拼装连接用，
 * 与响应投影分离（store 内部 .toSafe() 转化）。
 *
 * 第一方校验走 Valibot（仓规：zod 仅限 MCP SDK 签名强制边界，credentials.ts
 * 手写校验的旧先例不抄）。坏 transport / 缺 url / 缺 command / 坏 schema
 * 由 Valibot v.safeParse 拒绝，错误以抛错形态返给 routes 层转 400。
 *
 * status 三态（'untested' | 'connected' | 'failed'）由 routes 层保存后的
 * 健康检查写入；store 本身不验连——保存即时写 'untested'，routes 后续以
 * probeResult 形态提交 status 覆盖（routes.ts 协调）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as v from 'valibot'

import type { SdkMCPServerConfig } from '../mcp/mcp-pool'

// ── 形状 / 校验 ──

/** 连接配置（明文形态——含 headers / env 第三方 key） */
export interface MCPConnectionConfig {
  transport: 'http' | 'stdio'
  /** http 必填 */
  url?: string
  /** http 选填——明文 value 走 store.save 落盘，不进响应投影 */
  headers?: Record<string, string>
  /** stdio 必填 */
  command?: string
  /** stdio 选填 */
  args?: string[]
  /** stdio 选填——明文 value 走 store.save 落盘，不进响应投影 */
  env?: Record<string, string>
}

export type MCPConnectionStatus = 'untested' | 'connected' | 'failed'

/** 落盘形——status 持久化（保存即时写入 untested，routes 健康检查后再覆盖） */
export interface MCPConnection extends MCPConnectionConfig {
  slug: string
  status: MCPConnectionStatus
  /** 连接成功时记录 listTools 结果的工具数 */
  toolCount?: number
  /** 失败原因（status='failed' 时填，status='connected' 时缺省） */
  error?: string
}

/** 响应投影——headers / env value 不外露，仅 has* 布尔 */
export interface MCPConnectionPublic {
  slug: string
  transport: 'http' | 'stdio'
  url?: string
  hasHeaders: boolean
  command?: string
  args?: string[]
  hasEnv: boolean
  status: MCPConnectionStatus
  toolCount?: number
  error?: string
}

// ── Valibot schema ──

const headerValueSchema = v.pipe(v.string(), v.minLength(1, 'header value 不能为空'))
const envValueSchema = v.pipe(v.string(), v.minLength(1, 'env value 不能为空'))

const httpConfigSchema = v.object({
  transport: v.literal('http'),
  url: v.pipe(v.string(), v.minLength(1, 'url 不能为空')),
  headers: v.optional(v.record(v.string(), headerValueSchema))
})

const stdioConfigSchema = v.object({
  transport: v.literal('stdio'),
  command: v.pipe(v.string(), v.minLength(1, 'command 不能为空')),
  args: v.optional(v.array(v.string())),
  env: v.optional(v.record(v.string(), envValueSchema))
})

/** 接收形态（PUT 入参）——status / toolCount / error 由后端派生，不收前端 */
export const mcpConnectionInputSchema = v.variant('transport', [
  httpConfigSchema,
  stdioConfigSchema
])

/**
 * 落盘 schema：status 三态字面量 + 整连接形（PUT 时 status 强制 untested，
 * 保存后由 routes 健康检查另写）。
 */
const connectionStatusSchema = v.picklist(['untested', 'connected', 'failed'])
const connectionFileSchema = v.object({
  version: v.literal(1),
  connections: v.record(
    v.pipe(v.string(), v.minLength(1, 'slug 不能为空')),
    v.object({
      transport: v.picklist(['http', 'stdio']),
      url: v.optional(v.string()),
      headers: v.optional(v.record(v.string(), v.string())),
      command: v.optional(v.string()),
      args: v.optional(v.array(v.string())),
      env: v.optional(v.record(v.string(), v.string())),
      status: connectionStatusSchema,
      toolCount: v.optional(v.number()),
      error: v.optional(v.string())
    })
  )
})

interface MCPConnectionFile {
  version: 1
  connections: Record<string, MCPConnection>
}

// ── 投影 ──

/** 转脱敏投影：headers / env value 永不外露，只给 has* 布尔 */
export function toPublic(conn: MCPConnection): MCPConnectionPublic {
  const pub: MCPConnectionPublic = {
    slug: conn.slug,
    transport: conn.transport,
    status: conn.status,
    hasHeaders: !!conn.headers && Object.keys(conn.headers).length > 0,
    hasEnv: !!conn.env && Object.keys(conn.env).length > 0
  }
  if (conn.url !== undefined) pub.url = conn.url
  if (conn.command !== undefined) pub.command = conn.command
  if (conn.args !== undefined) pub.args = [...conn.args]
  if (conn.toolCount !== undefined) pub.toolCount = conn.toolCount
  if (conn.error !== undefined) pub.error = conn.error
  return pub
}

// ── 派生：连接形 → pool 装配 SDK 形 ──

/**
 * 连接配置 → MCPClientPool.sync 接收的 SdkMCPServerConfig 形态。
 * headers / env value 直传（pool 内部交给 CraftMCPClient 使用——非投影面）。
 */
export function toSdkConfig(conn: MCPConnection): SdkMCPServerConfig {
  if (conn.transport === 'http') {
    const base = { type: 'http' as const, url: conn.url ?? '' }
    return conn.headers ? { ...base, headers: { ...conn.headers } } : base
  }
  const base = { type: 'stdio' as const, command: conn.command ?? '' }
  const withArgs = conn.args ? { ...base, args: [...conn.args] } : base
  return conn.env ? { ...withArgs, env: { ...conn.env } } : withArgs
}

// ── store ──

const FILENAME = 'mcp-connections.json'

export interface MCPConnectionsStore {
  /** 读取全部连接（深拷贝隔断调用方改写缓存） */
  list(): MCPConnection[]
  /** 按 slug 读取单个连接（深拷贝） */
  get(slug: string): MCPConnection | null
  /** 读取脱敏投影列表——任何响应面只允许这个形态 */
  listPublic(): MCPConnectionPublic[]
  /**
   * 创建或替换单条连接（PUT 入参 = 整条配置；status 强制 untested，toolCount /
   * error 留待 routes 健康检查后用 updateStatus 覆盖）。
   * 入参形状由 Valibot v.parse 强制；坏 transport / 缺 url / 缺 command 等抛错。
   */
  upsert(slug: string, input: MCPConnectionConfig): MCPConnection
  /**
   * 健康检查结果回写——routes 层在保存后跑 per-connection 检查，
   * 落 status='connected' + toolCount 或 status='failed' + error。
   * 不改 config 字段，仅 status / toolCount / error。
   */
  updateStatus(
    slug: string,
    update: { status: MCPConnectionStatus; toolCount?: number; error?: string }
  ): void
  /** 按 slug 移除；不存在不报错 */
  remove(slug: string): void
  /** 测试钩子：丢弃内存缓存，下次 list 重读盘 */
  reloadForTests(): void
  /** 测试钩子：是否落盘 */
  exists(): boolean
}

export function createMCPConnectionsStore({ agentDir }: { agentDir: string }): MCPConnectionsStore {
  const filePath = join(agentDir, FILENAME)
  let cache: MCPConnectionFile | undefined

  function readFromDisk(): MCPConnectionFile {
    if (!existsSync(filePath)) return { version: 1, connections: {} }
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      const parsed = v.parse(connectionFileSchema, raw)
      // 防御：解析 OK 后归一到 MCPConnection（schema 校验过的形状），slug 同步
      const out: MCPConnectionFile = { version: 1, connections: {} }
      for (const [slug, conn] of Object.entries(parsed.connections)) {
        out.connections[slug] = { ...conn, slug }
      }
      return out
    } catch {
      // 坏 JSON / 形状坏 = 回空集，不抛（凭据面 fail-safe：磁盘坏文件
      // 不应阻断装配；用户可重新保存覆盖）
      return { version: 1, connections: {} }
    }
  }

  function load(): MCPConnectionFile {
    if (cache === undefined) cache = readFromDisk()
    return cache
  }

  function cloneConnection(conn: MCPConnection): MCPConnection {
    const next: MCPConnection = { ...conn }
    if (conn.headers) next.headers = { ...conn.headers }
    if (conn.env) next.env = { ...conn.env }
    if (conn.args) next.args = [...conn.args]
    return next
  }

  function writeToDisk(doc: MCPConnectionFile): void {
    mkdirSync(agentDir, { recursive: true })
    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmpPath, filePath)
  }

  function list(): MCPConnection[] {
    return Object.values(load().connections).map(cloneConnection)
  }

  function get(slug: string): MCPConnection | null {
    const conn = load().connections[slug] as MCPConnection | undefined
    return conn ? cloneConnection(conn) : null
  }

  function listPublic(): MCPConnectionPublic[] {
    return list().map(toPublic)
  }

  function upsert(slug: string, input: MCPConnectionConfig): MCPConnection {
    // Valibot 强制 transport 必填 + 分支匹配（http 必填 url / stdio 必填 command）
    const parsed = v.parse(mcpConnectionInputSchema, input)
    // 写入时 status 强制 untested——routes 健康检查另写
    const conn: MCPConnection = { slug, transport: parsed.transport, status: 'untested' }
    if (parsed.transport === 'http') {
      conn.url = parsed.url
      if (parsed.headers) conn.headers = { ...parsed.headers }
    } else {
      conn.command = parsed.command
      if (parsed.args) conn.args = [...parsed.args]
      if (parsed.env) conn.env = { ...parsed.env }
    }
    const doc = load()
    doc.connections[slug] = conn
    writeToDisk(doc)
    cache = doc
    return cloneConnection(conn)
  }

  function updateStatus(
    slug: string,
    update: { status: MCPConnectionStatus; toolCount?: number; error?: string }
  ): void {
    const doc = load()
    const existing = doc.connections[slug] as MCPConnection | undefined
    if (!existing) return
    const next: MCPConnection = { ...existing, status: update.status }
    if (update.toolCount !== undefined) next.toolCount = update.toolCount
    if (update.error !== undefined) next.error = update.error
    // status='connected' 时清 error（重连后旧原因不再有意义）
    if (update.status === 'connected') delete next.error
    doc.connections[slug] = next
    writeToDisk(doc)
    cache = doc
  }

  function remove(slug: string): void {
    const doc = load()
    if (!(slug in doc.connections)) return
    const { [slug]: _removed, ...rest } = doc.connections
    doc.connections = rest
    // 全删完直接 unlinkSync（与 image-gen credentials.clear 同律）——文件
    // 不存在 = 目标态已达
    if (Object.keys(doc.connections).length === 0) {
      cache = doc
      if (existsSync(filePath)) unlinkSync(filePath)
      return
    }
    writeToDisk(doc)
    cache = doc
  }

  function reloadForTests(): void {
    cache = undefined
  }

  return {
    list,
    get,
    listPublic,
    upsert,
    updateStatus,
    remove,
    reloadForTests,
    exists: () => existsSync(filePath)
  }
}

export type MCPConnectionInput = v.InferInput<typeof mcpConnectionInputSchema>
