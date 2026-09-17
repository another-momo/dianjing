/**
 * active_design 文档级单槽 + set_active_design 工具（T60，S3 §9 / S1 §5 PD-19）。
 *
 * 单槽落盘：文档根节点（graph.rootId）sharedPluginData 只存 `activeDesignNodeId`
 * （namespace 复用 BRIEF_PLUGIN_NAMESPACE）；身份三元组 {modeId, profileId, briefId}
 * 从设计区根框标记读穿展示（T53 DESIGN_* 键），单一事实源不复制。typeId 已被
 * T62 并行删除——本模块不读不写 typeId，旧文档残留键天然忽略。
 *
 * 四事件移槽的全部写面都在宿主（pi-backend active-design-host.ts 经桥 eval 到
 * 浏览器侧执行）；本模块提供：
 *  - in-proc 读写/校验函数（工具 execute 与 bun 测试直接用 FigmaAPI 跑）
 *  - 桥探针快照形状 + 纯函数判定（checkActiveDesignCandidate /
 *    evaluateActiveDesignSlot）——后端宿主对桥取回的裸数据跑同一判定，四条件
 *    逻辑单源不双写
 *  - set_active_design ToolDef（mutates:false）：AI 声明切目标——只返回
 *    {proposed:{nodeId,...}}，不落槽；同意卡与端点调用归 T61/宿主端点
 *
 * 物化判据（C1 退役，A3 方案）：勾选股删除后分叉理由塌，统一卡面对物化前后
 * 无条件为真——判据失去唯一消费者，本模块不再导出 isDesignMaterialized，
 * set_active_design 结果不再携带 materialized 字段。
 *
 * 集成纪律：FORK_TOOLS（fork/index.ts）与 pi-backend 暴露面由主 agent 集成期
 * 统一接线，ACTIVE_DESIGN_TOOLS 数组是唯一交付面（同 HERO_TOOLS 先例）。
 */

import * as v from 'valibot'

import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import type { FigmaAPI } from '#core/figma-api'
import { getSharedPluginData, setSharedPluginData } from '#core/figma-api/plugin-data'
import { defineTool, type ToolDef } from '#core/tools/schema'

import {
  BRIEF_BINDING_KEY,
  BRIEF_PLUGIN_NAMESPACE,
  BRIEF_ROLE_KEY,
  BRIEF_ROLE_VALUE,
  DESIGN_BRIEF_KEY,
  NEW_INTENT_CANVAS_KEY,
  NEW_INTENT_CONFIRMED_KEY,
  NEW_INTENT_MODE_ID_KEY,
  NEW_INTENT_PROFILE_ID_KEY,
  DESIGN_MODE_KEY,
  DESIGN_PROFILE_KEY,
  DESIGN_UNIQUE_ID_KEY,
  briefBoundDesignIds,
  findBriefByUniqueId,
  isBrief
} from './brief'
import { HERO_GEOMETRY_KEY } from './hero-scaffold'
import { MARKETING_ROLE_ROOT, isMarketingDesignRoot } from './setup'
import { ACTIVE_DESIGN_TEXTS } from './texts'

/** 单槽键：文档根 sharedPluginData `activeDesignNodeId`（空串 = 空槽） */
export const ACTIVE_DESIGN_KEY = 'activeDesignNodeId'

/** 设计身份三元组（typeId 已随 T62 删除；读穿自设计区根框标记，缺省 ''） */
export interface ActiveDesignIdentity {
  modeId: string
  profileId: string
  briefId: string
}

// ── 单槽读写（文档根 sharedPluginData）───────────────────────────────────────

function documentRoot(figma: FigmaAPI): SceneNode | undefined {
  return figma.graph.getNode(figma.graph.rootId)
}

/** 读槽；空槽 / 根节点缺失 → '' */
export function readActiveDesignNodeId(figma: FigmaAPI): string {
  const root = documentRoot(figma)
  if (!root) return ''
  return getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, ACTIVE_DESIGN_KEY)
}

