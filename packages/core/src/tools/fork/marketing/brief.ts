/**
 * 需求单 (design brief) — rebuild/v2 四区移植（T52，规格 S3 §3）。
 *
 * 结构：琥珀色便签根 frame，左列（'需求内容'）承载 内容区 / 素材区 /
 * 关联设计区（新建）三张白卡，右列为深琥珀 AI结论区。全部节点为普通
 * FRAME/TEXT/RECTANGLE（.fig 往返无损），标记走 pluginData（改名不丢）。
 *
 * 与源仓（open-pencil feature/agent-backend @ 5d38aa4e）的差异：
 * - 标记面：全部走通用 get/setSharedPluginData（namespace
 *   'open-pencil-marketing'；读侧 matchesSharedPluginData 兼容旧档非编码键）。
 * - 四区：新增关联设计区；区寻址读 zone pluginData 标记（content /
 *   materials / conclusions / designs），中文显示名仅作展示，读侧保留
 *   name 兜底以兼容旧档。根节点 schemaVersion = 1。
 * - findBrief 无静默兜底：解析序 = 显式 briefId > 当前页唯一 brief >
 *   歧义信号（源仓「当前页第一个」兜底已废除）。
 * - 结论按设计归组：组 frame 携带 designId 标记 + GroupTitle 显示名；
 *   存储不分区，per-design 视图由读取侧过滤。
 * - 关联设计区条目 = 设计 id 权威（条目 pluginData designId）+ 名称 /
 *   mode 投影（读穿设计根 pluginData 三元组——T53 写入，此前
 *   缺省显示 BRIEF_TEXTS.missingProjection）。惰性调和在读取侧：
 *   设计已死 → 视图标注「（已删除）」保痕，不物理清除；design→brief
 *   指针有而条目缺 → 视图补显（registered: false），物理补写走
 *   syncBriefDesignEntries（变更路径调用）。
 */

