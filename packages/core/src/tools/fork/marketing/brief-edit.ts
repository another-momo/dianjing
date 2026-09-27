/**
 * Brief panel read/write primitives (T52, S3 §3) — rebuild/v2 four-zone port.
 *
 * The canvas node tree stays the single source of truth; the panel rebuilds
 * its view via readBrief on every open. Zones are addressed by their
 * pluginData zone marker (findBriefZone), inner rows by structural name —
 * same convention as appendToBriefAIZone. Structurally broken briefs (zones
 * deleted, or so old they carry neither marker nor legacy name) read as null
 * instead of attempting repair.
 *
 * Lazy reconciliation is VIEW-ONLY here (read paths must not mutate — the
 * read_brief tool is mutates:false): entries pointing at deleted designs are
 * annotated with 「（已删除）」 in the view while the canvas row is kept
 * untouched (保痕 tombstone, v7 删除边界态). 2026-09-27 帧无身份：mode 投影
 * 与 design→brief 反向指针补显（registered: false）已退役——设计身份 = 页本身，
 * 规制可见性由确认门 UI + 状态行承担。
 */

import type { SceneGraph } from '@open-pencil/scene-graph'

import type { FigmaAPI } from '#core/figma-api'
import { getSharedPluginData } from '#core/figma-api/plugin-data'

import {
  BRIEF_CONCLUSION_GROUP_DESIGN_KEY,
  BRIEF_CONCLUSION_GROUP_NAME,
  BRIEF_CONCLUSIONS_NAME,
  BRIEF_ENTRY_NAME,
  BRIEF_GROUP_TITLE_NAME,
  BRIEF_PLUGIN_NAMESPACE,
  BRIEF_ZONE_CONCLUSIONS,
  BRIEF_ZONE_CONTENT,
  BRIEF_ZONE_DESIGNS,
  BRIEF_ZONE_MATERIALS,
  briefDesignEntryDesignId,
  briefDesignEntryIds,
  findBrief,
  findBriefZone,
  getBriefUniqueId,
  getDesignUniqueId,
  isBrief
} from './brief'
import { BRIEF_TEXTS } from './texts'

const BRIEF_CONTENT_INPUT_NAME = 'ContentInput'
const BRIEF_CONTENT_EXAMPLE_NAME = 'ContentExample'
const BRIEF_MATERIAL_GRID_NAME = 'MaterialGrid'
const BRIEF_DESIGN_LIST_NAME = 'DesignList'
const BRIEF_IMAGE_SLOT_NAME = '图片位'
const BRIEF_CAPTION_NAME = 'Caption'
const CONCLUSION_BULLET_PREFIX = '· '

export interface BriefMaterialView {
  entryId: string
  caption: string
  imageHash: string | null
  /** Node id of the entry's 图片位 image slot — pass to look to view the image */
  imageNodeId: string | null
}

/** One conclusion line, in storage order, with per-design attribution (S1 §5 读取侧过滤) */
export interface BriefConclusionView {
  /** Line text without the leading canvas bullet */
  text: string
  /** Owning design root id (group marker); null for ungrouped legacy lines */
  designId: string | null
  /** Owning design name (group title projection); null for ungrouped lines */
  designName: string | null
}

/** One designs-zone row: id authoritative, name read from the live design root.
 *  2026-09-27 帧无身份：mode 投影字段已裁——规制可见性由确认门 UI + 状态行承担；
 *  design→brief 反向指针补显（registered: false）随指针写源退役，视图只出
 *  关联设计区已登记条目。 */
export interface BriefDesignEntryView {
  entryId: string | null
  designId: string
  /**
   * T91a：design 的稳定唯一标识符（UUID v4）。跨 .fig 序列化、re-import 仍
   * 保留；re-import 后 designId 会变（`generateId()` 重生成）但 uniqueId 不变。
   * 用作跨持久化边界的寻址键（写绑 / 读绑都走它）。
   */
  uniqueId: string
  /** Live design name; dead designs keep the entry's last projected text + 「（已删除）」 */
  name: string
  /** Tombstone: the design root no longer exists — the entry row is kept, not removed */
  deleted: boolean
}

/** One-shot view model for the brief panel */
export interface BriefView {
  briefId: string
  /**
   * T91a：brief 自身的稳定唯一标识符（UUID v4）。re-import 后 briefId 会变
   * 但 uniqueId 不变；agent / 写绑都走它。
   */
  uniqueId: string
  /** ContentExample text */
  content: string
  materials: BriefMaterialView[]
  conclusions: BriefConclusionView[]
  /**
   * T91a：合并了「brief.bound-designs 权威绑定」+「设计→brief 反向绑定但
   * 缺条目」两个 view——agent 不再需要区分 `boundDesigns` vs `designs`。
   * 每条带 `uniqueId` 寻址键 + `registered` 标志。
   */
  designs: BriefDesignEntryView[]
}