/** 写槽（调用方须已完成合法性校验——宿主端点四条件 / setup_design 新建成功） */
export function writeActiveDesignNodeId(figma: FigmaAPI, nodeId: string): void {
  const root = documentRoot(figma)
  if (!root) return
  setSharedPluginData(figma.graph, root, BRIEF_PLUGIN_NAMESPACE, ACTIVE_DESIGN_KEY, nodeId)
}

/** 清槽（setSharedPluginData 空串语义 = 删键） */
export function clearActiveDesignNodeId(figma: FigmaAPI): void {
  writeActiveDesignNodeId(figma, '')
}

// ── 桥探针快照形状（in-proc 与桥 eval 双产源，判定纯函数单源）────────────────

/** 设计区根框裸快照：类型/页归属/role 判定 + 三元组读穿 */
export interface DesignRootSnapshot {
  nodeId: string
  name: string
  type: string
  /** 祖先 CANVAS id；游离（不在任何页）→ null */
  pageId: string | null
  marketingRoot: boolean
  modeId: string
  profileId: string
  briefId: string
  /** T91a：design 根的 uniqueId（UUID v4）。跨 .fig 重导入仍稳定——判定 brief↔design 双向绑定用 */
  uniqueId: string
}

/** brief 关联裸快照：页归属 + bound-designs 指针（逗号分隔串拆表） */
export interface BriefLinkSnapshot {
  briefId: string
  pageId: string | null
  boundDesignIds: string[]
}

function pageIdOf(graph: SceneGraph, node: SceneNode): string | null {
  let current: SceneNode | undefined = node
  while (current) {
    if (current.type === 'CANVAS') return current.id
    current = current.parentId ? graph.getNode(current.parentId) : undefined
  }
  return null
}

/** in-proc 产源：节点 → 快照；节点不存在 → null
 *
 * T91a：DESIGN_BRIEF_KEY 存的是 brief 的 uniqueId（UUID v4）。本快照对调用
 * 方面暴露 brief 的节点 id（更合用：UI、跨 API 拼装），UUID → 节点 id 在
 * 此处解析；老文档残留 node id 兼容。
 */
export function snapshotDesignRoot(figma: FigmaAPI, nodeId: string): DesignRootSnapshot | null {
  const node = figma.graph.getNode(nodeId)
  if (!node) return null
  const rawBriefId = getSharedPluginData(node, BRIEF_PLUGIN_NAMESPACE, DESIGN_BRIEF_KEY)
  const briefByUuid = rawBriefId ? findBriefByUniqueId(figma, rawBriefId) : undefined
  return {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    pageId: pageIdOf(figma.graph, node),
    marketingRoot: isMarketingDesignRoot(node),
    modeId: getSharedPluginData(node, BRIEF_PLUGIN_NAMESPACE, DESIGN_MODE_KEY),
    profileId: getSharedPluginData(node, BRIEF_PLUGIN_NAMESPACE, DESIGN_PROFILE_KEY),
    briefId: briefByUuid ? briefByUuid.id : rawBriefId,
    uniqueId: getSharedPluginData(node, BRIEF_PLUGIN_NAMESPACE, DESIGN_UNIQUE_ID_KEY)
  }
}

/** in-proc 产源：briefId → 关联快照；空 id / 节点不存在 / 非 brief → null
 *
 * T91a：`briefId` 入参既可以是 brief 节点 id，也可以是 brief 的 uniqueId（UUID v4）。
 * 设计根的 DESIGN_BRIEF_KEY 在新文档里写 UUID；老文档残留 node id 也兼容。
 */
export function snapshotBriefLink(figma: FigmaAPI, briefId: string): BriefLinkSnapshot | null {
  if (briefId === '') return null
  // T91a：先按 UUID 解析（设计根 pluginData 走的寻址键）；找不到再退回 node id。
  let node = findBriefByUniqueId(figma, briefId)
  if (!node) node = figma.graph.getNode(briefId)
  if (!isBrief(node)) return null
  return {
    briefId: node.id,
    pageId: pageIdOf(figma.graph, node),
    boundDesignIds: briefBoundDesignIds(node)
  }
}

