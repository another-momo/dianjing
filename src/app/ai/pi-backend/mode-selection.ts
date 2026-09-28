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
 *  - piPendingNewIntent：用户手动拨 chip 的未物化暂存（内存态不持久化，
 *    文档切换时由 ChatPanel 清空防跨文档串味）——发送即物化：发消息时
 *    ChatPanel 先走 materializePiPendingIntent 直写 page-state（成功才发送，
 *    失败 fail-closed 不发送），不再拦截弹卡。意向在 chips 上的呈现 =
 *    与 piChipEcho 逐项比对，不同的 chip 变色 + Tip 悬停全文提示。
 *
 * 2026-09-27 意图确认卡退役（发送即物化批）：piInFlightIntent 在途过渡态
 * 随写穿摘除——确认端点直写 page-state 后不存在「确认→落图窗口期」，
 * chips 回显（piChipEcho）从硬编码缺省改接 page-state（真源），拉取 /
 * 乐观更新 / locus preflight 顺手刷新三个写口见下方注。
 */

import { computed, ref } from 'vue'

import type { MaterialSpec } from '@open-pencil/core/tools/fork/marketing/material-specs'

import type { PiStudioCapabilities, PiStudioManifest } from '@/app/ai/pi-backend/studio/manifest'

import { fetchLocusPageState, type LocusState } from './page-state-client'

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

// ── 未物化新建意向暂存（chips 拨动；内存态不持久化，文档切换清空） ─────────────

/** chips 默认态（page-state 无 modeId 时的缺省回显——缺省链 §2 拍板兜底值） */
export const PI_DEFAULT_MODE_ID = 'general'

/** chips 选择（两级：mode → profile；type 级已随 T62 删除，无专属逻辑） */
export interface PiNewIntentSelection {
  modeId: string
  profileId: string | null
}

export const piPendingNewIntent = ref<PiNewIntentSelection | null>(null)

/**
 * chips 回显真源 = page-state 文档标量（2026-09-27 意图确认卡退役批，E2 债
 * 清偿——原硬编码缺省）。模块级 ref，三写口：
 *  1. refreshPiChipEcho：文档就绪 / docUuid 变更时 GET 一次（只读探测——
 *     调用方须先核 docUuid 已存在，本函数不铸新 docUuid）；GET 失败保持
 *     现状 + console.warn（兜底缺省即旧行为，不进显式失败面）。
 *  2. materializePiPendingIntent 成功后乐观更新（免 round-trip，
 *     applyPiCapabilities 先例）。
 *  3. locus preflight 顺手刷新：发送前 GET page-state 本就发生，ChatPanel
 *     拿到 state 时经 syncPiChipEchoFromPageState 同步（零新增请求）。
 */
const piPageStateEcho = ref<PiNewIntentSelection>({
  modeId: PI_DEFAULT_MODE_ID,
  profileId: null
})

/** chips 回显——pending 各字段与它逐项比对出变色锚点 */
export const piChipEcho = computed<PiNewIntentSelection>(() => piPageStateEcho.value)

/** chips 显示的单一事实源：未物化暂存 > 回显（page-state） */
export const piChipSelection = computed<PiNewIntentSelection>(
  () => piPendingNewIntent.value ?? piChipEcho.value
)

function sameSelection(a: PiNewIntentSelection, b: PiNewIntentSelection): boolean {
  return a.modeId === b.modeId && a.profileId === b.profileId
}

/**
 * chips 拨动写口：与回显相同 = 无意图（清空暂存）；不同 = 暂存新建意向，
 * 发消息时经 materializePiPendingIntent 发送即物化（只拨 chip 浏览不发消息
 * = 无意图事件）。
 */
export function setPiChipSelection(selection: PiNewIntentSelection): void {
  piPendingNewIntent.value = sameSelection(selection, piChipEcho.value) ? null : selection
}

/** 清空暂存（chips 回落 page-state 回显）——文档切换时 ChatPanel 调用防串味 */
export function clearPiPendingNewIntent(): void {
  piPendingNewIntent.value = null
}

/** echo 直写写口：物化成功后的乐观更新（免 round-trip） */
export function applyPiChipEcho(selection: PiNewIntentSelection): void {
  piPageStateEcho.value = selection
}

/**
 * page-state → echo 归一（GET 到手 / preflight 顺手刷新共用）：state 缺失
 * 或 modeId 显式清空（null）一律回落缺省链 general + 无 profile——与后端
 * page-state.ts「缺省链 general 兜底」口径一致。
 */
