/**
 * 编排层 env 读取 + 运行时全局名常量——单点化层。
 *
 * C2 目标：把 `process.env.OPENPENCIL_*`（及桥用的 `PORT`）的散点读取收口成
 * per-var reader 函数；客户端运行时全局名（`__OPENPENCIL_RUNTIME_*` 等字符串
 * 字面量）收口成命名常量。Phase 2 改名时只动这一个文件。
 *
 * 行为纪律（搬迁 = 纯重构）：
 *  - env 名 / 默认值 / 解析语义 / trim/严格校验逐字保留
 *  - 各读取点的语义差异（有无 trim、严格 parse、防 whitespace-only）保留
 *  - 调用方不读 process.env，统一走 reader；reader 接受可选 env 参数用于测试
 *
 * 浏览器/Node 双形态：仅本文件顶层 import process；runtime-globals.ts 是
 * 同构常量（纯字符串字面量，浏览器侧可放心 import，不打包 node:process）。
 */

import { AUTOMATION_HTTP_PORT } from '@open-pencil/core/constants'

// ── 客户端运行时全局名常量（搬到 runtime-globals.ts；本文件 re-export 保兼容）──
//
// 这些常量不是 env 值——是宿主/Vite 注入到浏览器侧 window / build-time 全局
// 的属性名字面量。注入侧（host.ts / Electron main / vite.config.ts define）
// 与读取侧（bridge/runtime.ts / url.ts）必须引用同一字面量。

export {
  RUNTIME_AUTOMATION_TOKEN_KEY,
  RUNTIME_BRIDGE_URL_KEY,
  RUNTIME_ELECTRON_KEY,
  LOCAL_AUTOMATION_TOKEN_KEY,
  LOCAL_AUTOMATION_URL_KEY,
  LOCAL_AUTOMATION_HTTP_URL_KEY,
  LOCAL_AUTOMATION_APP_VERSION_KEY,
  RUNTIME_GLOBALS,
  isRuntimeGlobalKey
} from './runtime-globals'

/** 测试注入点——缺省读 process.env；reader 接受此类型（结构子集即可）。
 * 不 import NodeJS 类型（oxlint 报 no-redundant-type-constituents + 模块未导出），
 * 直接用结构子集表达：{ readonly [k: string]: string | undefined } | null |
 * undefined，让 env?.X 的 optional chain 仍合理。process.env 在 Node 端是
 * NodeJS.ProcessEnv，结构上是 string | undefined 值映射。 */
export type EnvSource = { readonly [key: string]: string | undefined } | null | undefined

// ── reader 形态工具（防 jscpd：相似 reader 复用 helper）──

/**
 * 解析为正整数（trim + 严格正则 + 范围校验）。
 * 复制自 bridge/server/index.ts:28-40 的 PORT 解析语义——
 * "7600abc" 这种 Number.parseInt 会静默通过，必须用 /^\d+$/ 显式拦。
 *
 * 行为纪律：完全沿用 bridge/server/index.ts 原位语义，不顺手放宽/收紧。
 */
function readStrictPort(text: string | undefined, envName: string): number {
  const trimmed = (text ?? '').trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${envName} must be an integer in 0–65535, got "${text ?? ''}"`)
  }
  const value = Number.parseInt(trimmed, 10)
  if (value < 0 || value > 65535) {
    throw new Error(`${envName} must be an integer in 0–65535, got "${text ?? ''}"`)
  }
  return value
}

/** 解析为非负整数（trim + 严格正则 + 安全整数校验）。 */
function readStrictNonNegativeInt(
  text: string | undefined,
  envName: string,
  maxSafeInt: number
): number {
  const trimmed = (text ?? '').trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${envName} must be a non-negative integer, got "${text ?? ''}"`)
  }
  const value = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(value) || value > maxSafeInt) {
    throw new Error(`${envName} must be an integer in 0–${maxSafeInt}, got "${text ?? ''}"`)
  }
  return value
}

/**
 * 通用整数 reader（缺省值 + NaN 兜底）。
 * 复制语义：
 *  - Number(...) 形式（非 parseInt）——未设置或非数字 → NaN → || 默认值
 *  - "7600" 等合法数字字符串正常解析
 *  - "7600abc" 之类 → NaN → 走默认（与原位 Number() 行为一致，不抛）
 */
