/**
 * prepare_hero_scaffold core（T57，S3 §7/§8/§9）：标题前置克隆源 + 几何记录。
 *
 * 移植自 open-pencil 仓 feature/agent-backend @ 5d38aa4e
 * tools/marketing/prepare-hero-scaffold.ts（221 行）+ hero-slot.ts（54 行），
 * 契约修订：
 * - 克隆源从「骨架期 HeroContent 扫描」改为显式 source_node_id（标题前置
 *   版式，15 册 D.1）——骨架未存在也可调用；root_id 仅做结构校验
 *   （FRAME + layoutMode≠NONE），不依赖 T53 的 marketing-root 标记。
 * - 定位走共享 findPlacementPosition（页面 bounds 右侧 +100、y 跟随），
 *   取代旧 root.x + root.width + 100 内联逻辑；重调不再改位置（页面级
 *   bounds 会把 scaffold 自身算进去，重定位会逐次右漂）。
 * - 几何参数 underlap_px / transition_zone_px 落 scaffold pluginData 几何
 *   记录（namespace 复用 BRIEF_PLUGIN_NAMESPACE，key 'hero-geometry'），
 *   下游 compose_backdrop（T58）一律读记录不收散参；缺记录
 *   readHeroGeometry 返回 null（不静默默认，T58 侧转结构化报错）。
 * - 写入校验钳制：underlap 缺省 100、须有限 0..1000；transition 缺省 100、
 *   须有限 ≥0；transition > underlap → 钳到 underlap 且信封 clamped: true；
 *   非有限/负值 → { error, message } 结构化返回，不抛异常。
 * - 旧 buildNote 指令链（generate_image→compose_backdrop）删除不移植，
 *   信封 note 只带事实（克隆源 id / 克隆子节点数 / 是否钳制）。
 *
 * 保留旧语义：页面级兄弟帧按显示名 upsert、layoutMode NONE + clipsContent +
 * 白底、cloneTree layoutPositioning ABSOLUTE + x/y 原样、重调保留既有
 * IMAGE fill（否则重置白底）。
 */