import type { Fill, SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import { TRANSPARENT } from '#core/constants'
import type { FigmaAPI } from '#core/figma-api'
import { getSharedPluginData, setSharedPluginData } from '#core/figma-api/plugin-data'

import { BRIEF_TEXTS } from './texts'

// ── pluginData 标记协议 ────────────────────────────────────────────────────

export const BRIEF_PLUGIN_NAMESPACE = 'open-pencil-marketing'
export const BRIEF_ROLE_KEY = 'role'
export const BRIEF_ROLE_VALUE = 'brief'
/** Comma-separated design root frame ids this brief serves (brief 1─N designs) */
export const BRIEF_BINDING_KEY = 'bound-designs'
export const BRIEF_SCHEMA_VERSION_KEY = 'schemaVersion'
export const BRIEF_SCHEMA_VERSION = '1'
/** Zone-addressing marker on the four zone cards */
export const BRIEF_ZONE_KEY = 'zone'

export const BRIEF_ZONE_CONTENT = 'content'
export const BRIEF_ZONE_MATERIALS = 'materials'
export const BRIEF_ZONE_CONCLUSIONS = 'conclusions'
export const BRIEF_ZONE_DESIGNS = 'designs'
export type BriefZoneId =
  | typeof BRIEF_ZONE_CONTENT
  | typeof BRIEF_ZONE_MATERIALS
  | typeof BRIEF_ZONE_CONCLUSIONS
  | typeof BRIEF_ZONE_DESIGNS

/**
 * T91a：brief / design 跨持久化边界的稳定唯一标识符（UUID v4）。
 * 写在节点 sharedPluginData[BRIEF_PLUGIN_NAMESPACE]['uniqueId']；序列化到 .fig
 * 后 import 仍保留（见 tests/engine/io/fig/roundtrip/shared-plugin-data.test.ts）。
 * 用作 brief↔design 绑定的寻址键（替代会被 `graph.generateId()` 重生成的节点 id）。
 */
export const BRIEF_UNIQUE_ID_KEY = 'uniqueId'

/** Design 根上的 uniqueId 键（同上，design 侧） */
export const DESIGN_UNIQUE_ID_KEY = 'uniqueId'

/**
 * T91b：newIntent pluginData 三键——「待新建的设计区 workflow / profile / 确认旗标」
 * 存在 document root sharedPluginData（与 activeDesignNodeId 同层），用于跨回合
 * 持久化「用户或 AI 提议的新建意图」，装配时（assembleTurn）优先读、setup_design
 * 执行时读 confirmed 旗标、确认或成功后清除。键名与 activeDesignNodeId 一致
 * 单源在 BRIEF_PLUGIN_NAMESPACE 下，避免键名散落。
 */
export const NEW_INTENT_MODE_ID_KEY = 'newIntentModeId'
export const NEW_INTENT_PROFILE_ID_KEY = 'newIntentProfileId'
export const NEW_INTENT_CONFIRMED_KEY = 'newIntentConfirmed'
/**
 * A3 方案：canvas 尺寸覆盖值与 modeId/profileId/confirmed 同持久化
 * （T91b 三键扩展为四键）——确认意图本就该持久至落图/被覆盖，不该靠
 * agent「记得」当回合调用（§2.2）。
 */
export const NEW_INTENT_CANVAS_KEY = 'newIntentCanvas'

/**
 * T91a：生成跨实例稳定的唯一标识符。`crypto.randomUUID()` 是 Node 14.17+
 * 与所有现代浏览器都内置的实现，跨 .fig 序列化、跨重启、跨图实例都不会冲突。
 * 不能用 `graph.generateId()`——它产出 `0:<n++>` 形式，re-import 时重新分配。
 */
export function generatePluginUniqueId(): string {
  return crypto.randomUUID()
}

/** 读 brief 根 uniqueId（缺则懒补；T91a 一次性迁移老 brief） */
export function getBriefUniqueId(node: SceneNode | undefined): string {
  if (!isBrief(node)) return ''
  return briefMarker(node, BRIEF_UNIQUE_ID_KEY)
}

/** 读 design 根 uniqueId（缺则懒补；T91a 一次性迁移老 design） */
export function getDesignUniqueId(node: SceneNode | undefined): string {
  const v = node ? briefMarker(node, DESIGN_UNIQUE_ID_KEY) : ''
  return v
}

/** 写 brief 根 uniqueId */
export function setBriefUniqueId(graph: SceneGraph, nodeId: string, uuid: string): void {
  setBriefMarker(graph, nodeId, BRIEF_UNIQUE_ID_KEY, uuid)
}

/** 写 design 根 uniqueId */
export function setDesignUniqueId(graph: SceneGraph, nodeId: string, uuid: string): void {
  setBriefMarker(graph, nodeId, DESIGN_UNIQUE_ID_KEY, uuid)
}

/** 扫描当前页，按 uniqueId 找 brief 根 */
export function findBriefByUniqueId(figma: FigmaAPI, uuid: string): SceneNode | undefined {
  if (!uuid) return undefined
  for (const b of listBriefs(figma)) {
    if (getBriefUniqueId(b) === uuid) return b
  }
  return undefined
}

/**
 * T91a：graph-only brief 解析（不需要 figma 句柄，用于 scanMarketingDesigns
 * 把 DESIGN_BRIEF_KEY UUID 翻成 brief 节点 id 的纯读侧路径）。
 */
export function findBriefByUniqueIdViaGraph(
  graph: SceneGraph,
  uuid: string
): SceneNode | undefined {
  if (!uuid) return undefined
  for (const root of graph.nodes.values()) {
    if (!isBrief(root)) continue
    if (getBriefUniqueId(root) === uuid) return root
  }
  return undefined
}

/** 扫描当前页，按 uniqueId 找 design 根（带 DESIGN_ROLE_KEY 标记的 FRAME） */
export function findDesignByUniqueId(figma: FigmaAPI, uuid: string): SceneNode | undefined {
  if (!uuid) return undefined
  const graph = figma.graph
  const page = graph.getNode(figma.currentPageId)
  if (!page) return undefined
  const stack = [...page.childIds]
  while (stack.length > 0) {
    const id = stack.shift()
    if (id === undefined) break
    const node = graph.getNode(id)
    if (!node) continue
    if (node.type === 'FRAME' && getDesignUniqueId(node) === uuid) return node
    stack.push(...node.childIds)
  }
  return undefined
}

// ── T91b：newIntent 显式状态（document root sharedPluginData）────────────────
//
// 设计真源：仓外 docs/202609031650-new-intent-plugindata-design.md。
// 把原本隐式的「envelope.modeId 比装配早 + 内存变量 intentConfirmed」合并为
// document root 上的显式三键——`newIntentModeId` / `newIntentProfileId` /
// `newIntentConfirmed`。所有 .fig 持久化边界外的进程共享同一来源，避免：
//  - Bug 3：装配点用错 workflow
//  - Bug 2 收尾：用户答"是"无法写入，setup_design 永远 unconfirmed_new_intent
//
// 写入调用方：前端 ChatNewIntentCard 确认按钮 → POST /api/pi/intent-confirm
//             → confirmNewIntent(figma, ...) → writeNewIntent。
// 清除调用方：setupDesign 成功落图后 → clearNewIntent；onDesignCreated hook。
// 读取调用方：setupDesign 执行前 → 决定 awaiting 信封 vs 继续；
//             assembleTurn 装配 → 优先于 activeDesign slot 决定 effective ids。
//
// 实现见文件底部 T91b 段（避免重复 + 单源纪律）；键常量 + helper 全数落下方。

export interface NewIntentState {
  modeId: string
  profileId: string
  confirmed: boolean
  /** A3 方案：canvas 尺寸覆盖值（与信封 canvas 字段同源；空串 = 缺省） */
  canvas: string
}

/** 读 document root newIntent 四键。任一缺键视为不存在（空态） */
export function readNewIntent(figma: FigmaAPI): NewIntentState {
  const root = figma.graph.getNode(figma.graph.rootId)
  if (!root) return { modeId: '', profileId: '', confirmed: false, canvas: '' }
  const modeId = getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, NEW_INTENT_MODE_ID_KEY)
  const profileId = getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, NEW_INTENT_PROFILE_ID_KEY)
  const confirmed =
    getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, NEW_INTENT_CONFIRMED_KEY) === 'true'
  const canvas = getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, NEW_INTENT_CANVAS_KEY)
  return { modeId, profileId, confirmed, canvas }
}

/** 写入 newIntent 四键——单一原子入口（前端确认按钮 / envelope 兼容写入） */
export function writeNewIntent(
  figma: FigmaAPI,
  args: { modeId: string; profileId?: string; canvas?: string; confirmed: boolean }
): void {
  const root = figma.graph.getNode(figma.graph.rootId)
  if (!root) return
  setSharedPluginData(
    figma.graph,
    root,
    BRIEF_PLUGIN_NAMESPACE,
    NEW_INTENT_MODE_ID_KEY,
    args.modeId
  )
  setSharedPluginData(
    figma.graph,
    root,
    BRIEF_PLUGIN_NAMESPACE,
    NEW_INTENT_PROFILE_ID_KEY,
    args.profileId ?? ''
  )
  setSharedPluginData(
    figma.graph,
    root,
    BRIEF_PLUGIN_NAMESPACE,
    NEW_INTENT_CANVAS_KEY,
    args.canvas ?? ''
  )
  setSharedPluginData(
    figma.graph,
    root,
    BRIEF_PLUGIN_NAMESPACE,
    NEW_INTENT_CONFIRMED_KEY,
    args.confirmed ? 'true' : ''
  )
}

/** 清除 newIntent 四键——setup_design 成功 / 用户取消意图 */
export function clearNewIntent(figma: FigmaAPI): void {
  writeNewIntent(figma, { modeId: '', profileId: '', canvas: '', confirmed: false })
}

