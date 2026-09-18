/**
 * T61（Phase 3 W3/T-B10）重写：active_design 同步态 + 未确认新建意向暂存。
 *
 * T24 旧链退役（S4 T-B10 / PD-16 翻案）：localStorage `open-pencil:pi-chat-mode`
 * 全局选择态删除——chips 不再是路由开关，而是 active_design 的回显 + 新建意图
 * 暂存（共享契约 5，与 T60 对账）：
 *
 *  - piActiveDesign：文档根 sharedPluginData `activeDesignNodeId` 单槽
 *    （namespace = BRIEF_PLUGIN_NAMESPACE，键面常量以 core active-design.ts
 *    为单一事实源，T60 写入侧经桥落地）读出 nodeId，再从设计区根框标记
 *    读穿身份三元组 {modeId, profileId, briefId}（typeId 已随 T62 删除，
 *    旧文档残留键天然忽略）。指针任何移动后自动同步（sceneVersion watch +
 *    graph:replaced + tab 切换）；系统同步不触发意图。无 active（槽空 /
 *    节点被删 / 标记缺失）→ null → chips 回显默认态（general + 无 profile）。
 *    T65：null 同时是画布工作状态面板（ChatContextBar，ChatPanel header）的
 *    空槽信号——trigger 回落引导文案；resyncPiActiveDesign 是切换端点 200 后
 *    的显式兜底（分割线回执经 ChatPanel 注入，不在本模块）。
 *  - piPendingNewIntent：用户手动拨 chip 的未确认暂存（不持久化）——发消息时
 *    ChatPanel 拦为新建意图确认卡；取消回滚后清空，确认发出转入在途。意向在
 *    chips 上的呈现 = 与 piChipEcho 逐项比对，不同的 chip 变色 + Tip 悬停全文提示。
 *  - piInFlightIntent：已确认、待 setup_design 物化的在途意向（不持久化）——
 *    确认→落槽窗口期维持 chip/状态栏显示（否则 pending 已清、active 未建，
 *    双空回落默认态：chip 闪回「通用设计」、状态栏闪「待新建」）；同步点读到
 *    匹配身份的 active design 时清偿。不触发变色/Tip（已确认非暂存），不拦
 *    发送（拦截只读 pending）。
 *  - piStudioManifest：数据源不变（GET /api/pi/studio/manifest），但失败按
 *    08 P0-2 纪律显式暴露（piStudioManifestFailed=true → chips 禁用 + 错误条
 *    + 重试），不再静默 null 降级。
 *
 * sharedPluginData 读取经 core getSharedPluginData（figma-api/plugin-data 深路径，
 * 同 AskUserQuestionCard 的 core 深 import 先例；编码键 `${namespace}/${key}`）。
 */

import { computed, shallowRef, ref, watch } from 'vue'

import { getSharedPluginData } from '@open-pencil/core/figma-api/plugin-data'
import { ACTIVE_DESIGN_KEY } from '@open-pencil/core/tools/fork/marketing/active-design'
import {
  BRIEF_PLUGIN_NAMESPACE,
  DESIGN_BRIEF_KEY,
  DESIGN_MODE_KEY,
  DESIGN_PROFILE_KEY,
  DESIGN_UNIQUE_ID_KEY
} from '@open-pencil/core/tools/fork/marketing/brief'
import { isMarketingDesignRoot } from '@open-pencil/core/tools/fork/marketing/setup'

import type { PiStudioCapabilities, PiStudioManifest } from '@/app/ai/pi-backend/studio/manifest'
import {
  getActiveEditorStoreOrNull,
  useActiveEditorStoreRef,
  type EditorStore
} from '@/app/editor/active-store'

// ── manifest（显式失败面） ───────────────────────────────────────────────────

export const piStudioManifest = ref<PiStudioManifest | null>(null)
/** 拉取失败显式暴露（chips 禁用 + 错误条 + 重试的判定源） */
export const piStudioManifestFailed = ref(false)

let manifestRequested = false

async function fetchPiStudioManifest(): Promise<void> {
  piStudioManifestFailed.value = false
  try {
    const res = await fetch('/api/pi/studio/manifest')
    if (!res.ok) {
      piStudioManifest.value = null
      piStudioManifestFailed.value = true
      return
    }
    piStudioManifest.value = (await res.json()) as PiStudioManifest
  } catch (error) {
    piStudioManifest.value = null
    piStudioManifestFailed.value = true
    console.warn('[pi-backend] studio manifest 拉取失败——chips 禁用并显式暴露', error)
  }
}

/** 拉取 manifest（进程内一次；失败 → piStudioManifestFailed 显式暴露，用重试恢复） */
export async function ensurePiStudioManifest(): Promise<void> {
  if (manifestRequested) return
  manifestRequested = true
  // T87：与 capabilities 并行拉取（独立 endpoint，不被 manifest 失败阻断）——
  // capabilities 失败按 null 降级，不进入 piStudioManifestFailed 显式失败面
  await Promise.all([fetchPiStudioManifest(), fetchPiCapabilities()])
}