import type { Fill, SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import type { Size, Vector } from '@open-pencil/scene-graph/primitives'

import type { FigmaAPI } from '#core/figma-api'
import { getSharedPluginData, setSharedPluginData } from '#core/figma-api/plugin-data'
import { findPlacementPosition } from '#core/tools/fork/placement'

import { BRIEF_PLUGIN_NAMESPACE } from './brief'

/**
 * 画布文案外置（zh-cn，同 BRIEF_TEXTS/SETUP_TEXTS 纪律；暂放本文件——
 * texts.ts 本波次归 T53 独占，避免并行撞车）。
 */
export const HERO_TEXTS = {
  /** scaffold 显示名（幂等 upsert 按名寻址） */
  scaffoldName: 'Hero生成参考',

  missingRootId: '请传根 frame 的节点 id（root_id）。',
  missingSourceId: '请传标题版式的节点 id（source_node_id）。',
  invalidUnderlap: (value: number) =>
    `underlap_px 必须是 0 到 1000 之间的有限数值（收到 ${value}）——检查参数是否有误。`,
  invalidTransitionZone: (value: number) =>
    `transition_zone_px 必须是不小于 0 的有限数值（收到 ${value}）——检查参数是否有误。`,
  rootNotFound: (rootId: string) => `找不到根 frame「${rootId}」。`,
  rootNotFrame: (rootId: string, type: string) =>
    `节点「${rootId}」是 ${type}，不是 FRAME——请传长图画布的根 frame。`,
  rootNotAutoLayout:
    '根 frame 没有自动布局（layoutMode 为 NONE）——请先给根 frame 设置自动布局，再准备 Hero 参考。',
  rootWithoutPage: '根 frame 不在任何页面上——Hero 参考需要作为根的页面级兄弟节点创建。',
  sourceNotFound: (sourceId: string) =>
    `找不到标题版式节点「${sourceId}」——请先渲染标题版式，再调用本工具。`,
  sourceNotFrame: (sourceId: string, type: string) =>
    `标题版式节点「${sourceId}」是 ${type}，不是 FRAME——请传标题版式 frame。`,
  sourceEmpty: '标题版式没有任何子节点——请先在版式中排布标题文案，再调用本工具。'
} as const

// ── 几何参数契约 ─────────────────────────────────────────────────────────────

export const DEFAULT_UNDERLAP_PX = 100
export const DEFAULT_TRANSITION_ZONE_PX = 100
export const MAX_UNDERLAP_PX = 1000

/** scaffold pluginData 几何记录键（namespace 复用 BRIEF_PLUGIN_NAMESPACE；T58 硬依赖） */
export const HERO_GEOMETRY_KEY = 'hero-geometry'

/** 几何记录值（JSON 落盘）：width/height = scaffold 全尺寸，T58 据此推 slot = height − underlapPx */
export interface HeroGeometry {
  width: number
  height: number
  underlapPx: number
  transitionZonePx: number
}

// ── 信封 ─────────────────────────────────────────────────────────────────────

export type PrepareHeroScaffoldErrorCode =
  | 'invalid_params'
  | 'root_not_found'
  | 'root_not_frame'
  | 'root_not_auto_layout'
  | 'root_without_page'
  | 'source_not_found'
  | 'source_not_frame'
  | 'source_empty'

export interface PrepareHeroScaffoldError {
  error: PrepareHeroScaffoldErrorCode
  /** 用户语言化说明（zh-cn，HERO_TEXTS 外置） */
  message: string
}

export interface PrepareHeroScaffoldSuccess {
  scaffold_id: string
  width: number
  height: number
  underlap_px: number
  transition_zone_px: number
  /** transition > underlap 时已钳到 underlap */
  clamped: boolean
  cloned_children: number
  /** 仅事实（克隆源 id / 克隆数 / 钳制标记），无后续工具指令链 */
  note: string
}

export type PrepareHeroScaffoldResult = PrepareHeroScaffoldSuccess | PrepareHeroScaffoldError

export interface PrepareHeroScaffoldArgs {
  rootId: string
  sourceNodeId: string
  underlapPx?: number
  transitionZonePx?: number
}

// ── 几何记录读写 ─────────────────────────────────────────────────────────────

function writeHeroGeometry(graph: SceneGraph, nodeId: string, geometry: HeroGeometry): void {
  const node = graph.getNode(nodeId)
  if (!node) return
  setSharedPluginData(
    graph,
    node,
    BRIEF_PLUGIN_NAMESPACE,
    HERO_GEOMETRY_KEY,
    JSON.stringify(geometry)
  )
}

/**
 * 读 scaffold 的几何记录（T58 消费口）。缺记录或记录畸形返回 null——
 * 不静默默认（跳步 = 显式失败，由调用侧转结构化报错引导回 scaffold）。
 * 按 id 重读节点，防调用侧持 stale 快照。
 */
export function readHeroGeometry(graph: SceneGraph, node: SceneNode): HeroGeometry | null {
  const fresh = graph.getNode(node.id)
  if (!fresh) return null
  const raw = getSharedPluginData(fresh, BRIEF_PLUGIN_NAMESPACE, HERO_GEOMETRY_KEY)
  if (raw === '') return null
  try {
    const parsed: Partial<HeroGeometry> = JSON.parse(raw)
    const { width, height, underlapPx, transitionZonePx } = parsed
    if (typeof width !== 'number' || !Number.isFinite(width)) return null
    if (typeof height !== 'number' || !Number.isFinite(height)) return null
    if (typeof underlapPx !== 'number' || !Number.isFinite(underlapPx)) return null
    if (typeof transitionZonePx !== 'number' || !Number.isFinite(transitionZonePx)) return null
    return { width, height, underlapPx, transitionZonePx }
  } catch {
    return null
  }
}

// ── 结构校验（hero-slot.ts 移植改名的轻量化版本）────────────────────────────

function resolveRootFrame(
  graph: SceneGraph,
  rootId: string
): { root: SceneNode } | PrepareHeroScaffoldError {
  const root = graph.getNode(rootId)
  if (!root) return { error: 'root_not_found', message: HERO_TEXTS.rootNotFound(rootId) }
  if (root.type !== 'FRAME') {
    return { error: 'root_not_frame', message: HERO_TEXTS.rootNotFrame(rootId, root.type) }
  }
  if (root.layoutMode === 'NONE') {
    return { error: 'root_not_auto_layout', message: HERO_TEXTS.rootNotAutoLayout }
  }
  return { root }
}

function resolveSourceFrame(
  graph: SceneGraph,
  sourceNodeId: string
): { source: SceneNode } | PrepareHeroScaffoldError {
  const source = graph.getNode(sourceNodeId)
  if (!source) {
    return { error: 'source_not_found', message: HERO_TEXTS.sourceNotFound(sourceNodeId) }
  }
  if (source.type !== 'FRAME') {
    return {
      error: 'source_not_frame',
      message: HERO_TEXTS.sourceNotFrame(sourceNodeId, source.type)
    }
  }
  if (source.childIds.length === 0) {
    return { error: 'source_empty', message: HERO_TEXTS.sourceEmpty }
  }
  return { source }
}

// ── 建造 ─────────────────────────────────────────────────────────────────────

const WHITE_SOLID_FILL: Fill = {
  type: 'SOLID',
  color: { r: 1, g: 1, b: 1, a: 1 },
  opacity: 1,
  visible: true
}

function whiteFills(): Fill[] {
  return [{ ...WHITE_SOLID_FILL, color: { ...WHITE_SOLID_FILL.color } }]
}

/**
 * 页面级兄弟帧按显示名 upsert：新建 = 白底 + layoutMode NONE + clipsContent，
 * 落在 findPlacementPosition 读出的位置；重调 = 只更新尺寸（位置不动——
 * findPlacementPosition 读整页 bounds，重定位会把 scaffold 自身算入而逐次
 * 右漂），既有 IMAGE fill 保留，否则重置白底。
 */
function upsertScaffold(
  graph: SceneGraph,
  page: SceneNode,
  size: Size,
  position: Vector
): SceneNode {
  const existing = page.childIds
    .map((id) => graph.getNode(id))
    .find((node) => node?.name === HERO_TEXTS.scaffoldName)
  if (existing) {
    const hasImageFill = existing.fills.some((fill) => fill.type === 'IMAGE')
    graph.updateNode(existing.id, {
      width: size.width,
      height: size.height,
      ...(hasImageFill ? {} : { fills: whiteFills() })
    })
    return existing
  }
  return graph.createNode('FRAME', page.id, {
    name: HERO_TEXTS.scaffoldName,
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    layoutMode: 'NONE',
    clipsContent: true,
    fills: whiteFills()
  })
}

/**
 * 清空 scaffold children → 逐 source child cloneTree（x/y 原样——标题版式
 * 占据 scaffold 顶部 source.height 区间，无需坐标换算；layoutPositioning
 * 强制 ABSOLUTE，scaffold 的 layoutMode NONE 不会回流它们）。
 */
function recloneChildren(graph: SceneGraph, source: SceneNode, scaffold: SceneNode): number {
  // slice 拷一份再删：deleteNode 会替换父节点 childIds，持旧数组引用迭代不丢项
  for (const childId of scaffold.childIds.slice()) {
    graph.deleteNode(childId)
  }
  let cloned = 0
  for (const childId of source.childIds) {
    const clone = graph.cloneTree(childId, scaffold.id, { layoutPositioning: 'ABSOLUTE' })
    if (clone) cloned++
  }
  return cloned
}

/** 事实 note：克隆源 id / 克隆子节点数 / 钳制标记（旧指令链 buildNote 不移植） */
function buildFactsNote(input: {
  scaffoldId: string
  sourceNodeId: string
  cloned: number
  clamped: boolean
  underlapPx: number
}): string {
  const base = `Scaffold "${HERO_TEXTS.scaffoldName}" (${input.scaffoldId}) ready: cloned ${input.cloned} child node(s) verbatim from source "${input.sourceNodeId}".`
  return input.clamped
    ? `${base} transition_zone_px was clamped to underlap_px (${input.underlapPx}px).`
    : base
}

/**
 * 准备 Hero 生成参考 scaffold：校验（参数 → root → source）→ 定位 →
 * upsert → 重克隆 → 几何记录落盘。克隆源是显式传入的标题前置版式，
 * 不要求骨架/HeroContent 存在。
 */
export function prepareHeroScaffold(
  figma: FigmaAPI,
  args: PrepareHeroScaffoldArgs
): PrepareHeroScaffoldResult {
  const graph = figma.graph

  if (args.rootId === '') return { error: 'invalid_params', message: HERO_TEXTS.missingRootId }
  if (args.sourceNodeId === '') {
    return { error: 'invalid_params', message: HERO_TEXTS.missingSourceId }
  }
  const underlapPx = args.underlapPx ?? DEFAULT_UNDERLAP_PX
  if (!Number.isFinite(underlapPx) || underlapPx < 0 || underlapPx > MAX_UNDERLAP_PX) {
    return { error: 'invalid_params', message: HERO_TEXTS.invalidUnderlap(underlapPx) }
  }
  const requestedTransitionZonePx = args.transitionZonePx ?? DEFAULT_TRANSITION_ZONE_PX
  if (!Number.isFinite(requestedTransitionZonePx) || requestedTransitionZonePx < 0) {
    return {
      error: 'invalid_params',
      message: HERO_TEXTS.invalidTransitionZone(requestedTransitionZonePx)
    }
  }

  const rootResult = resolveRootFrame(graph, args.rootId)
  if ('error' in rootResult) return rootResult
  const pageId = rootResult.root.parentId
  const page = pageId ? graph.getNode(pageId) : undefined
  if (!page) return { error: 'root_without_page', message: HERO_TEXTS.rootWithoutPage }

  const sourceResult = resolveSourceFrame(graph, args.sourceNodeId)
  if ('error' in sourceResult) return sourceResult
  const source = sourceResult.source

  // 写入钳制：transition > underlap → 钳到 underlap（信封带 clamped: true）
  const clamped = requestedTransitionZonePx > underlapPx
  const transitionZonePx = clamped ? underlapPx : requestedTransitionZonePx

  const size: Size = { width: source.width, height: source.height + underlapPx }
  // 先读放置位再建 frame——新节点自身不进页面 bounds（image-gen/apply.ts 同序先例）
  const position = findPlacementPosition(figma, size)

  const scaffold = upsertScaffold(graph, page, size, position)
  const cloned = recloneChildren(graph, source, scaffold)

  const geometry: HeroGeometry = {
    width: size.width,
    height: size.height,
    underlapPx,
    transitionZonePx
  }
  writeHeroGeometry(graph, scaffold.id, geometry)

  return {
    scaffold_id: scaffold.id,
    width: size.width,
    height: size.height,
    underlap_px: underlapPx,
    transition_zone_px: transitionZonePx,
    clamped,
    cloned_children: cloned,
    note: buildFactsNote({
      scaffoldId: scaffold.id,
      sourceNodeId: source.id,
      cloned,
      clamped,
      underlapPx
    })
  }
}