/**
 * 仅确认旗标（不改 modeId / profileId）——用于 envelope 兼容路径：
 * 已有 modeId 但需要把 confirmed 旗标置 true。
 */
export function markNewIntentConfirmed(figma: FigmaAPI, confirmed: boolean): void {
  const root = figma.graph.getNode(figma.graph.rootId)
  if (!root) return
  setSharedPluginData(
    figma.graph,
    root,
    BRIEF_PLUGIN_NAMESPACE,
    NEW_INTENT_CONFIRMED_KEY,
    confirmed ? 'true' : ''
  )
}

/**
 * Design identity tuple keys on design root frames (S3 §9 pluginData 标记协议).
 * WRITTEN BY T53 setup_design — this module only reads them for projections
 * and for the design→brief pointer scan. Exported so T53 shares the key names.
 */
export const DESIGN_MODE_KEY = 'modeId'
export const DESIGN_PROFILE_KEY = 'profileId'
export const DESIGN_BRIEF_KEY = 'briefId'

/** Marker on a designs-zone entry row: the authoritative design root id it points at */
export const BRIEF_DESIGN_ENTRY_KEY = 'designId'
/** Marker on a conclusion group frame: the design root id the group belongs to */
export const BRIEF_CONCLUSION_GROUP_DESIGN_KEY = 'designId'

// ── 结构性节点名（寻址用，非展示文案）───────────────────────────────────────

export const BRIEF_NAME = BRIEF_TEXTS.briefName
export const BRIEF_ENTRY_NAME = '素材条目'
export const BRIEF_CONCLUSIONS_NAME = '结论列表'
export const BRIEF_CONCLUSION_GROUP_NAME = '结论组'
export const BRIEF_GROUP_TITLE_NAME = 'GroupTitle'
export const BRIEF_CONCLUSION_LINE_NAME = '结论'
export const BRIEF_EMPTY_STATE_NAME = '空状态'
export const BRIEF_EMPTY_HINT_NAME = 'EmptyHint'
export const BRIEF_DESIGN_ENTRY_NAME = '设计条目'
const BRIEF_MAIN_NAME = '需求内容'
const BRIEF_CONTENT_INPUT_NAME = 'ContentInput'
const BRIEF_CONTENT_EXAMPLE_NAME = 'ContentExample'
const BRIEF_MATERIAL_GRID_NAME = 'MaterialGrid'
const BRIEF_DESIGN_LIST_NAME = 'DesignList'
const BRIEF_IMAGE_SLOT_NAME = '图片位'
const BRIEF_CAPTION_NAME = 'Caption'
/** Zone display names（展示用；寻址一律读 zone 标记，name 仅作旧档兜底） */
export const BRIEF_ZONE_CONTENT_NAME = BRIEF_TEXTS.contentZoneName
export const BRIEF_ZONE_MATERIALS_NAME = BRIEF_TEXTS.materialsZoneName
export const BRIEF_ZONE_CONCLUSIONS_NAME = BRIEF_TEXTS.conclusionsZoneName
export const BRIEF_ZONE_DESIGNS_NAME = BRIEF_TEXTS.designsZoneName

/** All brief text uses the bundled marketing CJK family (weights resolve via fontWeight) */
export const BRIEF_FONT_FAMILY = 'Alibaba PuHuiTi'

/** Brief frame width (see createBrief) and estimated height, for placement sizing */
export const BRIEF_WIDTH = 1252
export const BRIEF_ESTIMATED_HEIGHT = 850

const BRIEF_ZONE_DISPLAY_NAMES: Record<BriefZoneId, string> = {
  [BRIEF_ZONE_CONTENT]: BRIEF_ZONE_CONTENT_NAME,
  [BRIEF_ZONE_MATERIALS]: BRIEF_ZONE_MATERIALS_NAME,
  [BRIEF_ZONE_CONCLUSIONS]: BRIEF_ZONE_CONCLUSIONS_NAME,
  [BRIEF_ZONE_DESIGNS]: BRIEF_ZONE_DESIGNS_NAME
}

const BRIEF_BG = { r: 0.996, g: 0.965, b: 0.839 }
const CARD_BG = { r: 1, g: 1, b: 1 }
const CARD_STROKE = { r: 0.953, g: 0.91, b: 0.722 }
const INPUT_BG = { r: 0.984, g: 0.973, b: 0.933 }
const INPUT_STROKE = { r: 0.937, g: 0.902, b: 0.784 }
const ACCENT = { r: 0.961, g: 0.62, b: 0.043 }
const AI_ZONE_BG = { r: 0.988, g: 0.827, b: 0.302 }
const TITLE_COLOR = { r: 0.259, g: 0.125, b: 0.024 }
const LABEL_COLOR = { r: 0.706, g: 0.325, b: 0.035 }
const SUB_COLOR = { r: 0.572, g: 0.251, b: 0.055 }
const MUTED_COLOR = { r: 0.631, g: 0.384, b: 0.027 }
const EXAMPLE_COLOR = { r: 0.573, g: 0.38, b: 0.29 }
const SLOT_BG = { r: 0.961, g: 0.941, b: 0.886 }
const SLOT_STROKE = { r: 0.898, g: 0.875, b: 0.784 }

// ── 标记读写 ───────────────────────────────────────────────────────────────

/**
 * Write a marketing marker via the generic shared-pluginData upsert.
 * Re-reads the node so back-to-back writes never clobber each other through
 * stale snapshots.
 */
function setBriefMarker(graph: SceneGraph, nodeId: string, key: string, value: string): void {
  const node = graph.getNode(nodeId)
  if (!node) return
  setSharedPluginData(graph, node, BRIEF_PLUGIN_NAMESPACE, key, value)
}

function briefMarker(node: SceneNode, key: string): string {
  return getSharedPluginData(node, BRIEF_PLUGIN_NAMESPACE, key)
}

