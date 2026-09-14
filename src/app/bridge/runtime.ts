import { promiseTimeout } from '@vueuse/core'
import { reactive } from 'vue'

import { AUTOMATION_HTTP_PORT, hasWindowGlobal } from '@open-pencil/core/constants'

import type { EditorStore } from '@/app/editor/active-store'
import { RUNTIME_AUTOMATION_TOKEN_KEY } from '@/app/orchestration/runtime-globals'
import { isTauri } from '@/app/tauri/env'

import { connectAutomation } from './client'
import { resolveAutomationHTTPURL } from './url'

export type MCPRuntimeStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error'

export interface MCPRuntimeState {
  status: MCPRuntimeStatus
  port: number
  version: string | null
  error: string | null
  checking: boolean
  externallyManaged: boolean
}

export type MCPRuntimeResult = { ok: true } | { ok: false; error: Error }

/** 桥 /health 响应的浏览器侧快照（原 automation/mcp/spawn.ts AutomationHealth 的精简版） */
export interface AutomationHealth {
  status: 'ok' | 'no_app'
  version?: string
  authRequired?: boolean
}

export interface AutomationServerHandle {
  disconnect: () => void | Promise<void>
  authToken: string | null
  managed: boolean
}

export interface MCPRuntimeDependencies {
  connect: (getStore: () => EditorStore, authToken: string | null) => () => void
  canConnect: () => boolean
  readHealth: (authToken?: string | null) => Promise<AutomationHealth | null>
  spawn: () => Promise<AutomationServerHandle | null>
  /** T74：测试注入点——缺省 setTimeout 真等；注入 fake 让重试间隔零延迟 */
  sleep?: (ms: number) => Promise<void>
}

/**
 * T74：dev 启动时序 race 的退避重试序列（vite configureServer 的 startChild
 * 异步 spawn 桥子进程；WorkspaceView.onMounted 起跑 startMCPRuntime 时桥可能
 * 还没 listen → pollHealth 失败 → 无重试则编辑器永不 connectAutomation，桥
 * 永远 no_app。总窗口 ≤7.7s 覆盖典型 spawn 时间）。
 */
export const MCP_STARTUP_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 4000] as const

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function createMCPRuntimeService(dependencies: MCPRuntimeDependencies) {
  const state = reactive<MCPRuntimeState>({
    status: 'idle',
    port: AUTOMATION_HTTP_PORT,
    version: null,
    error: null,
    checking: false,
    externallyManaged: false
  })

  let server: AutomationServerHandle | null = null
  let disconnectAutomation: (() => void) | null = null
  let activeStore: (() => EditorStore) | null = null
  let lifecycle: Promise<void> = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = lifecycle.then(operation, operation)
    lifecycle = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  function applyHealth(health: AutomationHealth): void {
    state.version = health.version ?? null
    state.status = 'running'
    state.error = null
  }

  async function refreshOperation(): Promise<MCPRuntimeResult> {
    state.checking = true
    try {
      const health = await dependencies.readHealth(server?.authToken)
      if (health) {
        applyHealth(health)
        return { ok: true }
      }
      state.version = null
      if (state.status !== 'error') state.status = 'stopped'
      return { ok: true }
    } catch (error) {
      const runtimeError = toError(error)
      state.status = 'error'
      state.error = runtimeError.message
      return { ok: false, error: runtimeError }
    } finally {
      state.checking = false
    }
  }

  async function disconnectCurrentServer(): Promise<Error | null> {
    disconnectAutomation?.()
    disconnectAutomation = null
    const currentServer = server
    server = null
    try {
      await currentServer?.disconnect()
      return null
    } catch (error) {
      return toError(error)
    }
  }

  async function startOperation(): Promise<MCPRuntimeResult> {
    state.status = 'starting'
    state.error = null
    state.externallyManaged = false
    const sleep =
      dependencies.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms)
        }))
    let lastError: Error | null = null
    // T74：启动时序 race——vite spawn 桥是异步的，WorkspaceView.onMounted 起跑
    // startMCPRuntime 时桥可能还没 listen。N 次退避重试，覆盖典型 spawn 窗口。
    for (let attempt = 0; attempt <= MCP_STARTUP_RETRY_DELAYS_MS.length; attempt++) {
      try {
        server = await dependencies.spawn()
        const health = await dependencies.readHealth(server?.authToken)
        if (!health) throw new Error('Automation bridge did not become healthy')
        state.externallyManaged = server?.managed === false
        if (activeStore && dependencies.canConnect()) {
          disconnectAutomation = dependencies.connect(activeStore, server?.authToken ?? null)
        }
        applyHealth(health)
        return { ok: true }
      } catch (error) {
        lastError = toError(error)
        state.error = lastError.message
        if (attempt < MCP_STARTUP_RETRY_DELAYS_MS.length) {
          await sleep(MCP_STARTUP_RETRY_DELAYS_MS[attempt])
        }
      }
    }
    const runtimeError = lastError ?? new Error('Automation bridge did not become healthy')
    const disconnectError = await disconnectCurrentServer()
    state.status = 'error'
    state.error = disconnectError
      ? `${runtimeError.message}. Cleanup failed: ${disconnectError.message}`
      : runtimeError.message
    console.warn('[automation]', runtimeError)
    return { ok: false, error: runtimeError }
  }

  async function stopOperation(releaseStore: boolean): Promise<MCPRuntimeResult> {
    const disconnectError = await disconnectCurrentServer()
    if (releaseStore) activeStore = null
    state.status = disconnectError ? 'error' : 'stopped'
    state.version = null
    state.error = disconnectError?.message ?? null
    state.externallyManaged = false
    return disconnectError ? { ok: false, error: disconnectError } : { ok: true }
  }

  return {
    state,
    refresh: () => enqueue(refreshOperation),
    start(getStore: () => EditorStore): Promise<MCPRuntimeResult> {
      activeStore = getStore
      return enqueue(startOperation)
    },
    stop: () => enqueue(() => stopOperation(true)),
    restart: () =>
      enqueue(async () => {
        const stopResult = await stopOperation(false)
        if (!stopResult.ok) return stopResult
        if (!activeStore) {
          const error = new Error('Editor is not ready')
          state.status = 'error'
          state.error = error.message
          return { ok: false, error } as MCPRuntimeResult
        }
        return startOperation()
      })
  }
}

