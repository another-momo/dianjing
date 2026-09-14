import { randomUUID } from 'node:crypto'

import type { WebSocket } from 'ws'

import { isAuthorized } from './auth'
import type { RPCJSONObject } from './json'
import type { PendingRequest } from './rpc-types'

// T27：长回合场景（大文档批量工具调用）可经 OPENPENCIL_RPC_TIMEOUT_MS 放宽。
// T54（Phase 3 W2/T-B3）：默认值 20s → 300s——generate_image 双段执行经桥落图，
// 生图 HTTP 上限 240s（pi-backend image-gen 独立超时），桥超时必须 ≥ 生图上限+余量，
// 否则 240s 级调用被桥层 20s kill（SP-b 探针实证旧默认掐断点）。
// 调用时读取（非常量快照）：测试与运维可在进程内调整 env 后立即生效。
// Number(...)||默认值 的写法同时挡住未设置（NaN）与非法值。
export const DEFAULT_RPC_TIMEOUT_MS = 300_000
export function rpcTimeoutMs(): number {
  return Number(process.env.OPENPENCIL_RPC_TIMEOUT_MS) || DEFAULT_RPC_TIMEOUT_MS
}
const APP_WAIT_TIMEOUT = 10_000

const APP_NOT_CONNECTED_MESSAGE =
  'OpenPencil app is not connected. STOP and tell the user: "The OpenPencil desktop app is not running, no document is open, or the desktop app is connected to a different MCP server. Please start OpenPencil, open a document, and try again." Do NOT attempt to start the app yourself or retry automatically.'

/**
 * T98：工具执行失败标记——浏览器 app 显式应答 ok:false（编辑器在线，命令/
 * 工具自身抛错：JSX 解析、参数校验、运行时错误）。与传输级失败（app 未连接、
 * RPC 超时、浏览器断连——这些 reject 普通 Error）严格区分，HTTP /rpc 侧据此
 * 回 200 而非 502（server.ts），调用方才能把两类失败正确分类给模型。
 */
export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolExecutionError'
  }
}

type BrowserRPCBridgeOptions = {
  authToken: string | null
  onConnectionChange?: () => void
}

type ConnectionListener = (connected: boolean) => void

type BrowserMessage = {
  type: string
  id?: string
  token?: unknown
  windowId?: unknown
  result?: unknown
  error?: string
  ok?: boolean
}

function stripEnvelope(msg: BrowserMessage): Record<string, unknown> {
  // T98-路由：windowId 是请求体外层信封字段，与 type/id 同级；剥离后
  // 不得残留在转发 body 中（桥侧会误把它当工具参数塞进去）
  const { type: _type, id: _id, windowId: _windowId, ...body } = msg
  return body
}

function responsePayload(result: unknown): RPCJSONObject {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as RPCJSONObject
  }
  return { result }
}

function sendJSON(ws: WebSocket, body: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(body))
}

function createSettler<T>(resolve: (value: T) => void, reject: (error: Error) => void) {
  let settled = false
  return {
    resolve: (value: T) => {
      if (settled) return
      settled = true
      resolve(value)
    },
    reject: (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    },
    isSettled: () => settled
  }
}

/**
 * T98-路由：每窗口一个槽位 = { ws, pending }，pending 按槽位隔离，关窗
 * 只 reject 本槽 in-flight；窗口 id 由客户端 register 时上送（window-id.ts
 * 模块级 UUID），服务端兼容旧客户端（无 windowId 字段时随机分配一个 UUID）。
 * lastRegisteredWindowId 用于「无 windowId 多窗」回退——MCP 外部客户端语义
 * 兼容（MCP 协议从不带 windowId，请求落最后注册窗）。
 */
type WindowSlot = {
  ws: WebSocket
  pending: Map<string, PendingRequest>
}