/** 错误条重试按钮通路：允许失败后再拉（成功后幂等——manifest 不变更） */
export async function retryPiStudioManifest(): Promise<void> {
  if (!piStudioManifestFailed.value) return
  await fetchPiStudioManifest()
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

// ── active_design 同步态（共享契约 5） ───────────────────────────────────────

/** chips 默认态：无 active 时回显（general + 无 profile） */
export const PI_DEFAULT_MODE_ID = 'general'

export interface PiActiveDesignIdentity {
  nodeId: string
  name: string
  modeId: string
  profileId: string | null
  briefId: string | null
  /** T91a 寻址键（老文档缺省 null）——bound-designs 列表比对需优先用它（列表存 UUID） */
  uniqueId: string | null
}

/** 当前 active_design 身份（读穿，null = 无 active → chips 默认态） */
export const piActiveDesign = shallowRef<PiActiveDesignIdentity | null>(null)

/**
 * 已确认待物化的在途意向（确认→setup_design 落槽窗口期的显示锚；不持久化）。
 * 声明必须先于下方 watcher——immediate 回调在模块求值期同步执行，后置声明
 * 会撞 TDZ。
 */
export const piInFlightIntent = ref<PiNewIntentSelection | null>(null)

function readActiveDesignIdentity(store: EditorStore | null): PiActiveDesignIdentity | null {
  const root = store?.graph.getNode(store.graph.rootId)
  const nodeId = root ? getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, ACTIVE_DESIGN_KEY) : ''
  if (nodeId === '') return null
  const node = store?.graph.getNode(nodeId)
  // 槽内指针悬空（节点被删 / 已非设计区根框）→ 视为无 active（清槽与聊天提示归宿主/T60）
  if (!store || !isMarketingDesignRoot(node)) return null
  const design = node
  const read = (key: string) => getSharedPluginData(design, BRIEF_PLUGIN_NAMESPACE, key)
  return {
    nodeId: design.id,
    name: design.name,
    modeId: read(DESIGN_MODE_KEY) || PI_DEFAULT_MODE_ID,
    profileId: read(DESIGN_PROFILE_KEY) || null,
    briefId: read(DESIGN_BRIEF_KEY) || null,
    uniqueId: read(DESIGN_UNIQUE_ID_KEY) || null
  }
}

/**
 * active 写点收口（watcher 三路 + 显式重同步共用）：写入读穿身份，并在身份
 * 与在途意向匹配时清偿在途——物化完成的信号 = 槽内指针读出的身份三元组。
 */
function syncPiActiveDesign(store: EditorStore | null): void {
  const next = readActiveDesignIdentity(store)
  piActiveDesign.value = next
  const inFlight = piInFlightIntent.value
  if (next === null || inFlight === null) return
  if (next.modeId === inFlight.modeId && next.profileId === inFlight.profileId) {
    piInFlightIntent.value = null
  }
}

/** 显式重同步（切换端点成功回包后调用；常规路径由下方 watcher 自动覆盖） */
export function resyncPiActiveDesign(): void {
  syncPiActiveDesign(getActiveEditorStoreOrNull())
}

const activeStoreRef = useActiveEditorStoreRef()
watch(
  activeStoreRef,
  (store, _prev, onCleanup) => {
    syncPiActiveDesign(store ?? null)
    if (!store) return
    const currentStore = store
    const stopGraphReplaced = currentStore.onEditorEvent('graph:replaced', () => {
      syncPiActiveDesign(currentStore)
    })
    // 指针移动 / 标记写入都走 graph mutation → sceneVersion++（同 autosave 信号）
    const stopSceneWatch = watch(
      () => currentStore.state.sceneVersion,
      () => {
        syncPiActiveDesign(currentStore)
      }
    )
    onCleanup(() => {
      stopGraphReplaced()
      stopSceneWatch()
    })
  },
  { immediate: true }
)

// ── 未确认新建意向暂存（chips 拨动；不持久化） ───────────────────────────────

/** chips 选择（两级：mode → profile；type 级已随 T62 删除，无专属逻辑） */
export interface PiNewIntentSelection {
  modeId: string
  profileId: string | null
}

export const piPendingNewIntent = ref<PiNewIntentSelection | null>(null)

/** active 身份 → chips 回显选择（无 active → null，调用方回落默认态） */
function activeToSelection(active: PiActiveDesignIdentity | null): PiNewIntentSelection | null {
  if (!active) return null
  return { modeId: active.modeId, profileId: active.profileId }
}

/** chips 回显（active 读穿，无 active → 默认态）——pending 各字段与它逐项比对出变色锚点 */
export const piChipEcho = computed<PiNewIntentSelection>(
  () =>
    activeToSelection(piActiveDesign.value) ?? {
      modeId: PI_DEFAULT_MODE_ID,
      profileId: null
    }
)

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

/** 取消回滚后清空暂存（chips 回落 active 回显）；确认发出走 markPiIntentInFlight */
export function clearPiPendingNewIntent(): void {
  piPendingNewIntent.value = null
}

/**
 * 确认发出：暂存转在途——chips/状态栏维持显示所选 mode，直到同步点读出
 * 匹配身份的 active design 清偿。在途不拦发送、不变色（已确认非暂存）。
 */
export function markPiIntentInFlight(selection: PiNewIntentSelection): void {
  piInFlightIntent.value = selection
  piPendingNewIntent.value = null
}