export function isBrief(node: SceneNode | undefined): node is SceneNode {
  if (node?.type !== 'FRAME') return false
  return briefMarker(node, BRIEF_ROLE_KEY) === BRIEF_ROLE_VALUE
}

export function briefSchemaVersion(node: SceneNode | undefined): string {
  if (!isBrief(node)) return ''
  return briefMarker(node, BRIEF_SCHEMA_VERSION_KEY)
}

/** Root frame ids this brief is bound to (empty = unbound). */
export function briefBoundDesignIds(node: SceneNode | undefined): string[] {
  if (!isBrief(node)) return []
  const raw = briefMarker(node, BRIEF_BINDING_KEY)
  return raw ? raw.split(',').filter(Boolean) : []
}

/** Add rootFrameId to the brief's bound-design list via the generic upsert (no-op when already bound).
 *
 * T91a：bound list 现在存 design uniqueId（UUID v4），而非节点 id。re-import
 * 后节点 id 会重生成，但 UUID 不会变——绑定关系才稳定。
 * 兼容：调用方传 node id 时自动解析为 uniqueId（不命中 uniqueId 则懒补）。
 */
export function bindBriefToDesign(figma: FigmaAPI, briefId: string, rootFrameId: string): void {
  const graph = figma.graph
  const brief = graph.getNode(briefId)
  if (!isBrief(brief)) return
  const designNode = graph.getNode(rootFrameId)
  if (!designNode) return
  // T91a：节点 id → uniqueId 寻址
  let designUuid = getDesignUniqueId(designNode)
  if (!designUuid) {
    designUuid = generatePluginUniqueId()
    setDesignUniqueId(graph, rootFrameId, designUuid)
  }
  const bound = briefBoundDesignIds(brief)
  if (bound.includes(designUuid)) return
  setBriefMarker(graph, briefId, BRIEF_BINDING_KEY, [...bound, designUuid].join(','))
}

/**
 * Locate one of the four zone cards inside a brief. Addressing reads the zone
 * pluginData marker (rename-proof); the Chinese display name is only a legacy
 * fallback for documents written before zone markers existed.
 */
export function findBriefZone(
  graph: SceneGraph,
  brief: SceneNode,
  zone: BriefZoneId
): SceneNode | undefined {
  let byName: SceneNode | undefined
  const stack = [...brief.childIds]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) break
    const node = graph.getNode(id)
    if (!node) continue
    if (briefMarker(node, BRIEF_ZONE_KEY) === zone) return node
    if (!byName && node.name === BRIEF_ZONE_DISPLAY_NAMES[zone]) byName = node
    stack.push(...node.childIds)
  }
  return byName
}

/** All top-level briefs on the current page, in page order. */
export function listBriefs(figma: FigmaAPI): SceneNode[] {
  const page = figma.graph.getNode(figma.currentPage.id)
  if (!page) return []
  return page.childIds.map((id) => figma.graph.getNode(id)).filter(isBrief)
}

// ── findBrief：显式 briefId > 当前页唯一 brief > 歧义信号 ────────────────────

export interface BriefCandidate {
  briefId: string
  name: string
  boundDesigns: string[]
}

export type BriefResolution =
  | { status: 'ok'; brief: SceneNode }
  | { status: 'none' }
  | { status: 'not-found'; briefId: string }
  | { status: 'ambiguous'; candidates: BriefCandidate[] }

/**
 * Resolve which brief an operation targets. NO silent "first on page"
 * fallback (the source repo's asymmetric兜底 is abolished): with several
 * briefs on the page and no explicit briefId, the caller gets an ambiguity
 * signal and must ask the user instead of guessing.
 */
export function findBrief(figma: FigmaAPI, briefId?: string): BriefResolution {
  const graph = figma.graph
  if (briefId) {
    const node = graph.getNode(briefId)
    return isBrief(node) ? { status: 'ok', brief: node } : { status: 'not-found', briefId }
  }
  const pageBriefs = listBriefs(figma)
  if (pageBriefs.length === 0) return { status: 'none' }
  const [first] = pageBriefs
  if (pageBriefs.length === 1) return { status: 'ok', brief: first }
  return {
    status: 'ambiguous',
    candidates: pageBriefs.map((brief) => ({
      briefId: brief.id,
      name: brief.name,
      boundDesigns: briefBoundDesignIds(brief)
    }))
  }
}

// ── 结构建造 ───────────────────────────────────────────────────────────────

interface TextOptions {
  fontSize?: number
  fontWeight?: number
  color?: { r: number; g: number; b: number }
  lineHeight?: number
  letterSpacing?: number
  opacity?: number
  align?: 'LEFT' | 'CENTER'
  /** Wrap at parent width (fill + height-resize); default hugs content */
  wrap?: boolean
}

function createText(
  figma: FigmaAPI,
  parentId: string,
  name: string,
  characters: string,
  options: TextOptions = {}
): string {
  const graph = figma.graph
  const node = graph.createNode('TEXT', parentId, { name })
  const textProps: Record<string, unknown> = {
    text: characters,
    fontFamily: BRIEF_FONT_FAMILY,
    fontSize: options.fontSize ?? 26,
    fontWeight: options.fontWeight ?? 400,
    textAutoResize: options.wrap ? 'HEIGHT' : 'WIDTH_AND_HEIGHT'
  }
  if (options.wrap) textProps.layoutAlignSelf = 'STRETCH'
  if (options.lineHeight !== undefined) textProps.lineHeight = options.lineHeight
  if (options.letterSpacing !== undefined) textProps.letterSpacing = options.letterSpacing
  if (options.opacity !== undefined) textProps.opacity = options.opacity
  if (options.align) textProps.textAlignHorizontal = options.align
  textProps.fills = [
    {
      type: 'SOLID',
      color: { r: 0.29, g: 0.25, b: 0.13, a: 1, ...options.color },
      opacity: 1,
      visible: true
    }
  ]
  graph.updateNode(node.id, textProps)
  return node.id
}

