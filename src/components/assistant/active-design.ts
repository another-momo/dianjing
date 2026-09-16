/**
 * T61（Phase 3 W3/T-B10）：选择器 UI 重做的共享前端助手——
 *
 *  - 新建意图信封序列化（共享契约 1，逐字：`[新建意图确认 modeId=<id> profileId=<id>
 *    canvas=<值>]`，全字段可缺省——canvas 为 T65 §2.4 扩展；T60/T65 宿主侧剥离正则
 *    见 pi-backend/active-design-host.ts）与宿主发起的 data part 类型（确认卡 /
 *    同意决定记录 / T65 上下文切换分割线回执）。
 *  - 物化判据已随 A3/C1 退役：勾选股删除后 Case A/B 分叉理由塌，统一卡面
 *    对物化前后无条件为真，判据失去唯一消费者——前端不再 re-export。
 *  - 切换端点客户端（共享契约 2：POST /api/pi/active-design {nodeId} →
 *    身份三元组 {modeId, profileId, briefId}）——面板「设为当前」与同意卡共用。
 *  - 面板读画布通路：makeFigmaFromStore seam（automation/bridge）+ core
 *    scanMarketingDesigns / brief-edit 读写原语。
 */

import { ref } from 'vue'

import { computeAllLayouts } from '@open-pencil/core/layout'
import { walkSubtree } from '@open-pencil/core/tools/fork/marketing/active-design'
import {
  BRIEF_ESTIMATED_HEIGHT,
  BRIEF_WIDTH,
  addBriefMaterialEntry,
  briefBoundDesignIds,
  createBrief,
  isBrief
} from '@open-pencil/core/tools/fork/marketing/brief'
import {
  readBrief,
  removeBriefMaterial,
  updateBriefContent,
  updateMaterialCaption
} from '@open-pencil/core/tools/fork/marketing/brief-edit'
import type { BriefView } from '@open-pencil/core/tools/fork/marketing/brief-edit'
import { scanMarketingDesigns } from '@open-pencil/core/tools/fork/marketing/setup'
import type {
  CanvasSizePreset,
  MarketingDesignRef
} from '@open-pencil/core/tools/fork/marketing/setup'
import { findPlacementPosition } from '@open-pencil/core/tools/fork/placement'

import { makeFigmaFromStore } from '@/app/bridge/figma-factory'
import { getWindowId } from '@/app/bridge/window-id'
import type { EditorStore } from '@/app/editor/active-store'
import { ensureGraphFonts } from '@/app/editor/fonts'

// ── 新建意图信封（共享契约 1；T65 §2.4 扩展 canvas 字段） ─────────────────────

/**
 * 逐字契约：`[新建意图确认 modeId=<id> profileId=<id> canvas=<值>]`（全字段可缺省；
 * canvas 值 = 预设/自由 canvas 字符串，`750x` 高 HUG 或 `750x2000` 固定高）。
 * 置于消息首行；宿主（T60/T65）剥离置旗标，剩余文本进 run。
 */
export function serializeNewIntentEnvelope(selection: {
  modeId?: string | null
  profileId?: string | null
  canvas?: string | null
}): string {
  const fields: string[] = []
  if (selection.modeId) fields.push(`modeId=${selection.modeId}`)
  if (selection.profileId) fields.push(`profileId=${selection.profileId}`)
  if (selection.canvas) fields.push(`canvas=${selection.canvas}`)
  return fields.length > 0 ? `[新建意图确认 ${fields.join(' ')}]` : '[新建意图确认]'
}

// ── 尺寸预设（T65 §2.3 契约 [{label, canvas}]；core setup.ts CanvasSizePreset 单源） ──

/** 形状与 core CanvasSizePreset 全等 → 别名不双写（type-shapes 门禁；
 *  同 manifest.ts PiStudioModeEntry = StudioMode 先例） */
export type NewIntentSizeChoice = CanvasSizePreset

/** canvas 值格式（共享契约 §2.2：`750x` 高 HUG / `750x2000` 固定高） */
export const CANVAS_VALUE_PATTERN = /^\d+x(\d+)?$/

/** sizes 清单防御性归一（输入未知形状 → 只留 {label, canvas} 全合法条目，否则 []） */
export function normalizeSizeChoices(input: unknown): NewIntentSizeChoice[] {
  if (!Array.isArray(input)) return []
  const choices: NewIntentSizeChoice[] = []
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue
    const label = (entry as { label?: unknown }).label
    const canvas = (entry as { canvas?: unknown }).canvas
    if (
      typeof label === 'string' &&
      label !== '' &&
      typeof canvas === 'string' &&
      CANVAS_VALUE_PATTERN.test(canvas)
    ) {
      choices.push({ label, canvas })
    }
  }
  return choices
}