export function syncPiChipEchoFromPageState(state: LocusState | null): void {
  piPageStateEcho.value = {
    modeId: state?.modeId ?? PI_DEFAULT_MODE_ID,
    profileId: state?.profileId ?? null
  }
}

/**
 * 拉取 page-state 刷新 echo（文档就绪 / docUuid 变更时调用一次）。
 * 只读探测纪律：调用方先以 readPiDocUuid 核 docUuid 已存在再调——本函数
 * 不为拉 echo 铸新 docUuid。GET 失败保持现状 + warn（echo 兜底缺省即旧
 * 行为，不回退到显式失败面）。
 */
export async function refreshPiChipEcho(docUuid: string): Promise<void> {
  const result = await fetchLocusPageState(docUuid)
  if (result.kind === 'unreachable') {
    console.warn('[pi-backend] page-state 拉取失败——chips 回显保持现状', result.message)
    return
  }
  syncPiChipEchoFromPageState(result.value.state)
}

/** intent-confirm 写通道签名（注入用——app 层不得 import components 层
 *  active-design.ts 的 postIntentConfirm，生产接线在 ChatPanel 显式传入） */
export type PiIntentConfirmPoster = (args: {
  modeId: string
  profileId?: string
}) => Promise<{ ok: true } | { ok: false; message: string }>

/**
 * 发送即物化：chip 武装态（piPendingNewIntent 非空）时，发送前直写
 * page-state（POST /api/pi/intent-confirm，经注入的 poster）。成功 =
 * 清暂存 + echo 乐观更新；失败 = 暂存保留、回显不动，由调用方 fail-closed
 * （toast + 草稿回填 + 不发送）。无武装 = 直通 ok。
 */
export async function materializePiPendingIntent(
  post: PiIntentConfirmPoster
): Promise<{ ok: true } | { ok: false; message: string }> {
  const intent = piPendingNewIntent.value
  if (!intent) return { ok: true }
  const result = await post({
    modeId: intent.modeId,
    ...(intent.profileId !== null ? { profileId: intent.profileId } : {})
  })
  if (!result.ok) return result
  applyPiChipEcho({ modeId: intent.modeId, profileId: intent.profileId })
  piPendingNewIntent.value = null
  return { ok: true }
}

// ── 物料暂存（chips 物料排拨动；内存态不持久化，文档切换清空） ──────────────
//
// 用户点输入框下方的物料 chip → 暂存为 armed 态，消息文本前自动追物料提示
// 行（just-in-time hint），agent 据此按平台规格落图。toggle：同 id 再点 =
// 清空。文档切换、发送成功路径由 ChatPanel 主动清——locus 门扣留/取消路径
// 不动 armed 态（用户改主意不发了也要保留臂装）。非物化、不联网——纯内存态。
export const piPendingMaterial = ref<MaterialSpec | null>(null)

/** toggle：武装或清空（armed 同 id 再点 = 清空；不同 id = 覆盖） */
export function setPiPendingMaterial(spec: MaterialSpec): void {
  piPendingMaterial.value = piPendingMaterial.value?.id === spec.id ? null : spec
}

/** 显式清空（locus 扣留/取消路径不改本态——失败回填保留臂装供重试） */
export function clearPiPendingMaterial(): void {
  piPendingMaterial.value = null
}

/**
 * 武装态 → 序列化前缀行 + 空行（拼到消息头）。未 armed → 空串。
 *
 * `format` 是 i18n 文本模板，三个占位符逐字替换：
 *   {label}    → spec.label
 *   {width}    → spec.width（数字）
 *   {height}   → spec.height 字符串（数字或流高文案「流高」/「flow」）
 * 当前缀拼到消息头时与正文隔一行（`\n\n`）——agent 看到一行 hint +
 * 一行消息本体。
 *
 * 设计要点：括号 / 标点 / 关键词 全部留给 i18n 文本自带——函数零硬编码
 * 半角/全角，zh `物料：{label}（{width}×{height}）`、en
 * `Material: {label} ({width}x{height})` 各自拼。
 */
export function buildPiMaterialPrefix(format: { prefix: string; heightFlow: string }): string {
  const spec = piPendingMaterial.value
  if (!spec) return ''
  const heightText = spec.height === null ? format.heightFlow : String(spec.height)
  const line = format.prefix
    .replace('{label}', spec.label)
    .replace('{width}', String(spec.width))
    .replace('{height}', heightText)
  return `${line}\n\n`
}