interface CardOptions {
  bg?: { r: number; g: number; b: number }
  stroke?: { r: number; g: number; b: number }
  gap?: number
  padding?: number
  rounded?: number
  /** Sizing along the PARENT's primary axis */
  primary?: 'FIXED' | 'FILL' | 'HUG'
  /** Sizing along the PARENT's counter axis */
  counter?: 'FIXED' | 'FILL' | 'HUG'
  width?: number
  justify?: 'SPACE_BETWEEN'
}

function createCard(
  figma: FigmaAPI,
  parentId: string,
  name: string,
  options: CardOptions = {}
): string {
  const graph = figma.graph
  const card = graph.createNode('FRAME', parentId, { name })
  const padding = options.padding ?? 26
  const cardProps: Record<string, unknown> = {
    layoutMode: 'VERTICAL',
    itemSpacing: options.gap ?? 13,
    paddingTop: padding,
    paddingBottom: padding,
    paddingLeft: padding,
    paddingRight: padding,
    cornerRadius: options.rounded ?? 22,
    primaryAxisSizing: options.primary ?? 'HUG',
    counterAxisSizing: options.counter ?? 'FILL'
  }
  if (options.width) cardProps.width = options.width
  if (options.justify) cardProps.primaryAxisAlign = options.justify
  cardProps.fills = [
    {
      type: 'SOLID',
      color: { ...(options.bg ?? CARD_BG), a: 1 },
      opacity: 1,
      visible: true
    }
  ]
  cardProps.strokes = options.stroke
    ? [
        {
          color: { ...options.stroke, a: 1 },
          weight: 1,
          opacity: 1,
          visible: true,
          align: 'INSIDE'
        }
      ]
    : []
  graph.updateNode(card.id, cardProps)
  return card.id
}

function createLabelRow(figma: FigmaAPI, parentId: string, label: string, badge: string): void {
  const graph = figma.graph
  const row = graph.createNode('FRAME', parentId, { name: 'LabelRow' })
  graph.updateNode(row.id, {
    layoutMode: 'HORIZONTAL',
    primaryAxisSizing: 'FILL',
    counterAxisSizing: 'HUG',
    primaryAxisAlign: 'SPACE_BETWEEN',
    counterAxisAlign: 'CENTER',
    fills: []
  })
  createText(figma, row.id, 'Label', label, {
    fontSize: 24,
    fontWeight: 700,
    letterSpacing: 1.8,
    color: LABEL_COLOR
  })
  createText(figma, row.id, 'Badge', badge, {
    fontSize: 22,
    opacity: 0.75,
    color: MUTED_COLOR
  })
}

/** A material entry: image slot on top, usage-note caption below. Fixed width so wrapped rows stay uniform. */
function createSlot(figma: FigmaAPI, parentId: string, name: string, caption: string): string {
  const graph = figma.graph
  const slot = graph.createNode('FRAME', parentId, { name })
  graph.updateNode(slot.id, {
    layoutMode: 'VERTICAL',
    itemSpacing: 18,
    counterAxisAlign: 'CENTER',
    primaryAxisSizing: 'HUG',
    counterAxisSizing: 'FIXED',
    width: 180,
    fills: []
  })
  const image = graph.createNode('FRAME', slot.id, { name: BRIEF_IMAGE_SLOT_NAME })
  graph.updateNode(image.id, {
    width: 143,
    height: 143,
    cornerRadius: 22,
    layoutMode: 'HORIZONTAL',
    primaryAxisAlign: 'CENTER',
    counterAxisAlign: 'CENTER',
    fills: [{ type: 'SOLID', color: { ...SLOT_BG, a: 1 }, opacity: 1, visible: true }],
    strokes: [
      {
        color: { ...SLOT_STROKE, a: 1 },
        weight: 1,
        opacity: 1,
        visible: true,
        align: 'INSIDE'
      }
    ]
  })
  createText(figma, slot.id, BRIEF_CAPTION_NAME, caption, {
    fontSize: 22,
    align: 'CENTER',
    color: SUB_COLOR,
    wrap: true
  })
  return slot.id
}

/** Create the brief frame at (x, y) with the full FOUR-zone structure (内容区 / 素材区 / AI结论区 / 关联设计区).
 *
 * Name = `'需求单 ${N}'` where N = number of existing briefs on the page + 1
 * (T79 S1：带序号以支持同页多 brief；id 仍由 graph 分配唯一，name 仅展示）。
 */