/**
 * manifest modes[].sizes 投影（T65 对账契约：subagent X 落 manifest 数据面）。
 * 形状缺席/不符 → []（确认卡尺寸行只剩自定义输入，不崩）。
 */
export function modeSizeChoices(mode: unknown): NewIntentSizeChoice[] {
  if (typeof mode !== 'object' || mode === null) return []
  return normalizeSizeChoices((mode as { sizes?: unknown }).sizes)
}

/** C2：确认卡尺寸行预设解析——选中 mode 的 manifest.sizes 投影优先；
 *  general 退出 studio manifest（A3 波1 删 workflows/general/）后投影恒空，
 *  回退 GENERAL_SIZE_CHOICES 通用预设；其余未知 mode 给空（只留自定义输入）。 */
export function intentSizeChoices(modeId: string, modeEntry: unknown): NewIntentSizeChoice[] {
  if (modeEntry) return modeSizeChoices(modeEntry)
  return modeId === 'general' ? GENERAL_SIZE_CHOICES : []
}

// ── 宿主发起的 data part 类型 ────────────────────────────────────────────────

/** 新建意图确认卡（宿主发起非工具 part，T56 卡片范式） */
export const NEW_INTENT_PART_TYPE = 'data-new-intent-confirm'

export interface NewIntentPartData {
  modeId: string | null
  profileId: string | null
  /** 被替换的当前目标名（无 active 时 null） */
  activeDesignName: string | null
  /** T65：尺寸预设行（按选中 mode 的 manifest.sizes 投影；general 断供后
   *  由 ChatPanel 改用 GENERAL_SIZE_CHOICES；空 = 只有自定义输入） */
  sizeChoices: NewIntentSizeChoice[]
  resolved: 'confirmed' | 'cancelled' | null
}

/** set_active_design 同意决定记录（本地系统行同消息挂载；重载后派生置灰） */
export const ACTIVE_DESIGN_DECISION_PART_TYPE = 'data-active-design-decision'

export interface ActiveDesignDecisionPartData {
  toolCallId: string
  decision: 'agreed' | 'declined'
  designName: string
}

/**
 * 画布上下文切换回执（T65 决策 D3）：渲染为对话流分割线（—— 已切换到「XX」——），
 * 非 assistant 气泡。切换端点 200 后由 ChatPanel 注入；set_active_design 同意
 * 路径同形态（替换原本地系统行）。
 */
export const CONTEXT_SWITCH_PART_TYPE = 'data-context-switch'

export interface ContextSwitchPartData {
  name: string
}

/**
 * set_active_design 工具 part input 解析（共享契约 3：{proposed:{nodeId,...}}，
 * mutates:false 不落槽）。同意卡（显示）与 ChatPanel（端点调用）共用单源；
 * 防御性归一——形状不符 → null 字段（卡片显示回退 nodeId，端点调用转失败行）。
 */
export function parseSetActiveDesignProposed(input: unknown): {
  nodeId: string | null
  name: string | null
} {
  const empty = { nodeId: null, name: null }
  if (typeof input !== 'object' || input === null || !('proposed' in input)) return empty
  const proposed = input.proposed
  if (typeof proposed !== 'object' || proposed === null) return empty
  const nodeId = 'nodeId' in proposed ? proposed.nodeId : null
  const name = 'name' in proposed ? proposed.name : null
  return {
    nodeId: typeof nodeId === 'string' && nodeId !== '' ? nodeId : null,
    name: typeof name === 'string' && name !== '' ? name : null
  }
}

// ── T91b：setup_design awaiting_new_intent_confirmation 信封解析 ─────────────

/** awaiting 信封详情：modeId / profileId / briefId（共享契约 5——core single source） */
export interface SetupAwaitingIntentPayload {
  modeId: string
  profileId: string
  briefId: string
  message: string
}