// ── 浏览器侧桥发现（原 automation/mcp/spawn.ts 的精简残余）──
//
// 桥子进程一律由宿主拉起：dev 形态是 automation vite 插件，生产 localhost
// 形态是 pi-backend host.ts；浏览器只负责持 token 轮询 /health 等桥就绪，
// 然后 connectAutomation 挂上编辑器 store。Tauri 形态曾经 shell 插件 spawn
// 外部 openpencil-mcp-http CLI——外部 CLI/MCP 调用面已裁撤，Tauri 下不再有
// 桥可连（spawn 返回 null）。

// T33（P104）：生产 host 运行时注入——host.ts 托管 index.html 时前置
// `<script>window.__OPENPENCIL_RUNTIME_AUTOMATION_TOKEN__=…</script>`，让
// 非 Tauri 的 localhost 生产形态也能拿到桥 token。运行时值优先；dev 编译期
// 注入行为不变。
// 不变量由 RUNTIME_AUTOMATION_TOKEN_KEY 钉扎——Phase 2 改名时同步该常量即可；
// 下方 type-level 断言保证 const 与 declare global 字面量同步漂移。
declare global {
  interface Window {
    __OPENPENCIL_RUNTIME_AUTOMATION_TOKEN__?: unknown
  }
}
// 编译期锚定：const 与 declare global 字面量必须同源——任一漂移即 TS 编译错。
type _AssertRuntimeTokenKeyMatches =
  typeof RUNTIME_AUTOMATION_TOKEN_KEY extends '__OPENPENCIL_RUNTIME_AUTOMATION_TOKEN__'
    ? true
    : never
const _assertRuntimeTokenKey: _AssertRuntimeTokenKeyMatches = true
void _assertRuntimeTokenKey

const RUNTIME_AUTOMATION_AUTH_TOKEN =
  hasWindowGlobal() && typeof window[RUNTIME_AUTOMATION_TOKEN_KEY] === 'string'
    ? window[RUNTIME_AUTOMATION_TOKEN_KEY]
    : null

