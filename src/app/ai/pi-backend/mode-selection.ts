/**
 * T61（Phase 3 W3/T-B10）重写：未确认新建意向暂存。
 *
 * 2026-09-27 state-layering wave-2（帧无身份 + 单槽退役）：active_design 单槽
 * 读穿态（piActiveDesign）整体摘除——设计区身份 = 页本身（一页一作品），规制
 * 真源 = page-state 文档标量（确认端点直写），chips 回显由确认卡族批次归族
 * 收口（现行规约不在此重裁）。本模块保留：
 *  - piStudioManifest：数据源不变（GET /api/pi/studio/manifest），失败按
 *    08 P0-2 纪律显式暴露（piStudioManifestFailed=true → chips 禁用 + 错误条
 *    + 重试），不静默 null 降级。
 *  - piPendingNewIntent：用户手动拨 chip 的未确认暂存（不持久化）——发消息时
 *    ChatPanel 拦为新建意图确认卡；取消回滚后清空，确认发出转入在途。意向在
 *    chips 上的呈现 = 与 piChipEcho 逐项比对，不同的 chip 变色 + Tip 悬停全文提示。
 *  - piInFlightIntent：已确认、待物化的在途意向（不持久化）——确认→落图窗口期
 *    维持 chip/状态栏显示。不触发变色/Tip（已确认非暂存），不拦发送（拦截只读
 *    pending）。
 */

import { computed, ref } from 'vue'

import type { PiStudioCapabilities, PiStudioManifest } from '@/app/ai/pi-backend/studio/manifest'

// ── manifest（显式失败面） ───────────────────────────────────────────────────

export const piStudioManifest = ref<PiStudioManifest | null>(null)
/** 拉取失败显式暴露（chips 禁用 + 错误条 + 重试的判定源） */
export const piStudioManifestFailed = ref(false)

let manifestRequested = false

/** 纯拉取：成功返回 manifest，失败返回 null——写态与失败语义由调用方定 */
async function fetchPiStudioManifest(): Promise<PiStudioManifest | null> {
  try {
    const res = await fetch('/api/pi/studio/manifest')
    if (!res.ok) return null
    return (await res.json()) as PiStudioManifest
  } catch (error) {
    console.warn('[pi-backend] studio manifest 拉取失败', error)
    return null
  }
}

/** 首拉/重试写态：失败（null）进显式失败面（chips 禁用 + 错误条 + 重试） */
function applyInitialManifest(manifest: PiStudioManifest | null): void {
  piStudioManifest.value = manifest
  piStudioManifestFailed.value = manifest === null
}

/** 拉取 manifest（进程内一次；失败 → piStudioManifestFailed 显式暴露，用重试恢复） */
export async function ensurePiStudioManifest(): Promise<void> {
  if (manifestRequested) return
  manifestRequested = true
  // T87：与 capabilities 并行拉取（独立 endpoint，不被 manifest 失败阻断）——
  // capabilities 失败按 null 降级，不进入 piStudioManifestFailed 显式失败面
  const [manifest] = await Promise.all([fetchPiStudioManifest(), fetchPiCapabilities()])
  applyInitialManifest(manifest)
}

/** 错误条重试按钮通路：仅在失败态再拉 */
export async function retryPiStudioManifest(): Promise<void> {
  if (!piStudioManifestFailed.value) return
  applyInitialManifest(await fetchPiStudioManifest())
}

/**
 * 失效重拉（studio-manifest-refetch）：chips combobox 打开 / 新会话铸新时调用。
 * 后端 listSkills 每次实时扫目录，新装 skill 随本拉取即见——前端不再进程内
 * 只拉一次。与首拉不同：已有数据时失败保留旧值不进失败面（瞬断不该灭 chips）；
 * 零数据时等价首拉语义（失败面照常亮）。
 */
export async function refreshPiStudioManifest(): Promise<void> {
  const manifest = await fetchPiStudioManifest()
  if (manifest === null && piStudioManifest.value !== null) return
  applyInitialManifest(manifest)
}

