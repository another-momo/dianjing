/**
 * MCP 接入阶段 1 HTTP 路由面 —— GET /api/pi/mcp/connections（投影列表） +
 * PUT /api/pi/mcp/connections/:slug（创建或替换 + 健康检查） +
 * DELETE /api/pi/mcp/connections/:slug（移除 + 触发会话驱逐）。
 *
 * 端点（与 /api/pi/image-gen 路由同纪律：薄层、错误文案不含 key、JSON 信封）：
 *   GET    /api/pi/mcp/connections → { connections: MCPConnectionPublic[] }
 *   PUT    /api/pi/mcp/connections/:slug { transport, url?, headers?, command?, args?, env? }
 *          → 落盘后立即对该连接做健康检查（pool ensureConnected 内 15s 超时），
 *            失败不阻断保存：status='failed' + error 原因；
 *            成功：status='connected' + toolCount；
 *            保存后触发**会话驱逐**（详 service.ts 接入缝），下个 prompt 用新连接集。
 *   DELETE /api/pi/mcp/connections/:slug → 移除 + 触发会话驱逐
 *
 * 与 image-gen routes 的差异：PUT 路径带 :slug 段——slug 来自 URL，非 body；
 * save 之后的健康检查走 pool.ensureConnected 单连接（不影响其他连接），失败
 * 不阻断保存；status 失败原因 = 健康检查抛错的 message（提案 §5.3 / §5.6）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { getMCPClientPool } from '../mcp/pool-instance'
import { toPublic, toSdkConfig, type MCPConnectionsStore } from './store'

const LIST_PATHNAME = '/api/pi/mcp/connections'

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 公共错误响应——4xx 全部 JSON 信封，与 image-gen 路由纪律同 */
function sendError(res: ServerResponse, status: number, error: string): void {
  sendJSON(res, status, { error })
}

/** 从 URL 解析 slug（/api/pi/mcp/connections/:slug 末段） */
function extractSlug(pathname: string): string | null {
  const prefix = `${LIST_PATHNAME}/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (!rest || rest.includes('/')) return null
  return rest
}

/** 路径节流：URL-decode + 合法性兜底 */
function decodeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 健康检查结果形态（PUT 落盘后的单连接探测回写） */
export type MCPProbeResult =
  | { status: 'connected'; toolCount: number }
  | { status: 'failed'; error: string }

export interface MCPConnectionsDeps {
  store: MCPConnectionsStore
  /** 会话驱逐钩子——保存/删除后下个 prompt 用新连接集重建（详 service.ts） */
  onConnectionsChanged: () => void
  /** pool 解析用——同 store 落点根目录 */
  rootDir: string
  /**
   * 测试注入缝：替换健康检查实现。生产缺省 = probeConnection（pool
   * ensureConnected 真查）——server.ts 不传此字段，单测传假件避免真连。
   */
  probe?: (slug: string) => Promise<MCPProbeResult>
}

/**
 * 单连接健康检查（生产缺省实现）：捕获所有抛错（含 pool 未初始化 / 连接超时 /
 * 配置丢失等），转失败形态返回；不冒成 unhandled rejection。失败不阻断保存
 * （提案 §5.6）。
 */
async function probeConnection(slug: string, deps: MCPConnectionsDeps): Promise<MCPProbeResult> {
  try {
    const conn = deps.store.get(slug)
    if (!conn) return { status: 'failed', error: '连接配置缺失' }
    const pool = getMCPClientPool(deps.rootDir)
    // ensureConnected 单连接模式——不影响 pool 内其他连接，15s 超时
    await pool.ensureConnected(slug, toSdkConfig(conn))
    const tools = pool.getTools(slug)
    return { status: 'connected', toolCount: tools.length }
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** 返回是否已处理（false = 非本面路径，交后续路由） */
export async function handleMCPConnectionsRequest(
  deps: MCPConnectionsDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  try {
    if (pathname === LIST_PATHNAME) {
      if (req.method === 'GET') {
        sendJSON(res, 200, { connections: deps.store.listPublic() })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }
    const rawSlug = extractSlug(pathname)
    if (!rawSlug) return false
    const slug = decodeSlug(rawSlug)
    if (!slug) {
      sendError(res, 400, 'slug 不能为空')
      return true
    }
    if (req.method === 'DELETE') {
      deps.store.remove(slug)
      deps.onConnectionsChanged()
      sendJSON(res, 200, { ok: true })
      return true
    }
    if (req.method !== 'PUT') {
      sendError(res, 405, 'Method Not Allowed')
      return true
    }
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      sendError(res, 400, 'Bad Request: invalid JSON')
      return true
    }
    // upsert 内部 Valibot 校验——坏 transport / 缺 url / 缺 command 抛错
    let saved
    try {
      saved = deps.store.upsert(slug, body as Parameters<MCPConnectionsStore['upsert']>[1])
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error))
      return true
    }
    // 健康检查——失败不阻断保存（probe 缺省走生产实现，测试经 deps.probe 注入）
    const probe = deps.probe ?? ((s: string) => probeConnection(s, deps))
    const probeResult = await probe(slug)
    deps.store.updateStatus(slug, probeResult)
    // 触发会话驱逐——下个 prompt 用新连接集重建
    deps.onConnectionsChanged()
    // 响应只给脱敏投影——saved 是含 headers/env 明文的内部形，禁直接出网
    sendJSON(res, 200, { connection: toPublic({ ...saved, ...probeResult }) })
    return true
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error))
    return true
  }
}