// spike-electron-spike：HTTP URL 解析——dev 形态走 vite define 烘焙值；
// 非 dev 形态（vite build 产物 + Electron / host 托管）走运行时全局通道
// resolveAutomationHTTPURL（与 RUNTIME_BRIDGE_URL_KEY 同源）。
// 旧 fallback `http://127.0.0.1:${AUTOMATION_HTTP_PORT}`（=7600）会被主战场
// dev server 占用、token 也不符，本步彻底放弃。
const DEV_AUTOMATION_HTTP_URL = import.meta.env.DEV
  ? __OPENPENCIL_LOCAL_AUTOMATION_HTTP_URL__
  : resolveAutomationHTTPURL()
const DEV_AUTOMATION_AUTH_TOKEN =
  RUNTIME_AUTOMATION_AUTH_TOKEN ??
  (import.meta.env.DEV && typeof __OPENPENCIL_LOCAL_AUTOMATION_TOKEN__ === 'string'
    ? __OPENPENCIL_LOCAL_AUTOMATION_TOKEN__
    : null)

const noop = () => undefined

interface AutomationHealthRecord {
  status?: unknown
  version?: unknown
  authRequired?: unknown
}

function parseAutomationHealth(value: unknown): AutomationHealth | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as AutomationHealthRecord
  if (record.status !== 'ok' && record.status !== 'no_app') return null
  const health: AutomationHealth = { status: record.status }
  if (typeof record.version === 'string') health.version = record.version
  if (typeof record.authRequired === 'boolean') health.authRequired = record.authRequired
  return health
}

export async function readAutomationHealth(
  authToken: string | null = DEV_AUTOMATION_AUTH_TOKEN
): Promise<AutomationHealth | null> {
  try {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined
    const res = await fetch(`${DEV_AUTOMATION_HTTP_URL}/health`, {
      headers,
      signal: AbortSignal.timeout(1000)
    })
    if (!res.ok) return null
    return parseAutomationHealth(await res.json())
  } catch {
    return null
  }
}

async function pollHealth(
  attempts: number,
  delayMs: number,
  authToken: string | null
): Promise<AutomationHealth | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await promiseTimeout(delayMs)
    const health = await readAutomationHealth(authToken)
    if (health) return health
  }
  return null
}

async function waitForAutomationBridge(): Promise<AutomationServerHandle | null> {
  if (import.meta.env.DEV) {
    if (!DEV_AUTOMATION_AUTH_TOKEN) {
      throw new Error('Automation bridge development token is unavailable')
    }
    const health = await pollHealth(10, 250, DEV_AUTOMATION_AUTH_TOKEN)
    if (!health) throw new Error('Automation bridge did not become healthy')
    return { disconnect: noop, authToken: DEV_AUTOMATION_AUTH_TOKEN, managed: true }
  }
  // T33（P104）：host 托管的 localhost 生产形态——桥由 host 进程（pi-backend
  // host.ts）spawn，浏览器只负责连接；桥 token 已随 index.html 注入运行时全局。
  // 无注入值时维持原 null 行为（纯静态托管场景）。
  if (!isTauri()) {
    if (!RUNTIME_AUTOMATION_AUTH_TOKEN) return null
    const health = await pollHealth(10, 250, RUNTIME_AUTOMATION_AUTH_TOKEN)
    if (!health) {
      throw new Error('host 托管的自动化桥未就绪（health 轮询超时）——确认 bun run serve 正在运行')
    }
    return { disconnect: noop, authToken: RUNTIME_AUTOMATION_AUTH_TOKEN, managed: false }
  }
  return null
}

const appMCPRuntime = createMCPRuntimeService({
  connect: (getStore, authToken) => connectAutomation(getStore, authToken).disconnect,
  // T33（P105）：host 托管的 localhost 生产形态放行连接——桥由 pi-backend
  // host.ts spawn、token 经 index.html 注入运行时全局。dev / Tauri 判定保持
  // 原语义不变。
  canConnect: () =>
    import.meta.env.DEV ||
    isTauri() ||
    (hasWindowGlobal() && typeof window[RUNTIME_AUTOMATION_TOKEN_KEY] === 'string'),
  readHealth: readAutomationHealth,
  spawn: waitForAutomationBridge
})

export const mcpRuntime = appMCPRuntime.state
export const refreshMCPRuntime = appMCPRuntime.refresh
export const restartMCPRuntime = () => appMCPRuntime.restart()
export const startMCPRuntime = (getStore: () => EditorStore) => appMCPRuntime.start(getStore)
export const stopMCPRuntime = () => appMCPRuntime.stop()