export function createBrief(figma: FigmaAPI, x = 0, y = 0): SceneNode {
  const graph = figma.graph
  const existingCount = listBriefs(figma).length
  const brief = graph.createNode('FRAME', figma.currentPage.id, {
    name: `${BRIEF_NAME} ${existingCount + 1}`,
    x,
    y
  })
  // T91a：写 brief 根 uniqueId（跨持久化边界的稳定寻址键，UUID v4）
  setBriefUniqueId(graph, brief.id, generatePluginUniqueId())
  graph.updateNode(brief.id, {
    width: BRIEF_WIDTH,
    layoutMode: 'HORIZONTAL',
    itemSpacing: 36,
    paddingTop: 36,
    paddingBottom: 36,
    paddingLeft: 36,
    paddingRight: 36,
    cornerRadius: 36,
    primaryAxisSizing: 'FIXED',
    counterAxisSizing: 'HUG',
    counterAxisAlign: 'STRETCH',
    fills: [{ type: 'SOLID', color: { ...BRIEF_BG, a: 1 }, opacity: 1, visible: true }],
    effects: [
      {
        type: 'DROP_SHADOW',
        color: { ...SUB_COLOR, a: 0.1 },
        offset: { x: 0, y: 13 },
        radius: 45,
        spread: 0,
        visible: true,
        blendMode: 'NORMAL'
      }
    ]
  })
  setBriefMarker(graph, brief.id, BRIEF_ROLE_KEY, BRIEF_ROLE_VALUE)
  setBriefMarker(graph, brief.id, BRIEF_SCHEMA_VERSION_KEY, BRIEF_SCHEMA_VERSION)

  const main = graph.createNode('FRAME', brief.id, { name: BRIEF_MAIN_NAME })
  graph.updateNode(main.id, {
    layoutMode: 'VERTICAL',
    itemSpacing: 36,
    primaryAxisSizing: 'HUG',
    counterAxisSizing: 'FILL',
    layoutGrow: 1,
    fills: []
  })

  const header = graph.createNode('FRAME', main.id, { name: 'Header' })
  graph.updateNode(header.id, {
    layoutMode: 'VERTICAL',
    itemSpacing: 18,
    primaryAxisSizing: 'HUG',
    counterAxisSizing: 'FILL',
    fills: []
  })
  const titleRow = graph.createNode('FRAME', header.id, { name: 'TitleRow' })
  graph.updateNode(titleRow.id, {
    layoutMode: 'HORIZONTAL',
    itemSpacing: 18,
    counterAxisAlign: 'CENTER',
    primaryAxisSizing: 'FILL',
    counterAxisSizing: 'HUG',
    fills: []
  })
  const accentBar = graph.createNode('RECTANGLE', titleRow.id, { name: 'AccentBar' })
  graph.updateNode(accentBar.id, {
    width: 9,
    height: 49,
    cornerRadius: 4,
    fills: [{ type: 'SOLID', color: { ...ACCENT, a: 1 }, opacity: 1, visible: true }]
  })
  createText(figma, titleRow.id, 'Title', BRIEF_NAME, {
    fontSize: 44,
    fontWeight: 700,
    color: TITLE_COLOR
  })
  createText(figma, header.id, 'Subtitle', BRIEF_TEXTS.subtitle, {
    lineHeight: 40,
    color: SUB_COLOR,
    wrap: true
  })

  // ── 内容区 ──
  const contentCard = createCard(figma, main.id, BRIEF_ZONE_CONTENT_NAME, {
    stroke: CARD_STROKE,
    gap: 26
  })
  setBriefMarker(graph, contentCard, BRIEF_ZONE_KEY, BRIEF_ZONE_CONTENT)
  createLabelRow(figma, contentCard, BRIEF_ZONE_CONTENT_NAME, BRIEF_TEXTS.contentZoneBadge)
  const contentInput = createCard(figma, contentCard, BRIEF_CONTENT_INPUT_NAME, {
    bg: INPUT_BG,
    stroke: INPUT_STROKE,
    rounded: 18
  })
  createText(figma, contentInput, BRIEF_CONTENT_EXAMPLE_NAME, BRIEF_TEXTS.contentExample, {
    lineHeight: 44,
    color: EXAMPLE_COLOR,
    wrap: true
  })
  createText(figma, contentCard, 'FieldsHint', BRIEF_TEXTS.fieldsHint, {
    fontSize: 24,
    color: MUTED_COLOR,
    wrap: true
  })

  // ── 素材区 ──
  const materialCard = createCard(figma, main.id, BRIEF_ZONE_MATERIALS_NAME, {
    stroke: CARD_STROKE,
    gap: 26
  })
  setBriefMarker(graph, materialCard, BRIEF_ZONE_KEY, BRIEF_ZONE_MATERIALS)
  createLabelRow(figma, materialCard, BRIEF_ZONE_MATERIALS_NAME, BRIEF_TEXTS.materialsZoneBadge)
  const grid = graph.createNode('FRAME', materialCard, { name: BRIEF_MATERIAL_GRID_NAME })
  graph.updateNode(grid.id, {
    layoutMode: 'HORIZONTAL',
    layoutWrap: 'WRAP',
    itemSpacing: 26,
    counterAxisSpacing: 26,
    primaryAxisSizing: 'FILL',
    counterAxisSizing: 'HUG',
    fills: []
  })
  createText(figma, materialCard, BRIEF_EMPTY_HINT_NAME, BRIEF_TEXTS.materialsEmptyHint, {
    fontSize: 22,
    opacity: 0.75,
    color: MUTED_COLOR,
    wrap: true
  })
  createText(figma, materialCard, 'MaterialNote', BRIEF_TEXTS.materialNote, {
    fontSize: 24,
    color: MUTED_COLOR,
    wrap: true
  })

  // ── 关联设计区（四区改造新建）──
  const designsCard = createCard(figma, main.id, BRIEF_ZONE_DESIGNS_NAME, {
    stroke: CARD_STROKE,
    gap: 26
  })
  setBriefMarker(graph, designsCard, BRIEF_ZONE_KEY, BRIEF_ZONE_DESIGNS)
  createLabelRow(figma, designsCard, BRIEF_ZONE_DESIGNS_NAME, BRIEF_TEXTS.designsZoneBadge)
  const designList = graph.createNode('FRAME', designsCard, { name: BRIEF_DESIGN_LIST_NAME })
  graph.updateNode(designList.id, {
    layoutMode: 'VERTICAL',
    itemSpacing: 13,
    primaryAxisSizing: 'HUG',
    counterAxisSizing: 'FILL',
    fills: []
  })
  createText(figma, designsCard, BRIEF_EMPTY_HINT_NAME, BRIEF_TEXTS.designsEmptyHint, {
    fontSize: 22,
    opacity: 0.75,
    color: MUTED_COLOR,
    wrap: true
  })

  // ── AI结论区 ──
  const aiCard = createCard(figma, brief.id, BRIEF_ZONE_CONCLUSIONS_NAME, {
    bg: AI_ZONE_BG,
    width: 384,
    gap: 18,
    primary: 'FILL',
    counter: 'FIXED',
    justify: 'SPACE_BETWEEN'
  })
  setBriefMarker(graph, aiCard, BRIEF_ZONE_KEY, BRIEF_ZONE_CONCLUSIONS)
  const aiTop = graph.createNode('FRAME', aiCard, { name: 'Top' })
  graph.updateNode(aiTop.id, {
    layoutMode: 'VERTICAL',
    itemSpacing: 18,
    primaryAxisSizing: 'HUG',
    counterAxisSizing: 'FILL',
    fills: []
  })
  createText(figma, aiTop.id, 'Label', BRIEF_ZONE_CONCLUSIONS_NAME, {
    fontSize: 24,
    fontWeight: 700,
    letterSpacing: 1.8,
    color: SUB_COLOR
  })
  createText(figma, aiTop.id, 'Hint', BRIEF_TEXTS.conclusionsHint, {
    lineHeight: 40,
    color: TITLE_COLOR,
    wrap: true
  })
  const conclusions = graph.createNode('FRAME', aiTop.id, { name: BRIEF_CONCLUSIONS_NAME })
  graph.updateNode(conclusions.id, {
    layoutMode: 'VERTICAL',
    itemSpacing: 13,
    primaryAxisSizing: 'HUG',
    counterAxisSizing: 'FILL',
    fills: []
  })
  const emptyState = graph.createNode('FRAME', aiCard, { name: BRIEF_EMPTY_STATE_NAME })
  graph.updateNode(emptyState.id, {
    layoutMode: 'VERTICAL',
    itemSpacing: 18,
    counterAxisAlign: 'CENTER',
    primaryAxisSizing: 'HUG',
    counterAxisSizing: 'FILL',
    fills: []
  })
  const divider = graph.createNode('RECTANGLE', emptyState.id, { name: 'Divider' })
  graph.updateNode(divider.id, {
    width: 107,
    height: 2,
    opacity: 0.4,
    fills: [{ type: 'SOLID', color: { ...ACCENT, a: 1 }, opacity: 1, visible: true }]
  })
  createText(figma, emptyState.id, 'Status', BRIEF_TEXTS.conclusionsEmptyStatus, {
    fontSize: 22,
    opacity: 0.75,
    color: SUB_COLOR
  })

  return brief
}