// ── 四条件校验（纯函数单源；宿主端点 ②/③ 与 in-proc 共用）────────────────────

export type ActiveDesignRejectReason =
  | 'not_found'
  | 'not_design_root'
  | 'cross_page'
  | 'brief_mismatch'

export type ActiveDesignCheck =
  | { ok: true; design: DesignRootSnapshot }
  | { ok: false; reason: ActiveDesignRejectReason; message: string }

/**
 * 合法性四条件（S1 §5 / S3 §9；宿主永不猜测，只做校验）：
 * ①节点存在 ②是设计区根框（isMarketingDesignRoot）③同页（候选与当前页一致）
 * ④briefId 一致——声明的 brief 存在、同页、且其 bound-designs 指针登记本设计
 * （双向链接一致；设计身份落盘与 brief 关联登记同为 setup_design 原子产物）。
 */
export function checkActiveDesignCandidate(
  nodeId: string,
  design: DesignRootSnapshot | null,
  brief: BriefLinkSnapshot | null,
  currentPageId: string
): ActiveDesignCheck {
  if (!design) {
    return { ok: false, reason: 'not_found', message: ACTIVE_DESIGN_TEXTS.notFound(nodeId) }
  }
  if (!design.marketingRoot) {
    return {
      ok: false,
      reason: 'not_design_root',
      message: ACTIVE_DESIGN_TEXTS.notDesignRoot(design.nodeId)
    }
  }
  if (design.pageId === null || design.pageId !== currentPageId) {
    return { ok: false, reason: 'cross_page', message: ACTIVE_DESIGN_TEXTS.crossPage }
  }
  if (!brief || brief.pageId !== currentPageId) {
    return { ok: false, reason: 'brief_mismatch', message: ACTIVE_DESIGN_TEXTS.briefMismatch }
  }
  // T91a：bound-designs 现在存 design 的 uniqueId（UUID）；候选是 design.nodeId。
  // 双向一致判定走 UUID 比对（scanDesigns 已用同口径）。Design 快照里已有
  // uniqueId 字段（addUniqueIdField），无需 figma 入参。Pure-function tests
  // that omit uniqueId get `''`; we treat that as "fall back to node id match"
  // — old docs without UUID keep working.
  const designUuid = design.uniqueId || ''
  const boundOk =
    designUuid !== ''
      ? brief.boundDesignIds.includes(designUuid)
      : brief.boundDesignIds.includes(design.nodeId)
  if (!boundOk) {
    return { ok: false, reason: 'brief_mismatch', message: ACTIVE_DESIGN_TEXTS.briefMismatch }
  }
  return { ok: true, design }
}

/** in-proc 便捷形态：figma 直取快照后走纯函数（工具 execute / 测试用） */
export function validateActiveDesignCandidate(figma: FigmaAPI, nodeId: string): ActiveDesignCheck {
  const design = snapshotDesignRoot(figma, nodeId)
  const brief = design ? snapshotBriefLink(figma, design.briefId) : null
  return checkActiveDesignCandidate(nodeId, design, brief, figma.currentPage.id)
}

// ── 槽位状态读穿（每回合组装输入）────────────────────────────────────────────

export type ActiveDesignSlotState =
  | { status: 'empty' }
  | {
      status: 'ok'
      design: DesignRootSnapshot
      /** brief 悬空（需求单被删，设计区仍在）→ 宿主注入一行提示（S1 §5 删除边界态） */
      briefMissing: boolean
    }
  /** 槽位节点不存在或已不再是设计区根框 → 宿主清槽 + 一行提示 */
  | { status: 'dangling'; nodeId: string }

/**
 * 槽位读穿判定（纯函数）。注意与候选校验不同：③④不作清槽依据——设计区被
 * 移到别页 / brief 被删都不是丢目标的理由（S1 §5：brief 悬空走显式提示）。
 */