function findChildId(graph: SceneGraph, parentId: string, name: string): string | undefined {
  return graph.getNode(parentId)?.childIds.find((id) => graph.getNode(id)?.name === name)
}

function findContentTextId(graph: SceneGraph, briefId: string): string | undefined {
  const brief = graph.getNode(briefId)
  if (!brief) return undefined
  const contentZone = findBriefZone(graph, brief, BRIEF_ZONE_CONTENT)
  const contentInputId = contentZone
    ? findChildId(graph, contentZone.id, BRIEF_CONTENT_INPUT_NAME)
    : undefined
  return contentInputId ? findChildId(graph, contentInputId, BRIEF_CONTENT_EXAMPLE_NAME) : undefined
}

function findMaterialGridId(graph: SceneGraph, briefId: string): string | undefined {
  const brief = graph.getNode(briefId)
  if (!brief) return undefined
  const materialZone = findBriefZone(graph, brief, BRIEF_ZONE_MATERIALS)
  return materialZone ? findChildId(graph, materialZone.id, BRIEF_MATERIAL_GRID_NAME) : undefined
}

function findDesignListId(graph: SceneGraph, briefId: string): string | undefined {
  const brief = graph.getNode(briefId)
  if (!brief) return undefined
  const designsZone = findBriefZone(graph, brief, BRIEF_ZONE_DESIGNS)
  return designsZone ? findChildId(graph, designsZone.id, BRIEF_DESIGN_LIST_NAME) : undefined
}

function findConclusionsId(graph: SceneGraph, briefId: string): string | undefined {
  const brief = graph.getNode(briefId)
  if (!brief) return undefined
  const conclusionsZone = findBriefZone(graph, brief, BRIEF_ZONE_CONCLUSIONS)
  const topId = conclusionsZone ? findChildId(graph, conclusionsZone.id, 'Top') : undefined
  return topId ? findChildId(graph, topId, BRIEF_CONCLUSIONS_NAME) : undefined
}

function readMaterials(graph: SceneGraph, gridId: string): BriefMaterialView[] {
  const materials: BriefMaterialView[] = []
  for (const entryId of graph.getNode(gridId)?.childIds ?? []) {
    const entry = graph.getNode(entryId)
    if (entry?.name !== BRIEF_ENTRY_NAME) continue
    const imageId = findChildId(graph, entryId, BRIEF_IMAGE_SLOT_NAME)
    const imageFill = imageId ? graph.getNode(imageId)?.fills[0] : undefined
    const captionId = findChildId(graph, entryId, BRIEF_CAPTION_NAME)
    materials.push({
      entryId,
      caption: captionId ? (graph.getNode(captionId)?.text ?? '') : '',
      imageHash: imageFill?.type === 'IMAGE' ? (imageFill.imageHash ?? null) : null,
      imageNodeId: imageId ?? null
    })
  }
  return materials
}

function stripBullet(text: string): string {
  return text.startsWith(CONCLUSION_BULLET_PREFIX)
    ? text.slice(CONCLUSION_BULLET_PREFIX.length)
    : text
}

function readConclusions(graph: SceneGraph, conclusionsId: string): BriefConclusionView[] {
  const conclusions: BriefConclusionView[] = []
  for (const id of graph.getNode(conclusionsId)?.childIds ?? []) {
    const node = graph.getNode(id)
    if (node?.type === 'TEXT') {
      conclusions.push({ text: stripBullet(node.text), designId: null, designName: null })
      continue
    }
    // Per-design groups (结论组): designId marker authoritative, GroupTitle is the name projection
    if (node?.type === 'FRAME' && node.name === BRIEF_CONCLUSION_GROUP_NAME) {
      const designId =
        getSharedPluginData(node, BRIEF_PLUGIN_NAMESPACE, BRIEF_CONCLUSION_GROUP_DESIGN_KEY) || null
      const titleId = findChildId(graph, id, BRIEF_GROUP_TITLE_NAME)
      const designName = titleId ? (graph.getNode(titleId)?.text ?? null) : null
      for (const childId of node.childIds) {
        const child = graph.getNode(childId)
        if (child?.type === 'TEXT' && child.name !== BRIEF_GROUP_TITLE_NAME) {
          conclusions.push({ text: stripBullet(child.text), designId, designName })
        }
      }
    }
  }
  return conclusions
}

/** 设计名投影：活设计读现名；已死设计保痕（条目名 + 已删除标注，不物理清除）。
 *  2026-09-27 帧无身份：mode 投影（读穿设计根 pluginData 三元组）已裁。 */
function designProjection(graph: SceneGraph, designId: string, fallbackName: string) {
  const design = graph.getNode(designId)
  if (!design) {
    return {
      name: `${fallbackName}${BRIEF_TEXTS.deletedMark}`,
      deleted: true
    }
  }
  return {
    name: design.name,
    deleted: false
  }
}