// ── AI 结论区：append-only，按设计归组（存储不分区）─────────────────────────

function findConclusionGroupId(
  graph: SceneGraph,
  conclusionsId: string,
  design: { id: string; name: string }
): string | undefined {
  let byTitle: string | undefined
  for (const id of graph.getNode(conclusionsId)?.childIds ?? []) {
    const node = graph.getNode(id)
    if (node?.name !== BRIEF_CONCLUSION_GROUP_NAME) continue
    if (briefMarker(node, BRIEF_CONCLUSION_GROUP_DESIGN_KEY) === design.id) return id
    const titleId = node.childIds.find(
      (childId) => graph.getNode(childId)?.name === BRIEF_GROUP_TITLE_NAME
    )
    if (!byTitle && titleId && graph.getNode(titleId)?.text === design.name) byTitle = id
  }
  return byTitle
}

/**
 * Append one confirmed conclusion line into the brief's AI zone. When `design`
 * is given, the line lands in that design's own group (created on first use,
 * id-authoritative via the group designId marker) so one brief serving
 * several designs keeps per-design attribution; storage stays flat (groups,
 * not separate lists). Without `design` the line appends ungrouped.
 */
export function appendToBriefAIZone(
  figma: FigmaAPI,
  briefId: string,
  text: string,
  design?: { id: string; name: string }
): boolean {
  const graph = figma.graph
  const brief = graph.getNode(briefId)
  if (!isBrief(brief)) return false
  const aiCard = findBriefZone(graph, brief, BRIEF_ZONE_CONCLUSIONS)
  if (!aiCard) return false

  const topId = aiCard.childIds.find((id) => graph.getNode(id)?.name === 'Top')
  const conclusionsId = topId
    ? graph
        .getNode(topId)
        ?.childIds.find((id) => graph.getNode(id)?.name === BRIEF_CONCLUSIONS_NAME)
    : undefined
  if (!conclusionsId) return false

  if (design) {
    let groupId = findConclusionGroupId(graph, conclusionsId, design)
    if (!groupId) {
      const group = graph.createNode('FRAME', conclusionsId, {
        name: BRIEF_CONCLUSION_GROUP_NAME
      })
      graph.updateNode(group.id, {
        layoutMode: 'VERTICAL',
        itemSpacing: 8,
        primaryAxisSizing: 'HUG',
        counterAxisSizing: 'FILL',
        fills: []
      })
      setBriefMarker(graph, group.id, BRIEF_CONCLUSION_GROUP_DESIGN_KEY, design.id)
      createText(figma, group.id, BRIEF_GROUP_TITLE_NAME, design.name, {
        fontSize: 24,
        fontWeight: 700,
        color: SUB_COLOR
      })
      groupId = group.id
    }
    createText(figma, groupId, BRIEF_CONCLUSION_LINE_NAME, `· ${text}`, {
      fontSize: 24,
      color: TITLE_COLOR,
      wrap: true
    })
  } else {
    createText(figma, conclusionsId, BRIEF_CONCLUSION_LINE_NAME, `· ${text}`, {
      fontSize: 24,
      color: TITLE_COLOR,
      wrap: true
    })
  }
  const emptyStateId = aiCard.childIds.find(
    (id) => graph.getNode(id)?.name === BRIEF_EMPTY_STATE_NAME
  )
  if (emptyStateId) graph.updateNode(emptyStateId, { visible: false })
  return true
}

// ── 素材区条目 ─────────────────────────────────────────────────────────────

/**
 * Add a real material entry (image + caption) to the brief's MaterialGrid and
 * hide the zone's EmptyHint row. Accepts raw bytes (figma.createImage) or an
 * already-registered image hash. Returns the entry id AND the imageNodeId of
 * the entry's 图片位 slot (look reads the image straight off that node).
 */