/** 从工具 part output 解析 awaiting 信封（不在则返 null——卡片不渲染） */
export function parseSetupAwaitingIntent(input: unknown): SetupAwaitingIntentPayload | null {
  if (typeof input !== 'object' || input === null) return null
  if ((input as { status?: unknown }).status !== 'awaiting_new_intent_confirmation') return null
  const proposed = (input as { proposed?: unknown }).proposed
  if (typeof proposed !== 'object' || proposed === null) return null
  const modeId =
    typeof (proposed as { modeId?: unknown }).modeId === 'string'
      ? (proposed as { modeId: string }).modeId
      : ''
  const profileId =
    typeof (proposed as { profileId?: unknown }).profileId === 'string'
      ? (proposed as { profileId: string }).profileId
      : ''
  const briefId =
    typeof (proposed as { briefId?: unknown }).briefId === 'string'
      ? (proposed as { briefId: string }).briefId
      : ''
  if (!modeId) return null
  const message =
    typeof (input as { message?: unknown }).message === 'string'
      ? (input as { message: string }).message
      : ''
  return { modeId, profileId, briefId, message }
}

/** T91b：POST /api/pi/intent-confirm——前端 ChatAwaitingIntentCard / ChatNewIntentCard 确认按钮触发。
 * A3：canvas 尺寸覆盖值与 modeId/profileId 同持久化（newIntent 四键）。 */