// ── T87：capabilities 镜像（settings 面板 AppSwitch + ChatInput chips 共享） ─
//
// 拉取策略与 manifest 同：ensurePiStudioManifest 触发一并拉一次（同一 endpoint
// 主题，避免前端散点），失败按 null 降级——settings 开关按关闭处理、ChatInput
// chips 行不渲染（availableSkills computed 空集判定）。
// PUT 由 settings 面板触发，成功后调 applyPiCapabilities mutate 本地避免
// round-trip；不主动重新拉 manifest（manifest 在 capabilities 写入后已被
// 后端覆盖，下一次 ensurePiStudioManifest 才会更新前端本地态——本模块不强
// 制刷新，调用方按需 retry）。错误反馈由 settings 面板 handleError 局部
// 承担，不扩展本模块错误面（与 manifest 失败条同源纪律）。
// T96：形状扩为 PiStudioCapabilities（builtinTools 三档 + agentSkills）——
// type-only 复用 manifest.ts 别名（最终单源 capabilities.ts Capabilities），
// 不另立字面类型（test:type-shapes 门禁禁同构重复）。
export const piCapabilities = ref<PiStudioCapabilities | null>(null)

async function fetchPiCapabilities(): Promise<void> {
  try {
    const res = await fetch('/api/pi/capabilities')
    if (!res.ok) {
      piCapabilities.value = null
      return
    }
    piCapabilities.value = (await res.json()) as PiStudioCapabilities
  } catch (error) {
    piCapabilities.value = null
    console.warn('[pi-backend] capabilities 拉取失败——settings 开关按关闭处理', error)
  }
}

/** 同步更新（settings 面板 PUT 成功后调用，乐观更新避免 round-trip） */
export function applyPiCapabilities(next: PiStudioCapabilities): void {
  piCapabilities.value = next
}

// ── 未确认新建意向暂存（chips 拨动；不持久化） ───────────────────────────────

/** chips 默认态（chips 回显单源在确认卡族批次归族收口——暂存比对用缺省值） */
export const PI_DEFAULT_MODE_ID = 'general'

/** chips 选择（两级：mode → profile；type 级已随 T62 删除，无专属逻辑） */
export interface PiNewIntentSelection {
  modeId: string
  profileId: string | null
}

export const piPendingNewIntent = ref<PiNewIntentSelection | null>(null)

/** 已确认待物化的在途意向（确认→落图窗口期显示锚；不持久化） */
export const piInFlightIntent = ref<PiNewIntentSelection | null>(null)

/** chips 回显（缺省态）——pending 各字段与它逐项比对出变色锚点 */
export const piChipEcho = computed<PiNewIntentSelection>(() => ({
  modeId: PI_DEFAULT_MODE_ID,
  profileId: null
}))

/** chips 显示的单一事实源：未确认意向 > 在途意向 > 回显 */
export const piChipSelection = computed<PiNewIntentSelection>(
  () => piPendingNewIntent.value ?? piInFlightIntent.value ?? piChipEcho.value
)

function sameSelection(a: PiNewIntentSelection, b: PiNewIntentSelection): boolean {
  return a.modeId === b.modeId && a.profileId === b.profileId
}

/**
 * chips 拨动写口：与回显相同 = 无意图（清空暂存）；不同 = 暂存新建意向，
 * 发消息时由 ChatPanel 拦为确认卡（只拨 chip 浏览不发消息 = 无意图事件）。
 */
export function setPiChipSelection(selection: PiNewIntentSelection): void {
  piPendingNewIntent.value = sameSelection(selection, piChipEcho.value) ? null : selection
}

/** 取消回滚后清空暂存（chips 回落缺省回显）；确认发出走 markPiIntentInFlight */
export function clearPiPendingNewIntent(): void {
  piPendingNewIntent.value = null
}

/**
 * 确认发出：暂存转在途——chips/状态栏维持显示所选 mode（窗口期显示锚，
 * 确认卡族批次归族时收口清偿时点）。在途不拦发送、不变色（已确认非暂存）。
 */
export function markPiIntentInFlight(selection: PiNewIntentSelection): void {
  piInFlightIntent.value = selection
  piPendingNewIntent.value = null
}
