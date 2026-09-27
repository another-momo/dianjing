/**
 * 2026-09-26 sl-w1-page-state：docUuid 存活唯一守卫——
 * 「同一 docUuid 不得同时被两个实例持有」跨进程 + 跨窗口。
 *
 * 三层登记（设计稿 §10-4）：
 *  1. 内存注册表（同进程多窗快路——同 pid 即同实例不拦）
 *  2. 状态根活性文件 `<rootDir>/open-docs/<docUuid>.json`（跨进程取证）
 *     落盘形态：`{ pid, windowId, heartbeatAt }`
 *  3. 心跳 TTL（默认 60s）——崩溃 / 强制杀进程留下的 stale 登记可被新实例覆盖
 *
 * 三层协同语义：
 *  - 内存 + 活性文件双登记：claim 写盘 + 写内存，refresh 同步两路，release 同步删两路
 *  - 冲突检测：另一实例（不同 pid 或 windowId）持有且心跳在 TTL 内 → 拦
 *  - stale 回收：访问时惰性检查心跳；TTL 过期视为无人持有，可被新实例覆写
 *  - force 逃生口：调用方明确「仍要打开」时跳过冲突拦截（与设计稿 §10-4 「仍要打开」一致）
 *
 * 进程身份 = `process.pid`（同进程多窗 pid 同；窗口区分走 windowId）——
 * 单 tab 内多窗（前后端独立进程）pid 不同，与状态根文件路径下的跨进程冲突
 * 走同一通路。
 *
 * 心跳刷新周期由调用方主动 POST /heartbeat 触发（本模块不内置 timer——
 * 减少本机进程数 + 与 product endpoint 节奏对齐）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 默认心跳 TTL（毫秒）—— 心跳超过此间隔视为 stale，可被新实例覆写 */
export const DEFAULT_HEARTBEAT_TTL_MS = 60_000

/** docUuid 文件名合法性：路径分隔符 / null 字节禁止（与 page-state 同律） */
const DOC_UUID_RE = /^[A-Za-z0-9-]{1,128}$/

function assertValidDocUuid(docUuid: string): void {
  if (!DOC_UUID_RE.test(docUuid)) {
    throw new TypeError(
      `open-docs docUuid 非法：${JSON.stringify(docUuid)}（需 ^[A-Za-z0-9-]{1,128}$）`
    )
  }
}

/** 活性文件落盘形 */
export interface OpenDocRecord {
  pid: number
  windowId: string
  /** 毫秒时间戳（Date.now() 口径，与服务时钟一致） */
  heartbeatAt: number
}

function isOpenDocRecord(value: unknown): value is OpenDocRecord {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.pid === 'number' &&
    Number.isFinite(obj.pid) &&
    typeof obj.windowId === 'string' &&
    obj.windowId.length > 0 &&
    typeof obj.heartbeatAt === 'number' &&
    Number.isFinite(obj.heartbeatAt)
  )
}

export type ClaimResult =
  /** 成功持有（含覆盖 stale / 自我刷新 / force 抢断） */
  | { ok: true; record: OpenDocRecord }
  /** 另一活实例持有（心跳在 TTL 内），未 force 抢断 */
  | {
      ok: false
      reason: 'live_other_instance'
      holder: OpenDocRecord
    }

export type OpenDocsGuard = {
  /**
   * 尝试登记持有某 docUuid：
   *  - 同进程且自身 windowId 已持 → 刷心跳直接返 ok（多窗复用同进程）
   *  - 内存 + 活性文件皆空 → 写入并返 ok（首开 / 前一持有者已 release）
   *  - 活性文件存在但心跳 stale → 覆写并返 ok（崩溃 / 强杀进程回收）
   *  - 活性文件存在且心跳 alive 且持有者是其他 pid 或 windowId → 返 conflict
   *    （除非 force=true 则覆写）
   *
   * windowId 必须非空（窗口身份是冲突判定的次级 key）。
   */
  claim(docUuid: string, windowId: string, opts?: { force?: boolean }): ClaimResult
  /**
   * 心跳刷新：仅当当前持有者与传入 pid+windowId 完全一致时刷新；
   * 否则视为「别人占了」返 false（force=true 也覆盖——已方放弃，
   * 强制把登记转给自己——极少见，仅在重连 / 重启后自愈用）。
   */
  heartbeat(docUuid: string, windowId: string, opts?: { force?: boolean }): boolean
  /**
   * 主动注销：仅当当前持有者与传入 pid+windowId 一致时清除；
   * 不一致（被另一实例抢断 / 自己已无心跳）→ no-op 返 false。
   * 崩溃走 TTL 兜底，无需调用 release。
   */
  release(docUuid: string, windowId: string): boolean
  /**
   * 测试钩子：是否登记某 docUuid（含跨进程读盘）
   */
  exists(docUuid: string): boolean
}