export function evaluateActiveDesignSlot(
  slotNodeId: string,
  design: DesignRootSnapshot | null,
  brief: BriefLinkSnapshot | null
): ActiveDesignSlotState {
  if (slotNodeId === '') return { status: 'empty' }
  if (!design || !design.marketingRoot) return { status: 'dangling', nodeId: slotNodeId }
  return { status: 'ok', design, briefMissing: brief === null }
}

// ── 子树遍历共享助手（jscpd 克隆治理：stack walk 习语单源）────────────────────

/** 深度优先走查 startIds 子树；visit 返回 true 提前终止整轮 */
export function walkSubtree(
  graph: SceneGraph,
  startIds: readonly string[],
  visit: (node: SceneNode) => boolean | undefined
): void {
  const stack = [...startIds]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) break
    const node = graph.getNode(id)
    if (!node) continue
    if (visit(node) === true) return
    stack.push(...node.childIds)
  }
}

// ── set_active_design 工具（AI 声明，不落槽）─────────────────────────────────

export const setActiveDesignTool = defineTool({
  name: 'set_active_design',
  execution: { kind: 'sync', mutation: 'none' },
  exposure: { mcp: false, webmcp: false },
  description:
    'Propose switching the current design target (the `[当前设计目标 …]` context line) to ANOTHER EXISTING marketing design root — used when the user wants to keep working on a prior design (e.g. when the user says "let\'s keep working on the previous long image" / "继续之前那张长图" / "改一下上一张"). This only DECLARES the intent: it validates the target and returns {proposed:{nodeId,name,modeId,profileId,briefId}} WITHOUT moving the active design — the user confirms in the chat UI, and only then does the host move the slot via the host endpoint. Never use this to create a new design (that is setup_design), and never retry it to "force" a switch: an {error} result means the target is not a valid switch candidate (not_found / not_design_root / cross_page / brief_mismatch) — tell the user and stop.',
  input: v.object({
    node_id: v.pipe(
      v.string(),
      v.description(
        'Node id of the existing marketing design root frame to propose as the new current design target.'
      )
    )
  }),
  execute: (figma, args) => {
    const check = validateActiveDesignCandidate(figma, args.node_id)
    if (!check.ok) return { error: check.reason, message: check.message }
    const { design } = check
    return {
      proposed: {
        nodeId: design.nodeId,
        name: design.name,
        modeId: design.modeId,
        profileId: design.profileId,
        briefId: design.briefId
      }
    }
  }
})

/** 集成纪律：FORK_TOOLS / pi-backend 暴露面由主 agent 统一接线，本数组是唯一交付面 */
export const ACTIVE_DESIGN_TOOLS: ToolDef[] = [setActiveDesignTool]

// 供桥 eval 探针插值复用的键面常量（单一事实源，宿主模块 import 拼接）
export const ACTIVE_DESIGN_PROBE_KEYS = {
  namespace: BRIEF_PLUGIN_NAMESPACE,
  slotKey: ACTIVE_DESIGN_KEY,
  roleKey: BRIEF_ROLE_KEY,
  roleRoot: MARKETING_ROLE_ROOT,
  roleBrief: BRIEF_ROLE_VALUE,
  modeKey: DESIGN_MODE_KEY,
  profileKey: DESIGN_PROFILE_KEY,
  briefKey: DESIGN_BRIEF_KEY,
  bindingKey: BRIEF_BINDING_KEY,
  heroGeometryKey: HERO_GEOMETRY_KEY,
  /** design 根与 brief 根同键名（'uniqueId'）——探针两侧捕获/解析共用 */
  uniqueIdKey: DESIGN_UNIQUE_ID_KEY,
  // T91b：newIntent pluginData 键面常量 import 单源，从 brief.ts 复用
  // A3：四键（新增 canvas 覆盖值持久化——与 envelope canvas 字段同源）
  newIntentModeIdKey: NEW_INTENT_MODE_ID_KEY,
  newIntentProfileIdKey: NEW_INTENT_PROFILE_ID_KEY,
  newIntentConfirmedKey: NEW_INTENT_CONFIRMED_KEY,
  newIntentCanvasKey: NEW_INTENT_CANVAS_KEY
} as const