export function addBriefMaterialEntry(
  figma: FigmaAPI,
  briefId: string,
  image: Uint8Array | { hash: string },
  caption: string
): { entryId: string; imageNodeId: string } | { error: string } {
  const graph = figma.graph
  const brief = graph.getNode(briefId)
  if (!isBrief(brief)) return { error: 'Brief not found' }
  const materialCard = findBriefZone(graph, brief, BRIEF_ZONE_MATERIALS)
  const gridId = materialCard?.childIds.find(
    (id) => graph.getNode(id)?.name === BRIEF_MATERIAL_GRID_NAME
  )
  if (!materialCard || !gridId) return { error: 'Brief material grid not found' }

  // Legacy briefs predate the wrapped grid — upgrade on first entry add so
  // entries wrap instead of squeezing into one row.
  const grid = graph.getNode(gridId)
  if (grid && grid.layoutWrap !== 'WRAP') {
    graph.updateNode(gridId, { layoutWrap: 'WRAP', counterAxisSpacing: grid.itemSpacing })
  }

  const hash = image instanceof Uint8Array ? figma.createImage(image).hash : image.hash
  const entryId = createSlot(figma, gridId, BRIEF_ENTRY_NAME, caption)

  const emptyHintId = materialCard.childIds.find(
    (id) => graph.getNode(id)?.name === BRIEF_EMPTY_HINT_NAME
  )
  if (emptyHintId) graph.updateNode(emptyHintId, { visible: false })

  const imageId = graph
    .getNode(entryId)
    ?.childIds.find((id) => graph.getNode(id)?.name === BRIEF_IMAGE_SLOT_NAME)
  if (!imageId) return { error: 'Brief entry image slot missing' }
  const imageFill: Fill = {
    type: 'IMAGE',
    imageHash: hash,
    imageScaleMode: 'FILL',
    color: TRANSPARENT,
    opacity: 1,
    visible: true
  }
  graph.updateNode(imageId, { fills: [imageFill] })
  return { entryId, imageNodeId: imageId }
}

// ── 关联设计区条目（id 权威 + 读穿投影）─────────────────────────────────────

/** Entry rows in the designs zone, in list order (marker-first, name fallback). */
export function briefDesignEntryIds(graph: SceneGraph, designListId: string): string[] {
  return (graph.getNode(designListId)?.childIds ?? []).filter((id) => {
    const node = graph.getNode(id)
    if (!node) return false
    return briefMarker(node, BRIEF_DESIGN_ENTRY_KEY) !== '' || node.name === BRIEF_DESIGN_ENTRY_NAME
  })
}

/** The design root id an entry row points at ('' for legacy rows without the marker). */
export function briefDesignEntryDesignId(graph: SceneGraph, entryId: string): string {
  const node = graph.getNode(entryId)
  return node ? briefMarker(node, BRIEF_DESIGN_ENTRY_KEY) : ''
}

function findDesignsListId(graph: SceneGraph, brief: SceneNode): string | undefined {
  const zone = findBriefZone(graph, brief, BRIEF_ZONE_DESIGNS)
  return zone?.childIds.find((id) => graph.getNode(id)?.name === BRIEF_DESIGN_LIST_NAME)
}

/**
 * Register one design root in the brief's designs zone (id-authoritative
 * entry row + name projection text; mode/type projections are read through
 * at view time). Idempotent per designId. T53 setup_design calls this after
 * stamping the design identity tuple.
 */
export function registerBriefDesignEntry(
  figma: FigmaAPI,
  briefId: string,
  designId: string
): { entryId: string; created: boolean } | { error: string } {
  const graph = figma.graph
  const brief = graph.getNode(briefId)
  if (!isBrief(brief)) return { error: 'Brief not found' }
  const listId = findDesignsListId(graph, brief)
  const zone = findBriefZone(graph, brief, BRIEF_ZONE_DESIGNS)
  if (!listId || !zone) return { error: 'Brief designs zone not found' }

  const existing = briefDesignEntryIds(graph, listId).find(
    (entryId) => briefDesignEntryDesignId(graph, entryId) === designId
  )
  if (existing) return { entryId: existing, created: false }

  const designName = graph.getNode(designId)?.name ?? ''
  const entry = graph.createNode('FRAME', listId, { name: BRIEF_DESIGN_ENTRY_NAME })
  graph.updateNode(entry.id, {
    layoutMode: 'VERTICAL',
    itemSpacing: 8,
    primaryAxisSizing: 'HUG',
    counterAxisSizing: 'FILL',
    fills: []
  })
  setBriefMarker(graph, entry.id, BRIEF_DESIGN_ENTRY_KEY, designId)
  createText(figma, entry.id, '设计名', designName, {
    fontSize: 24,
    fontWeight: 700,
    color: SUB_COLOR
  })

  const emptyHintId = zone.childIds.find((id) => graph.getNode(id)?.name === BRIEF_EMPTY_HINT_NAME)
  if (emptyHintId) graph.updateNode(emptyHintId, { visible: false })
  return { entryId: entry.id, created: true }
}

/**
 * Physical backfill half of the lazy reconciliation (S3 §3 读时惰性调和):
 * scan the current page for design roots whose design→brief pointer
 * (DESIGN_BRIEF_KEY, written by T53) targets this brief and register any
 * missing entries. Mutating — call from mutating paths only; the read side
 * surfaces the same designs with `registered: false` instead.
 */
export function syncBriefDesignEntries(figma: FigmaAPI, briefId: string): string[] {
  const graph = figma.graph
  const brief = graph.getNode(briefId)
  if (!isBrief(brief)) return []
  const page = graph.getNode(figma.currentPage.id)
  if (!page) return []
  const added: string[] = []
  for (const childId of page.childIds) {
    const node = graph.getNode(childId)
    if (node?.type !== 'FRAME') continue
    if (briefMarker(node, DESIGN_BRIEF_KEY) !== briefId) continue
    const result = registerBriefDesignEntry(figma, briefId, childId)
    if ('entryId' in result && result.created) added.push(childId)
  }
  return added
}

// T91b：newIntent pluginData 读写实现见文件头部 169–233 段；此处不重复定义以遵守单源纪律。