export async function postIntentConfirm(args: {
  modeId: string
  profileId?: string
  canvas?: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // T98-路由：windowId 随确认直传——多窗时桥调用按发起窗路由
    const res = await fetch('/api/pi/intent-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, windowId: getWindowId() })
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null
    if (res.ok && body?.ok === true) return { ok: true }
    return { ok: false, message: body?.message ?? `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// ── C2：general 尺寸预设回退 ────────────────────────────────────────────────

/**
 * general 退出 studio manifest 后（A3 方案：studio/workflows/general/ 已删除），
 * manifest 不再为 general 投影 sizes 行——确认卡通用模式下使用本回退清单。
 *
 * 标签/画布取值沿用旧 general workflow frontmatter 与 design-basics.md 预设节
 * 口径：HUG 高（750x）+ 方形固定（1080x1080）。
 */
export const GENERAL_SIZE_CHOICES: NewIntentSizeChoice[] = [
  { label: '通用画布', canvas: '750x' },
  { label: '方形画布', canvas: '1080x1080' }
]

// ── 切换端点（共享契约 2） ───────────────────────────────────────────────────

/** 端点返回的身份三元组（T60 供） */
export interface ActiveDesignSwitchResult {
  modeId: string
  profileId: string | null
  briefId: string | null
}

/** POST /api/pi/active-design {nodeId}；校验/网络失败 → null（调用方显式报错） */
export async function postActiveDesign(nodeId: string): Promise<ActiveDesignSwitchResult | null> {
  try {
    // T98-路由：windowId 随点选直传——多窗时桥调用按发起窗路由
    const res = await fetch('/api/pi/active-design', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId, windowId: getWindowId() })
    })
    if (!res.ok) return null
    return (await res.json()) as ActiveDesignSwitchResult
  } catch {
    return null
  }
}

// ── 面板读画布通路 ───────────────────────────────────────────────────────────

/** 设计列表面板：扫描当前页营销设计区（core scanMarketingDesigns 复用） */
export function scanCurrentPageDesigns(store: EditorStore): MarketingDesignRef[] {
  return scanMarketingDesigns(makeFigmaFromStore(store))
}

export interface BriefListEntry {
  briefId: string
  name: string
  /** 读穿比较得出（不存储）：本 brief 绑定条目含 active 设计 */
  boundDesignIds: string[]
  /** T79 S1 B：brief 内容预览（截取首 ~40 字符，含内容 placeholder 时为空） */
  contentPreview?: string
}

const BRIEF_CONTENT_PREVIEW_MAX = 40

/** 需求单列表段：只扫当前页（T65 决策 D4 从全文档收回，与单槽同页口径一致；
 *  面板文案明示「当前页面」。T66 trigger 计数同口径——本函数即面板列表口径，
 *  全文档级 scanDocumentBriefs 在当前仓不存在（grep 零命中），无需过滤。） */
export function scanCurrentPageBriefs(store: EditorStore): BriefListEntry[] {
  const graph = store.graph
  const page = graph.getNode(store.state.currentPageId)
  if (!page) return []
  const figma = makeFigmaFromStore(store)
  const briefs: BriefListEntry[] = []
  walkSubtree(graph, page.childIds, (node) => {
    if (isBrief(node)) {
      const view = readBrief(figma, node.id)
      const content = view?.content ?? ''
      const trimmed = content.trim()
      let contentPreview: string | undefined
      if (trimmed !== '') {
        contentPreview =
          trimmed.length > BRIEF_CONTENT_PREVIEW_MAX
            ? `${trimmed.slice(0, BRIEF_CONTENT_PREVIEW_MAX)}…`
            : trimmed
      }
      briefs.push({
        briefId: node.id,
        name: node.name,
        boundDesignIds: briefBoundDesignIds(node),
        contentPreview
      })
    }
    // brief 内部递归无害（结构内不会再嵌 brief；同 core scanMarketingDesigns 先例）
    return undefined
  })
  return briefs
}

// ── 排版结算 + undo 登记（T66 决策②根因修复） ────────────────────────────────

/**
 * brief 变更的统一收尾（旧分支 feature/agent-backend brief-panel.ts applyMutation
 * 四件套在当前 EditorStore 表面的等效）：快照 → core 原语变更 → computeAllLayouts
 * 排版结算 → requestRender → pushUndoEntry。
 *
 * 根因（T66-plan ②定谳）：桥直调 core 原语只改图，不结算布局——文字节点停在
 * 未测量态，auto-layout 折叠/叠块（T65 新建需求单排版错乱即此）。undo 通路沿
 * tool-handlers.ts withAIUndo 先例（snapshotPage/pushUndoEntry）；失败回滚 before
 * 快照，不留半变更 brief。
 *
 * 注意：PageSnapshot 只覆盖页面节点，不含 graph.images 字节——撤销 add-material
 * 移除条目节点，图像字节留在内容寻址缓存里（无害，与旧分支同律）。
 */
async function applyBriefMutation(
  store: EditorStore,
  label: string,
  mutate: (figma: ReturnType<typeof makeFigmaFromStore>) => boolean
): Promise<boolean> {
  const before = store.snapshotPage()
  try {
    const figma = makeFigmaFromStore(store)
    if (!mutate(figma)) {
      store.restorePageFromSnapshot(before)
      return false
    }
    // T79 B2：ensureGraphFonts 必须在 computeAllLayouts 前跑——CJK fallback
    // 加载后清空 textPicture 才能让后续排版结算拿到正确字宽（tool-handlers.ts
    // :191-194 桥端同范式：mutates 后先 ensureGraphFonts 再 computeAllLayouts）
    const pageNode = store.graph.getNode(store.state.currentPageId)
    if (pageNode) await ensureGraphFonts(store.graph, pageNode.childIds, store.renderer)
    computeAllLayouts(store.graph, store.state.currentPageId)
    store.requestRender()
    const after = store.snapshotPage()
    store.pushUndoEntry({
      label,
      forward: () => store.restorePageFromSnapshot(after),
      inverse: () => store.restorePageFromSnapshot(before)
    })
    return true
  } catch (error) {
    console.error('[brief] mutation failed, rolled back:', error)
    store.restorePageFromSnapshot(before)
    return false
  }
}

/**
 * 新建需求单（T65 决策 D1）：core create_brief 原语经桥直调——只建 brief 节点
 * 落画布（不触发 setup_design；AI 后续语言认领）。放置走共享 findPlacementPosition
 * （页面内容右侧 +100，同 create_brief 工具）；返回新 briefId 供列表重扫。
 *
 * T66：收尾补齐排版结算四件套（旧分支 createBriefInStore 蓝本）——
 * computeAllLayouts（当前页 scope）→ select → zoomToSelection 定位展示 →
 * requestRender → undo 登记「新建需求单」。此前缺结算，新建 brief 文字节点
 * 未测量、auto-layout 折叠/叠块。
 */
export async function createBriefOnPage(store: EditorStore, content: string): Promise<string> {
  const before = store.snapshotPage()
  const figma = makeFigmaFromStore(store)
  const position = findPlacementPosition(figma, {
    width: BRIEF_WIDTH,
    height: BRIEF_ESTIMATED_HEIGHT
  })
  const brief = createBrief(figma, position.x, position.y)
  // T79 B1：空内容也调用 updateBriefContent——core 内部把 ContentExample 占位文本
  // 清空，留出空态输入位（不写内容时保持 ContentExample 占位给用户看）
  updateBriefContent(figma, brief.id, content.trim())
  // T79 B2：同 applyBriefMutation 收尾，确保字体加载在排版结算之前
  const pageNode = store.graph.getNode(store.state.currentPageId)
  if (pageNode) await ensureGraphFonts(store.graph, pageNode.childIds, store.renderer)
  computeAllLayouts(store.graph, store.state.currentPageId)
  store.select([brief.id])
  store.zoomToSelection()
  store.requestRender()
  const after = store.snapshotPage()
  store.pushUndoEntry({
    label: '新建需求单',
    forward: () => store.restorePageFromSnapshot(after),
    inverse: () => store.restorePageFromSnapshot(before)
  })
  return brief.id
}

/** 详情编辑视图读模型（结构不完整 → null，面板显式提示） */
export function readBriefView(store: EditorStore, briefId: string): BriefView | null {
  return readBrief(makeFigmaFromStore(store), briefId)
}

/** 需求单内容写回（core updateBriefContent 直改画布文本节点 + 排版结算 + undo） */
export async function saveBriefContent(
  store: EditorStore,
  briefId: string,
  text: string
): Promise<boolean> {
  return applyBriefMutation(store, '编辑需求内容', (figma) =>
    updateBriefContent(figma, briefId, text)
  )
}

/** 素材条目标题写回（+ 排版结算 + undo） */
export async function saveMaterialCaption(
  store: EditorStore,
  entryId: string,
  caption: string
): Promise<boolean> {
  return applyBriefMutation(store, '编辑素材备注', (figma) =>
    updateMaterialCaption(figma, entryId, caption)
  )
}

// ── 素材四能力（T66 决策②，ChatBriefDialog；旧分支 apply* 蓝本） ─────────────

/**
 * 上传图片入库 + 挂为素材条目：字节直接交给 core addBriefMaterialEntry——
 * 内部 figma.createImage(bytes) 走 computeImageHash + graph.images.set
 * （figma-api/index.ts:524 内容寻址入库通路），无需调用方单独入库。
 * 返回新条目 entryId（失败 null）。
 */
export async function addBriefMaterialFromUpload(
  store: EditorStore,
  briefId: string,
  bytes: Uint8Array
): Promise<string | null> {
  let entryId: string | null = null
  await applyBriefMutation(store, '添加素材', (figma) => {
    const result = addBriefMaterialEntry(figma, briefId, bytes, '')
    if ('error' in result) return false
    entryId = result.entryId
    return true
  })
  return entryId
}

/** 选区图像节点扫描（旧分支 getSelectionImageNodes 等效）：携带 IMAGE fill 的节点 → {nodeId, hash} */
export function findSelectionImageNodes(
  store: EditorStore,
  ids?: Iterable<string>
): Array<{ nodeId: string; hash: string }> {
  const targets: Array<{ nodeId: string; hash: string }> = []
  for (const id of ids ?? store.state.selectedIds) {
    const fill = store.graph.getNode(id)?.fills.find((f) => f.type === 'IMAGE' && f.imageHash)
    if (fill?.type === 'IMAGE' && fill.imageHash) targets.push({ nodeId: id, hash: fill.imageHash })
  }
  return targets
}

/**
 * 选区图像批量挂为素材条目（一次 undo 事务），返回成功条数。
 * T66 简化裁决：当前仓无移动语义对应的原语编排需求——一律复制（保留画布原节点），
 * 不做旧分支的 move/copy 选择器（self-check 已记录偏差）。
 */
export async function addBriefMaterialsFromSelection(
  store: EditorStore,
  briefId: string
): Promise<number> {
  const targets = findSelectionImageNodes(store)
  if (targets.length === 0) return 0
  let added = 0
  await applyBriefMutation(store, '添加素材', (figma) => {
    for (const { hash } of targets) {
      const result = addBriefMaterialEntry(figma, briefId, { hash }, '')
      if (!('error' in result)) added++
    }
    return added > 0
  })
  return added
}

/** 素材条目删除（core removeBriefMaterial + 排版结算 + undo） */
export async function removeBriefMaterialEntry(
  store: EditorStore,
  entryId: string
): Promise<boolean> {
  return applyBriefMutation(store, '删除素材', (figma) => removeBriefMaterial(figma, entryId))
}

// ── 需求单大面板开关状态（T66 决策②；模块级 ref，settings/dialog.ts 先例） ──

export const briefDialogOpen = ref(false)
/** dialog 目标 brief（打开时由列表条目指定；dialog 零自有事实源，只存 id） */
export const briefDialogBriefId = ref<string | null>(null)

export function openBriefDialog(briefId: string): void {
  briefDialogBriefId.value = briefId
  briefDialogOpen.value = true
}

export function closeBriefDialog(): void {
  briefDialogOpen.value = false
}