function readEnvNumber(name: string, fallback: number, env: EnvSource): number {
  const raw = env?.[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

// ── per-var readers（按需增删——本单只覆盖盘点清单内的变量）──

/**
 * 桥 TCP 端口——bridge/server/index.ts:28-40 的同源 reader。
 * 严格 parse：未设置走默认 7600；非 /^\d+$/ 抛错（"7600abc" 不再静默通过）；
 * 范围 0–65535；0 表示禁用 TCP。
 */
const DEFAULT_BRIDGE_TCP_PORT = '7600'
export function readBridgeTcpPort(env: EnvSource = process.env): number {
  return readStrictPort(env?.PORT ?? DEFAULT_BRIDGE_TCP_PORT, 'PORT')
}

/**
 * 桥鉴权 token 三态解析——bridge/server/index.ts:71-83 的同源 reader。
 *  - undefined → undefined（让 startServer 自动生成）
 *  - '' → null（显式禁用鉴权）
 *  - 全空白 → 抛错（防「我以为设了其实只是空格」的静默回退）
 *  - 其他 → trim 后值
 */
export type MCPAuthToken = string | null | undefined
export function readMCPAuthToken(env: EnvSource = process.env): MCPAuthToken {
  const raw = env?.OPENPENCIL_MCP_AUTH_TOKEN
  if (raw === undefined) return undefined
  if (raw === '') return null
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(
      'OPENPENCIL_MCP_AUTH_TOKEN is whitespace-only. Set a real token, or use an empty string to disable auth.'
    )
  }
  return trimmed
}

/** CORS origin——bridge/server/index.ts:84。trim，空串归 null。 */
export function readMCPCORSOrigin(env: EnvSource = process.env): string | null {
  return env?.OPENPENCIL_MCP_CORS_ORIGIN?.trim() || null
}

/** Socket 路径覆盖——bridge/server/paths.ts:84 / 107 / index.ts:66。trim，空串归 null。 */
export function readMCPSocketPath(env: EnvSource = process.env): string | null {
  return env?.OPENPENCIL_MCP_SOCKET?.trim() || null
}

/** Discovery 路径覆盖——bridge/server/paths.ts:133。trim，空串归 null。 */
export function readMCPDiscoveryPathOverride(env: EnvSource = process.env): string | null {
  return env?.OPENPENCIL_MCP_DISCOVERY_PATH?.trim() || null
}

/**
 * 桥 app-attach timeout（毫秒）——bridge/server/index.ts:45-61。
 * 未设置/0 → undefined（禁用）。否则严格 parse，> MAX_SAFE_INTEGER 抛错。
 */
const MAX_APP_TIMEOUT_MS = 2_147_483_647
export function readMCPAppAttachTimeoutMs(env: EnvSource = process.env): number | undefined {
  const raw = env?.OPENPENCIL_MCP_APP_TIMEOUT_MS?.trim()
  if (!raw) return undefined
  return readStrictNonNegativeInt(raw, 'OPENPENCIL_MCP_APP_TIMEOUT_MS', MAX_APP_TIMEOUT_MS)
}

/**
 * 桥 RPC 超时（毫秒）——browser-rpc.ts:17 / image-gen/bridge-call.ts:29。
 * 解析语义：未设置或非数字 → 默认 300_000；合法数字正常返回；0 也走默认（NaN）。
 * 与 Number(...)||default 等价——保留原位形式。
 */
export const DEFAULT_RPC_TIMEOUT_MS = 300_000
export function readRPCTimeoutMs(
  fallback: number = DEFAULT_RPC_TIMEOUT_MS,
  env: EnvSource = process.env
): number {
  return Number(env?.OPENPENCIL_RPC_TIMEOUT_MS) || fallback
}

/**
 * 桥 ready marker——bridge/server/index.ts:88 读后写 stderr。
 * 返回 trim 后值；调用方自己做正则校验（^open-pencil-ready:[a-f0-9-]{36}$）。
 */
export function readMCPReadyMarker(env: EnvSource = process.env): string | null {
  const raw = env?.OPENPENCIL_MCP_READY_MARKER
  return raw && raw.trim().length > 0 ? raw.trim() : null
}

/** MCP root（sidecar 形态下 cwd 不可依赖时的显式覆盖）——bridge/server/root.ts:8。trim。 */
export function readMCPRoot(env: EnvSource = process.env): string | null {
  return env?.OPENPENCIL_MCP_ROOT?.trim() || null
}

/**
 * pi 后端监听端口——pi-backend/main.ts:92 / vite-plugin.ts:62 / host.ts:46。
 * 默认 PI_BACKEND_DEFAULT_PORT（7700，来自 config.ts）。
 * 解析语义：原位是 Number(env ?? '7700')——未设置走默认；空字符串走默认；
 * 非法数字（如 'abc'）→ NaN → 行为未定义但与原位一致（依赖 net.listen 抛 EADDRINUSE
 * 之类）。纯搬运，不顺手收紧。
 */
export function readPiBackendPort(fallback: number, env: EnvSource = process.env): number {
  return readEnvNumber('OPENPENCIL_PI_BACKEND_PORT', fallback, env)
}

/**
 * pi 后端鉴权 token——pi-backend/main.ts:73 读后判断「vite 注入 vs standalone 自生成」。
 * trim，空串视同未注入（与原位 `if (injected) return injected` 等价）。
 */
export function readPiAuthToken(env: EnvSource = process.env): string | null {
  const raw = env?.OPENPENCIL_PI_TOKEN
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * session GC 阈值——pi-backend/service.ts:165-166。
 * 默认 200 / 30；解析语义：Number(env ?? default)——未设置走默认；NaN 走默认（`||`）。
 */
export function readMaxSessions(env: EnvSource = process.env): number {
  return readEnvNumber('OPENPENCIL_MAX_SESSIONS', 200, env)
}
export function readSessionMaxAgeDays(env: EnvSource = process.env): number {
  return readEnvNumber('OPENPENCIL_SESSION_MAX_AGE_DAYS', 30, env)
}

/**
 * studio 内置资产目录——pi-backend/service.ts:173 / studio/registry.ts:399。
 * trim，空串视同未注入走 rootDir 默认拼接（与原位 `|| join(...)` 等价）。
 */
export function readStudioBuiltinDir(env: EnvSource = process.env): string | null {
  const raw = env?.OPENPENCIL_STUDIO_BUILTIN_DIR
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * 状态根目录——pi-backend/main.ts:39、host.ts:43 (隐式 cwd 契约)、
 * desktop-electron/main/main.ts:692、bridge/server/root.ts:9。
 * trim，空串视同未注入（与原位 `|| process.cwd()` 等价）。
 */
export function readRootDir(env: EnvSource = process.env): string | null {
  const raw = env?.OPENPENCIL_ROOT_DIR
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * pi 后端生图 HTTP 超时——pi-backend/image-gen/provider.ts:52。
 * 默认 240_000；语义同 readRPCTimeoutMs：未设置或非法 → 默认。
 */
export const DEFAULT_IMAGE_GEN_TIMEOUT_MS = 240_000
export function readImageGenTimeoutMs(
  fallback: number = DEFAULT_IMAGE_GEN_TIMEOUT_MS,
  env: EnvSource = process.env
): number {
  return Number(env?.OPENPENCIL_IMAGE_GEN_TIMEOUT_MS) || fallback
}

/**
 * host/standalone 形态的 HTTP serve 端口——pi-backend/host.ts:48。
 * 默认 8080；语义同 readEnvNumber：未设置走默认；非数字走默认。
 */
export function readServePort(env: EnvSource = process.env): number {
  return readEnvNumber('OPENPENCIL_SERVE_PORT', 8080, env)
}

// ── dev / vite 拓扑 env（vite.config.ts + vite/automation.ts）──

/**
 * dev 桥鉴权 token——vite/automation.ts:9。
 * 缺省 randomUUID（dev 启动时随机生成，与原位 `?? randomUUID()` 等价）。
 * 注意：调用方需要接受"随机生成"副作用；测试环境应注入固定值。
 */
export function readDevAutomationAuthToken(env: EnvSource = process.env): string | null {
  return env?.OPENPENCIL_DEV_TOKEN?.trim() || null
}

/**
 * dev MCP 端口——vite/automation.ts:20。
 * 解析语义：原位 Number(env ?? AUTOMATION_HTTP_PORT) ——未设置走默认；
 * 非整数 / < 1024 / > 65535 → 抛错（与原位 throw 等价）。
 * 缺省走 AUTOMATION_HTTP_PORT 常量（7600）——与原位一致。
 */
export function readDevMCPPort(env: EnvSource = process.env): number {
  const raw = env?.OPENPENCIL_DEV_MCP_PORT
  const port = raw === undefined ? AUTOMATION_HTTP_PORT : Number(raw)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('OPENPENCIL_DEV_MCP_PORT must be an integer between 1024 and 65535')
  }
  return port
}

/**
 * dev CORS origin——vite/automation.ts:24。
 * 解析语义：未设置返回 null（调用方用 host 推默认）；设置则 trim；非 http(s) origin → 抛错。
 */
export function readDevOrigin(env: EnvSource = process.env): string | null {
  const raw = env?.OPENPENCIL_DEV_ORIGIN
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('OPENPENCIL_DEV_ORIGIN must be an HTTP(S) origin')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== trimmed) {
    throw new Error('OPENPENCIL_DEV_ORIGIN must be an HTTP(S) origin')
  }
  return url.origin
}

/** Portless URL——vite/automation.ts:29。无 trim/校验，原样透传。 */
export function readPortlessURL(env: EnvSource = process.env): string | null {
  const raw = env?.PORTLESS_URL
  return raw && raw.length > 0 ? raw : null
}

/** Tauri dev host——vite.config.ts:24。无 trim，原样透传。 */
export function readTauriDevHost(env: EnvSource = process.env): string | null {
  const raw = env?.TAURI_DEV_HOST
  return raw && raw.length > 0 ? raw : null
}

// ── Electron 专用 env（desktop-electron/main/main.ts）──

/**
 * Electron 桥端口——desktop-electron/main/main.ts:71。
 * 默认 0（randomPort）；解析语义：Number(env) || randomPort()。
 * reader 只暴露数值（randomPort 调用留给调用方，因为测试环境无 OS 端口）。
 */
export function readElectronBridgePort(env: EnvSource = process.env): number | null {
  const raw = env?.OPENPENCIL_BRIDGE_PORT
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Electron 后端端口——desktop-electron/main/main.ts:72。
 * 默认 0（randomPort）；解析语义：Number(env) || randomPort()。
 */
export function readElectronBackendPort(env: EnvSource = process.env): number | null {
  const raw = env?.OPENPENCIL_PI_BACKEND_PORT_ELECTRON
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Electron 回环服务端口——desktop-electron/main/main.ts:73。
 * 默认 0（随机）；解析语义：Number(env) || 0（0 触发 randomPort）。
 */
export function readElectronLoopbackPort(env: EnvSource = process.env): number {
  return readEnvNumber('OPENPENCIL_LOOPBACK_PORT', 0, env)
}

// ── 布尔/枚举 env（字符串严格比较）──

/**
 * 严格字符串比较——desktop-electron/main/main.ts 多处用 `=== '1'`。
 * 缺省 false；非 '1' 一律视作 false（保持与原位 `=== '1'` 严格等价）。
 */
function readEnvEquals1(name: string, env: EnvSource): boolean {
  return env?.[name] === '1'
}

/** smoke 模式——desktop-electron/main/main.ts:881。 */
export function readSmokeMode(env: EnvSource = process.env): boolean {
  return readEnvEquals1('OPENPENCIL_SMOKE', env)
}

/** full-smoke 模式——desktop-electron/main/main.ts:882。 */
export function readFullSmokeMode(env: EnvSource = process.env): boolean {
  return readEnvEquals1('OPENPENCIL_FULL_SMOKE', env)
}

/**
 * 单实例锁绕过——desktop-electron/main/main.ts:858-859。
 * 语义：smoke 或 full-smoke 模式自动绕过；或 OPENPENCIL_DISABLE_SINGLE_INSTANCE='1'。
 */
export function readDisableSingleInstanceLock(env: EnvSource = process.env): boolean {
  return (
    readEnvEquals1('OPENPENCIL_SMOKE', env) ||
    readEnvEquals1('OPENPENCIL_FULL_SMOKE', env) ||
    readEnvEquals1('OPENPENCIL_DISABLE_SINGLE_INSTANCE', env)
  )
}

/**
 * 窗口显示开关——desktop-electron/main/main.ts:903。
 * 语义：smoke 模式不显示；OPENPENCIL_SHOW='0' 不显示；OPENPENCIL_SHOW='1' 显示（兼容）。
 * 缺省（非 smoke）显示。
 */
export function readShowWindow(env: EnvSource = process.env): boolean {
  if (readEnvEquals1('OPENPENCIL_SMOKE', env)) return false
  return env?.OPENPENCIL_SHOW !== '0'
}

/** Electron dev URL——desktop-electron/main/main.ts:880。无 trim，原样透传。 */
export function readElectronDevURL(env: EnvSource = process.env): string | null {
  const raw = env?.OPENPENCIL_DEV_URL
  return raw && raw.length > 0 ? raw : null
}