export function createBrowserRPCBridge({ authToken, onConnectionChange }: BrowserRPCBridgeOptions) {
  // T98-路由：windowId → 槽位（含 ws + 该窗的 pending map）
  const windows = new Map<string, WindowSlot>()
  // ws → windowId 反向索引（handleBrowserResponse / handleClose O(1) 反查）
  const windowByWs = new WeakMap<WebSocket, string>()
  const clients = new Set<WebSocket>()
  const connectionWaiters = new Set<PendingRequest>()
  // Track which WebSocket clients have authenticated via a valid
  // register message. Unauthenticated clients can only send register;
  // all other message types (request, response) are rejected.
  const authenticatedClients = new Set<WebSocket>()
  const connectionListeners = new Set<ConnectionListener>()
  let lastRegisteredWindowId: string | null = null
  let bridgeClosed = false

  function isConnected(): boolean {
    return windows.size > 0
  }

  function notifyConnectionChange() {
    onConnectionChange?.()
    const connected = isConnected()
    for (const listener of connectionListeners) listener(connected)
  }

  function subscribeConnectionChange(listener: ConnectionListener): () => void {
    connectionListeners.add(listener)
    listener(isConnected())
    return () => connectionListeners.delete(listener)
  }

  function notifyConnectionWaiters() {
    for (const waiter of connectionWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(undefined)
    }
    connectionWaiters.clear()
  }

  function rejectConnectionWaiters(reason: string) {
    for (const waiter of connectionWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
    connectionWaiters.clear()
  }

  function waitForConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let waiter: PendingRequest | null = null

      const timer = setTimeout(() => {
        if (waiter) connectionWaiters.delete(waiter)
        reject(new Error(APP_NOT_CONNECTED_MESSAGE))
      }, APP_WAIT_TIMEOUT)

      waiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        },
        timer
      }
      // Add the waiter BEFORE checking browser state to avoid a lost-wakeup
      // race: if the browser registers between sendRPC's initial check and
      // this point, notifyConnectionWaiters() will have already fired and
      // cleared the set. Without this re-check, the waiter would stall for
      // APP_WAIT_TIMEOUT even though the browser is connected.
      connectionWaiters.add(waiter)
      if (windows.size > 0) {
        waiter.resolve(undefined)
        connectionWaiters.delete(waiter)
      }
    })
  }

  function rejectPendingInSlot(slot: WindowSlot, reason: string) {
    for (const [, req] of slot.pending) {
      clearTimeout(req.timer)
      req.reject(new Error(reason))
    }
    slot.pending.clear()
  }

  function sendRegisterPrompt(ws: WebSocket) {
    // Send a prompt inviting the client to register as the browser.
    // IMPORTANT: Do NOT include the auth token here. On TCP, any local
    // process can connect via WebSocket — sending the secret token would
    // leak credentials to unauthenticated clients. The legitimate browser
    // app already knows the token (from the discovery file or Vite env)
    // and sends it proactively in its ws.onopen handler. The token field
    // is set to null to signal that auth is required without revealing
    // the secret. When auth is disabled (authToken === null), null is
    // still correct — it means "no token needed."
    sendJSON(ws, { type: 'register', token: null })
  }

  function broadcastRegisterPrompt() {
    for (const client of clients) sendRegisterPrompt(client)
  }

  /**
   * T98-路由：sendRPC 选槽规则——
   *  1) opts.windowId 显式存在：命中该窗槽位则发；缺窗 → 立即 reject APP_NOT_CONNECTED_MESSAGE
   *     （保 502/editor-unreachable 分类不变：调用方按编辑器不可达处理）；
   *  2) opts.windowId 缺省 + 仅一窗：发到该唯一窗；
   *  3) opts.windowId 缺省 + 多窗：发到 lastRegisteredWindowId（最后注册窗）；
   *  4) 零窗：走 waitForConnection 等待逻辑（connect→register 后通知 waiters）。
   * 选中槽位后：pending 入该槽 map；ws.send 失败处理逻辑与原版一致。
   */

  /** 依据显式 windowId 与全局 lastRegisteredWindowId 解析发送目标槽；未命中返回 undefined。 */
  function pickRouteSlot(explicit: string | undefined): WindowSlot | undefined {
    if (explicit !== undefined) return windows.get(explicit)
    if (windows.size === 1) return windows.values().next().value
    if (windows.size > 1 && lastRegisteredWindowId) return windows.get(lastRegisteredWindowId)
    return undefined
  }
  function sendRPC(
    body: Record<string, unknown>,
    opts: { windowId?: string } = {}
  ): Promise<unknown> {
    if (bridgeClosed) return Promise.reject(new Error('Server shutting down'))
    return new Promise((resolve, reject) => {
      const doSend = () => {
        // 1) 显式 windowId 路由
        const explicit = opts.windowId
        const slot = pickRouteSlot(explicit)
        if (!slot || slot.ws.readyState !== slot.ws.OPEN) {
          reject(new Error(APP_NOT_CONNECTED_MESSAGE))
          return
        }
        const id = randomUUID()
        const settle = createSettler(resolve, reject)
        const timeoutMs = rpcTimeoutMs()
        const timer = setTimeout(() => {
          slot.pending.delete(id)
          settle.reject(new Error(`RPC timeout (${Math.round(timeoutMs / 1000)}s)`))
        }, timeoutMs)
        slot.pending.set(id, { resolve: settle.resolve, reject: settle.reject, timer })
        try {
          slot.ws.send(JSON.stringify({ ...body, type: 'request', id }))
        } catch (e) {
          clearTimeout(timer)
          slot.pending.delete(id)
          if (!settle.isSettled()) {
            settle.reject(e instanceof Error ? e : new Error(String(e)))
          }
        }
      }

      if (opts.windowId !== undefined) {
        // 显式 windowId：直接选槽，不走 wait——缺窗立即 reject
        doSend()
      } else if (windows.size > 0 && lastRegisteredWindowId) {
        const slot = windows.get(lastRegisteredWindowId)
        if (slot && slot.ws.readyState === slot.ws.OPEN) {
          doSend()
        } else {
          void waitForConnection().then(doSend).catch(reject)
        }
      } else {
        void waitForConnection().then(doSend).catch(reject)
      }
    })
  }

  async function handleClientRequest(ws: WebSocket, msg: BrowserMessage) {
    if (!msg.id) return
    try {
      // T98-路由：从原始信封提取 windowId 供 sendRPC 选槽（必须在 stripEnvelope
      // 之前读——strip 会把 windowId 剥掉）；其余字段进转发 body
      const explicitWindowId =
        typeof msg.windowId === 'string' && msg.windowId ? msg.windowId : undefined
      const result = await sendRPC(stripEnvelope(msg), { windowId: explicitWindowId })
      sendJSON(ws, { ...responsePayload(result), type: 'response', id: msg.id, ok: true })
    } catch (e) {
      sendJSON(ws, {
        type: 'response',
        id: msg.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  /**
   * T98-路由：registerBrowser——
   *  - token 鉴权失败 → close ws；
   *  - windowId 缺省时随机分配一个 UUID（旧客户端向后兼容）；
   *  - 同 windowId 已有槽位且 ws 不同 → 旧槽 pending 全部 reject 'Browser reconnected'，
   *    旧 ws close（latest-wins per window）；
   *  - 写槽 + 更新 lastRegisteredWindowId + notifyConnectionWaiters/Change。
   */
  function registerBrowser(ws: WebSocket, token: string | null, windowId?: string) {
    if (bridgeClosed) return
    if (!isAuthorized(token, authToken)) {
      ws.close()
      return
    }
    // Mark this client as authenticated — it can now send requests.
    authenticatedClients.add(ws)

    // T98-路由：windowId 缺省 → 服务端分配（向后兼容旧客户端）
    const assignedWindowId = typeof windowId === 'string' && windowId ? windowId : randomUUID()

    const existingSlot = windows.get(assignedWindowId)
    if (existingSlot && existingSlot.ws !== ws) {
      // 同 id 旧槽位的 in-flight 请求全部 reject（'Browser reconnected' 语义不变）
      rejectPendingInSlot(existingSlot, 'Browser reconnected')
      if (existingSlot.ws.readyState === ws.OPEN) {
        existingSlot.ws.close()
      }
      windowByWs.delete(existingSlot.ws)
    }

    windows.set(assignedWindowId, { ws, pending: new Map() })
    windowByWs.set(ws, assignedWindowId)
    lastRegisteredWindowId = assignedWindowId
    notifyConnectionWaiters()
    notifyConnectionChange()
    broadcastRegisterPrompt()
  }

  /**
   * T98-路由：handleBrowserResponse——按 ws 反查所属槽位，仅匹配该槽 pending；
   * 跨槽响应（不可能自然发生，但 ws 关闭时序竞争下可能）静默丢弃。
   * msg.ok === false → ToolExecutionError 的 T98 语义保持不变。
   */
  function handleBrowserResponse(msg: BrowserMessage, ws: WebSocket) {
    const windowId = windowByWs.get(ws)
    if (windowId === undefined) return
    const slot = windows.get(windowId)
    if (!slot || slot.ws !== ws || !msg.id) return
    const req = slot.pending.get(msg.id)
    if (!req) return
    slot.pending.delete(msg.id)
    clearTimeout(req.timer)
    if (msg.ok === false) {
      // T98：app 显式应答失败 = 编辑器在线、工具自身抛错——以 ToolExecutionError
      // reject，与传输级 reject（未连接/超时/断连的普通 Error）可判别
      req.reject(new ToolExecutionError(msg.error ?? 'RPC failed'))
    } else {
      req.resolve(stripEnvelope(msg))
    }
  }

  function handleMessage(data: string, ws: WebSocket) {
    if (bridgeClosed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch (e) {
      console.warn('Malformed automation message:', e)
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ws.close()
      return
    }
    const msg = parsed as BrowserMessage

    if (msg.type === 'auth') {
      // Authenticate a stdio bridge client without registering it as the
      // browser app. This lets the client send request/response messages
      // without becoming the RPC target. The token is validated the same
      // way as registerBrowser — when auth is disabled (authToken === null),
      // any token is accepted.
      if (msg.token === null || typeof msg.token === 'string') {
        if (!isAuthorized(msg.token, authToken)) {
          ws.close()
          return
        }
        authenticatedClients.add(ws)
      } else if (msg.token !== undefined) {
        ws.close()
      }
      return
    }

    if (msg.type === 'register') {
      if (msg.token === null || typeof msg.token === 'string') {
        // T98-路由：register 信封携带 windowId（旧客户端可缺省）
        const windowId = typeof msg.windowId === 'string' && msg.windowId ? msg.windowId : undefined
        registerBrowser(ws, msg.token, windowId)
      } else if (msg.token !== undefined) {
        ws.close()
      }
      return
    }
    // All non-register messages require authentication. Without this
    // check, an unauthenticated WebSocket client (that hasn't sent a
    // valid register message) could bypass the HTTP auth on /rpc by
    // sending request messages over the WebSocket directly.
    if (!authenticatedClients.has(ws)) {
      ws.close()
      return
    }
    if (msg.type === 'request') {
      void handleClientRequest(ws, msg)
      return
    }
    if (msg.type === 'response') handleBrowserResponse(msg, ws)
  }

  /**
   * T98-路由：handleClose——
   *  - 反查 ws 所属 windowId 槽位，删除该槽；
   *  - 只 reject 该槽 pending（'Browser disconnected'）——其他窗不受影响；
   *  - lastRegisteredWindowId 若指向被删窗 → 回退为 Map 剩余最后一键或 null；
   *  - connectionWaiters 保持不 reject（语义不变：等待新窗注册）；
   *  - notifyConnectionChange 保留。
   */
  function handleClose(ws: WebSocket) {
    clients.delete(ws)
    authenticatedClients.delete(ws)
    const windowId = windowByWs.get(ws)
    if (windowId === undefined) return
    const slot = windows.get(windowId)
    if (!slot || slot.ws !== ws) return
    windows.delete(windowId)
    windowByWs.delete(ws)
    rejectPendingInSlot(slot, 'Browser disconnected')
    // lastRegisteredWindowId 回退：指向被删窗时取 Map 剩余最后一键
    if (lastRegisteredWindowId === windowId) {
      lastRegisteredWindowId = windows.size > 0 ? (windows.keys().next().value ?? null) : null
    }
    // Intentionally NOT rejecting connectionWaiters here. If a request
    // entered waitForConnection() before the close event (e.g. during a
    // CLOSING→CLOSED transition), the waiter should keep waiting the full
    // APP_WAIT_TIMEOUT for a reconnect. registerBrowser will resolve it
    // via notifyConnectionWaiters if the browser reconnects in time.
    notifyConnectionChange()
  }

  function handleConnection(ws: WebSocket) {
    if (bridgeClosed) return
    clients.add(ws)
    // Transport security restricts WHO can connect: Unix socket with
    // 0o600 permissions (same-user only) or TCP localhost (any local
    // process). The authenticatedClients set gates WHAT connected clients
    // can do: only those that sent a valid register message may forward
    // requests. The register prompt does NOT include the auth token —
    // the browser app sends the token proactively (from the discovery
    // file or Vite env).
    sendRegisterPrompt(ws)
  }

  function close() {
    bridgeClosed = true
    // T98-路由：reject 所有槽位 pending + connectionWaiters
    for (const slot of windows.values()) rejectPendingInSlot(slot, 'Server shutting down')
    rejectConnectionWaiters('Server shutting down')
    windows.clear()
    lastRegisteredWindowId = null
    clients.clear()
    authenticatedClients.clear()
    connectionListeners.clear()
  }

  return {
    close,
    isConnected,
    subscribeConnectionChange,
    sendRPC,
    handleConnection,
    handleMessage,
    handleClose
  }
}
