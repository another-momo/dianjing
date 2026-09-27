/**
 * 2026-09-27 open-docs 存活守卫前端接线——设计真源
 * docs/202609231923-state-layering-locus-gate.md §10-4（后端半 = pi-backend/open-docs/）。
 *
 *  - claim 触发点 = 显式调用（禁 graph watcher 轮询——性能税）：三条文档打开
 *    通路完成点（tabs 模块）+ ensurePiDocUuid 惰性铸造时刻（mint 钩子注入）；
 *    无 uuid 文档（从未 AI 交互）不拦不 claim。
 *  - 心跳 = claim 成功后 20s 周期（TTL 60s 的 1/3）；409 = 持有权被夺走 →
 *    停心跳 + warn 一句，不 force 抢回（防两实例互殴）。
 *  - release = closeTab 注入点 + pagehide 兜底（sendBeacon 优先，fetch
 *    keepalive 兜底——仓内无先例，按 spec 取 sendBeacon 优先）。
 *  - 一窗多文档 = Map<docUuid, timer>；tab 切换不关文档不 release。同一
 *    uuid 多 tab（复制文件继承 uuid 的退化场景）共享一份持有，首个 close 即
 *    release（后端 release 对已不持者 no-op）。
 */

import { shallowRef } from 'vue'

import { readPiDocUuid, setPiDocUuidMintedListener } from '@/app/ai/pi-backend/document-key'
import { getWindowId } from '@/app/bridge/window-id'
import type { EditorStore } from '@/app/editor/active-store'

import { requestClaim, requestHeartbeat, requestRelease, type OpenDocsHolder } from './api'

/** 心跳间隔 = TTL（60s）的 1/3 */
const HEARTBEAT_INTERVAL_MS = 20_000

export interface OpenDocsConflictState {
  docUuid: string
  store: EditorStore
  documentName: string
  holder: OpenDocsHolder
}

/** 冲突覆写卡状态（null = 无冲突；对话框组件只读消费） */
export const openDocsConflict = shallowRef<OpenDocsConflictState | null>(null)

const heldTimers = new Map<string, ReturnType<typeof setInterval>>()

function stopHeartbeat(docUuid: string): void {
  const timer = heldTimers.get(docUuid)
  if (timer === undefined) return
  clearInterval(timer)
  heldTimers.delete(docUuid)
}

function startHeartbeat(docUuid: string): void {
  stopHeartbeat(docUuid)
  const timer = setInterval(() => {
    void sendHeartbeat(docUuid)
  }, HEARTBEAT_INTERVAL_MS)
  heldTimers.set(docUuid, timer)
}

async function sendHeartbeat(docUuid: string): Promise<void> {
  try {
    if ((await requestHeartbeat(docUuid)) === 'taken') {
      // 持有权被夺走：停心跳即可，不 force 抢回（防两实例互殴）
      stopHeartbeat(docUuid)
      console.warn(`[open-docs] heartbeat rejected, another window holds ${docUuid}`)
    }
  } catch {
    // 网络抖动：本轮失败不摘持有，下轮心跳续刷
  }
}

/**
 * 文档打开完成 / docUuid 铸出后的 claim 入口：无 uuid 直接返回；本窗已持有
 * 或冲突卡已展示同文档时幂等返回。claim 不可用（网络等）时文档照常打开、
 * 只是不登记——守卫尽力而为，不阻塞打开。
 */
export async function claimDocumentOpen(store: EditorStore, docUuid?: string): Promise<void> {
  const uuid = docUuid ?? readPiDocUuid(store)
  if (uuid === null) return
  if (heldTimers.has(uuid) || openDocsConflict.value?.docUuid === uuid) return
  const outcome = await requestClaim(uuid)
  if (outcome.kind === 'claimed') {
    startHeartbeat(uuid)
  } else if (outcome.kind === 'conflict') {
    showConflict(store, uuid, outcome.holder)
  } else {
    console.warn('[open-docs] claim unavailable, document opened without hold')
  }
}

function showConflict(store: EditorStore, docUuid: string, holder: OpenDocsHolder): void {
  // 组件常驻 App 根（UnsavedChangesDialog 同款集中挂载），状态驱动显隐
  openDocsConflict.value = {
    docUuid,
    store,
    documentName: store.state.documentName,
    holder
  }
}

/**
 * 冲突卡应答：force = 「仍要打开」（后端 force 必成功覆写他人登记，失败仅可能
 * 是网络——卡保持打开可重试）；close = 关掉刚打开的 tab（closer 由生产装配
 * 注入）；dismiss = Esc/遮罩关闭（tab 保留、不 claim，仅清卡）。
 */
export async function answerOpenDocsConflict(choice: 'force' | 'close' | 'dismiss'): Promise<void> {
  const conflict = openDocsConflict.value
  if (!conflict) return
  if (choice === 'dismiss') {
    openDocsConflict.value = null
    return
  }
  if (choice === 'close') {
    openDocsConflict.value = null
    const closer = conflictTabCloser
    if (!closer) {
      console.warn('[open-docs] no tab closer wired, conflict card closed without action')
      return
    }
    await closer(conflict.store)
    return
  }
  const outcome = await requestClaim(conflict.docUuid, true)
  if (outcome.kind === 'claimed') {
    openDocsConflict.value = null
    startHeartbeat(conflict.docUuid)
  } else if (outcome.kind === 'conflict') {
    openDocsConflict.value = { ...conflict, holder: outcome.holder }
  }
}

/** pagehide 兜底（wire 时挂到 window；导出供单测直调） */
export function releaseAllOnPageHide(): void {
  for (const uuid of [...heldTimers.keys()]) {
    stopHeartbeat(uuid)
    sendReleaseBeacon(uuid)
  }
}

function sendReleaseBeacon(docUuid: string): void {
  const payload = JSON.stringify({ docUuid, windowId: getWindowId() })
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(
      '/api/pi/open-docs/release',
      new Blob([payload], { type: 'application/json' })
    )
    return
  }
  void fetch('/api/pi/open-docs/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true
  }).catch(() => undefined)
}

/** tab 关闭时的 release 入口：只对本窗实际持有的 uuid 发请求 */
export function releaseDocumentClaim(store: EditorStore): void {
  const uuid = readPiDocUuid(store)
  if (uuid === null || !heldTimers.has(uuid)) return
  stopHeartbeat(uuid)
  void requestRelease(uuid)
}

let conflictTabCloser: ((store: EditorStore) => Promise<void>) | null = null
let wired = false

/**
 * 生产装配（tabs 模块调用一次）：注入冲突卡「关闭」的关 tab 通路 + docUuid
 * mint 钩子 + pagehide release 兜底。重复调用刷新 closer 并重挂 mint 钩子
 * （同一闭包，重挂无害）；window 监听只挂一次（幂等）。
 */
export function wireOpenDocsLifecycle(options: {
  closeStoreTab: (store: EditorStore) => Promise<void>
}): void {
  conflictTabCloser = options.closeStoreTab
  setPiDocUuidMintedListener((store, uuid) => {
    void claimDocumentOpen(store, uuid)
  })
  if (wired) return
  wired = true
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', releaseAllOnPageHide)
  }
}