/**
 * Designs-zone view: registered entries in list order (tombstoned when their
 * design died).
 *
 * T91a：去重键从节点 id 改为 design uniqueId（跨持久化稳定）。`seen` 集合
 * 同时记 uniqueId 与 designId，应对老 design（无 uniqueId）的迁移过渡期。
 * 2026-09-27：design→brief 反向指针补显（registered: false）随指针写源退役。
 */
/** T91a：单源去重键映射（uniqueId + node id 双 dedupe，应对老 design 无 UUID） */
interface DesignDedupe {
  uniqueIds: Set<string>
  nodeIds: Set<string>
}

/** 单条设计已见过（UUID 优先，node id 兜底） */
function alreadySeen(dedupe: DesignDedupe, nodeId: string, uniqueId: string): boolean {
  if (uniqueId && dedupe.uniqueIds.has(uniqueId)) return true
  if (dedupe.nodeIds.has(nodeId)) return true
  return false
}

/** 登记一条设计到 dedupe 集合 */
function markSeen(dedupe: DesignDedupe, nodeId: string, uniqueId: string): void {
  if (uniqueId) dedupe.uniqueIds.add(uniqueId)
  dedupe.nodeIds.add(nodeId)
}

/** T91a：从关联设计区条目读已注册设计（briefDesignEntryIds 投影） */
function collectRegisteredDesigns(
  graph: SceneGraph,
  listId: string,
  dedupe: DesignDedupe,
  out: BriefDesignEntryView[]
): void {
  for (const entryId of briefDesignEntryIds(graph, listId)) {
    const designId = briefDesignEntryDesignId(graph, entryId)
    if (!designId) continue
    const designNode = graph.getNode(designId)
    const uniqueId = getDesignUniqueId(designNode)
    if (alreadySeen(dedupe, designId, uniqueId)) continue
    markSeen(dedupe, designId, uniqueId)
    const entryText = findChildId(graph, entryId, '设计名')
    const fallbackName = entryText ? (graph.getNode(entryText)?.text ?? '') : ''
    out.push({
      entryId,
      designId,
      uniqueId,
      ...designProjection(graph, designId, fallbackName)
    })
  }
}

function readDesigns(graph: SceneGraph, listId: string): BriefDesignEntryView[] {
  const designs: BriefDesignEntryView[] = []
  const dedupe: DesignDedupe = { uniqueIds: new Set(), nodeIds: new Set() }
  collectRegisteredDesigns(graph, listId, dedupe, designs)
  return designs
}

/**
 * Read the current brief into a panel view model. Returns null when no brief
 * resolves (none / ambiguous without briefId) OR when the brief's expected
 * structure is broken — callers distinguish via findBrief.
 */
export function readBrief(figma: FigmaAPI, briefId?: string): BriefView | null {
  const graph = figma.graph
  const resolution = findBrief(figma, briefId)
  if (resolution.status !== 'ok') return null
  const brief = resolution.brief

  const contentTextId = findContentTextId(graph, brief.id)
  const gridId = findMaterialGridId(graph, brief.id)
  const conclusionsId = findConclusionsId(graph, brief.id)
  const designListId = findDesignListId(graph, brief.id)
  if (!contentTextId || !gridId || !conclusionsId || !designListId) return null

  return {
    briefId: brief.id,
    uniqueId: getBriefUniqueId(brief),
    content: graph.getNode(contentTextId)?.text ?? '',
    materials: readMaterials(graph, gridId),
    conclusions: readConclusions(graph, conclusionsId),
    designs: readDesigns(graph, designListId)
  }
}

/** Overwrite the brief's content-zone text. */
export function updateBriefContent(figma: FigmaAPI, briefId: string, text: string): boolean {
  const graph = figma.graph
  if (!isBrief(graph.getNode(briefId))) return false
  const contentTextId = findContentTextId(graph, briefId)
  if (!contentTextId) return false
  graph.updateNode(contentTextId, { text })
  return true
}

/** Overwrite one material entry's caption text. */
export function updateMaterialCaption(figma: FigmaAPI, entryId: string, caption: string): boolean {
  const graph = figma.graph
  const entry = graph.getNode(entryId)
  if (!entry || entry.name !== BRIEF_ENTRY_NAME) return false
  const captionId = findChildId(graph, entryId, BRIEF_CAPTION_NAME)
  if (!captionId) return false
  graph.updateNode(captionId, { text: caption })
  return true
}

/** Delete one material entry from the brief. */
export function removeBriefMaterial(figma: FigmaAPI, entryId: string): boolean {
  const graph = figma.graph
  const entry = graph.getNode(entryId)
  if (!entry || entry.name !== BRIEF_ENTRY_NAME) return false
  graph.deleteNode(entryId)
  return true
}