export function createOpenDocsGuard({
  openDocsDir,
  pid,
  heartbeatTtlMs = DEFAULT_HEARTBEAT_TTL_MS,
  now = (): number => Date.now()
}: {
  openDocsDir: string
  pid: number
  heartbeatTtlMs?: number
  now?: () => number
}): OpenDocsGuard {
  // 内存注册表（同进程多窗快路）—— 值是 windowId，方便同进程多窗走快路不拦
  const liveRegistry = new Map<string, string>()

  function filePath(docUuid: string): string {
    return join(openDocsDir, `${docUuid}.json`)
  }

  function writeToDisk(docUuid: string, record: OpenDocRecord): void {
    mkdirSync(openDocsDir, { recursive: true })
    const path = filePath(docUuid)
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmpPath, path)
  }

  function readFromDisk(docUuid: string): OpenDocRecord | null {
    const path = filePath(docUuid)
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return isOpenDocRecord(raw) ? raw : null
    } catch {
      // 坏 JSON = 腐烂 → 当作不存在（与 page-state 同律：腐烂即无）
      return null
    }
  }

  function removeFromDisk(docUuid: string): void {
    const path = filePath(docUuid)
    if (existsSync(path)) unlinkSync(path)
  }

  function isStale(record: OpenDocRecord): boolean {
    return now() - record.heartbeatAt > heartbeatTtlMs
  }

  function isSelf(record: OpenDocRecord, windowId: string): boolean {
    return record.pid === pid && record.windowId === windowId
  }

  function claim(docUuid: string, windowId: string, opts?: { force?: boolean }): ClaimResult {
    assertValidDocUuid(docUuid)
    if (!windowId) {
      throw new TypeError('open-docs windowId 不能为空')
    }
    const force = opts?.force === true

    // 同进程 + 同 windowId：直接刷心跳，视为自我续期
    const memHolder = liveRegistry.get(docUuid)
    if (memHolder === windowId) {
      const record: OpenDocRecord = { pid, windowId, heartbeatAt: now() }
      writeToDisk(docUuid, record)
      return { ok: true, record }
    }

    // 不同进程 / 同进程不同 windowId：必须读盘确认
    const diskRecord = readFromDisk(docUuid)
    if (diskRecord === null) {
      // 落盘空（首开 / 前持有者已删 / 腐烂）→ 直接登记
      const record: OpenDocRecord = { pid, windowId, heartbeatAt: now() }
      writeToDisk(docUuid, record)
      liveRegistry.set(docUuid, windowId)
      return { ok: true, record }
    }

    // 自查：盘上恰好是自己（跨调用持久化场景——同进程同窗，内存被 GC 清空但盘还在）
    if (isSelf(diskRecord, windowId)) {
      const record: OpenDocRecord = { ...diskRecord, heartbeatAt: now() }
      writeToDisk(docUuid, record)
      liveRegistry.set(docUuid, windowId)
      return { ok: true, record }
    }

    // 他人持有：心跳判定
    if (!isStale(diskRecord) && !force) {
      return { ok: false, reason: 'live_other_instance', holder: diskRecord }
    }

    // stale 或 force：覆写
    const record: OpenDocRecord = { pid, windowId, heartbeatAt: now() }
    writeToDisk(docUuid, record)
    liveRegistry.set(docUuid, windowId)
    return { ok: true, record }
  }

  function heartbeat(docUuid: string, windowId: string, opts?: { force?: boolean }): boolean {
    assertValidDocUuid(docUuid)
    if (!windowId) return false
    const force = opts?.force === true
    const memHolder = liveRegistry.get(docUuid)
    if (memHolder === windowId) {
      const record: OpenDocRecord = { pid, windowId, heartbeatAt: now() }
      writeToDisk(docUuid, record)
      return true
    }
    const diskRecord = readFromDisk(docUuid)
    if (diskRecord === null) {
      // 落盘空 + 内存无记录 → 视为自己从未登记，不刷（避免幽灵续期）
      return false
    }
    if (isSelf(diskRecord, windowId)) {
      const record: OpenDocRecord = { ...diskRecord, heartbeatAt: now() }
      writeToDisk(docUuid, record)
      liveRegistry.set(docUuid, windowId)
      return true
    }
    // 他人持有（alive）：不刷
    if (!isStale(diskRecord) && !force) return false
    // stale 或 force：抢断
    const record: OpenDocRecord = { pid, windowId, heartbeatAt: now() }
    writeToDisk(docUuid, record)
    liveRegistry.set(docUuid, windowId)
    return true
  }

  function release(docUuid: string, windowId: string): boolean {
    assertValidDocUuid(docUuid)
    if (!windowId) return false
    const memHolder = liveRegistry.get(docUuid)
    if (memHolder === windowId) {
      liveRegistry.delete(docUuid)
      removeFromDisk(docUuid)
      return true
    }
    const diskRecord = readFromDisk(docUuid)
    if (diskRecord === null) return false
    if (!isSelf(diskRecord, windowId)) return false
    // 自己是当前持有者：清两路
    liveRegistry.delete(docUuid)
    removeFromDisk(docUuid)
    return true
  }

  function exists(docUuid: string): boolean {
    assertValidDocUuid(docUuid)
    if (liveRegistry.has(docUuid)) return true
    return existsSync(filePath(docUuid))
  }

  return { claim, heartbeat, release, exists }
}
