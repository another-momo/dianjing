/**
 * T54（Phase 3 W2/T-B3）：生成历史（"历史图片备份"）——自 open-pencil 仓
 * feature/agent-backend @ 5d38aa4e 的 tools/image-gen/history.ts 移植。
 *
 * Before generate_image overwrites a node that holds an image, the old
 * subtree is cloned into the history container so no superseded version is
 * ever lost — and a mistaken overwrite (e.g. a reference image passed as
 * `replace_id`) stays recoverable.
 * Only IMAGE fills are preserved: children survive a fill replacement and
 * solid/gradient fills are trivially recreatable.
 *
 * New images (no `replace_id`) are NOT snapshotted: the fresh node itself is
 * already on the canvas, so every version exists exactly once (lean-history
 * policy).
 *
 * Entries and the container carry pluginData markers (rename-proof) and must
 * not be used as overwrite targets — apply.ts redirects them to a new node.
 *
 * T66 ⑤（备份容器迁专用页，仓外提案 202609010000-history-container-placement）：
 * 容器不再锚定设计页 marketing root 右侧（干扰设计工作流、唯一不走统一放置
 * 策略的创建路径），改落专用备份页「图片备份」——页身份由容器节点级 pluginData
 * 标记派生（image-history-container，rename-proof；节点级走 .fig 原生回环、
 * 零 patch），页名「图片备份」兜底容器被手删的情形；page 级 pluginData 不再
 * 写入——P212/P213（CANVAS 节点 pluginData 双向映射）随之上游合并退役。容器
 * 在备份页内走统一放置策略（findPlacementPositionOnPage，placement.ts 跨页
 * seam）。单容器全局复用：entry 以 source-target 标记键定源（节点 id 全文档
 * 唯一），跨页无歧义。isMarketingDesignRoot 锚定逻辑与 import 随迁删除。
 *
 * 与源的差异（目标仓适配）：
 * - upsertPluginData 内联（目标仓无 #core/tools/plugin-data；figma-api/
 *   plugin-data.ts 通用面的 shared 键编码形态与本标记协议不同，逐字保留源语义）
 * - ~~marketing root 侦测收敛单源（T53 集成期归并）~~ T66 ⑤ 起锚定删除
 */

import type { PluginDataEntry, SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import { findPlacementPositionOnPage } from '#core/tools/fork/placement'

const HISTORY_PLUGIN_ID = 'open-pencil-image-gen'
const ROLE_KEY = 'role'
const ROLE_CONTAINER = 'image-history-container'
const ROLE_ENTRY = 'image-history-entry'
const SOURCE_TARGET_KEY = 'source-target'
const SOURCE_HASH_KEY = 'source-hash'
const VERSION_KEY = 'version'
const CAPTURED_AT_KEY = 'captured-at'

const CONTAINER_NAME = '历史图片备份'
/** T66 ⑤：专用备份页名（仓内无既有备份页常量/文案约定，T66-plan ⑤ 定稿） */
const BACKUP_PAGE_NAME = '图片备份'

// ── 本地插件数据 upsert（源 tools/plugin-data.ts 语义逐字） ──

function upsertPluginData(
  graph: SceneGraph,
  nodeId: string,
  pluginId: string,
  entries: Array<{ key: string; value: string }>
): void {
  const node = graph.getNode(nodeId)
  if (!node) return
  const kept = node.pluginData.filter(
    (entry) => !(entry.pluginId === pluginId && entries.some(({ key }) => key === entry.key))
  )
  graph.updateNode(nodeId, {
    pluginData: [...kept, ...entries.map(({ key, value }) => ({ pluginId, key, value }))]
  })
}

// ── 快照数据形态 ──

export interface HistorySnapshot {
  id: string
  name: string
  /** 该目标的第几版快照（1 起） */
  version: number
}

function markerValue(node: SceneNode, key: string): string | undefined {
  return node.pluginData.find(
    (entry: PluginDataEntry) => entry.pluginId === HISTORY_PLUGIN_ID && entry.key === key
  )?.value
}

function upsertMarkers(
  graph: SceneGraph,
  nodeId: string,
  entries: Array<{ key: string; value: string }>
): void {
  upsertPluginData(graph, nodeId, HISTORY_PLUGIN_ID, entries)
}

function isHistoryContainer(node: SceneNode | undefined): boolean {
  return !!node && markerValue(node, ROLE_KEY) === ROLE_CONTAINER
}

function isHistoryEntry(node: SceneNode | undefined): boolean {
  return !!node && markerValue(node, ROLE_KEY) === ROLE_ENTRY
}

/** True when the node is a history entry, the container, or lives inside one */
export function isInImageHistory(graph: SceneGraph, nodeId: string): boolean {
  let current = graph.getNode(nodeId)
  while (current) {
    if (isHistoryEntry(current) || isHistoryContainer(current)) return true
    current = current.parentId ? graph.getNode(current.parentId) : undefined
  }
  return false
}

function topImageHash(node: SceneNode): string | undefined {
  for (const fill of node.fills) {
    if (fill.type === 'IMAGE' && fill.visible && 'imageHash' in fill) {
      return fill.imageHash
    }
  }
  return undefined
}

/**
 * 备份页幂等查找/创建——页身份由容器节点标记派生：备份页恒含带
 * image-history-container 节点级标记的容器（每次快照必创建/复用），节点级
 * pluginData 走 .fig 原生回环，rename-proof 且零 patch。找不到容器时按
 * 「图片备份」页名兜底（兜容器被手删的情形）；仍无才新建，不再写页级标记。
 */
function getOrCreateBackupPage(graph: SceneGraph): SceneNode {
  for (const page of graph.getPages()) {
    for (const childId of page.childIds) {
      if (isHistoryContainer(graph.getNode(childId))) return page
    }
  }
  const byName = graph.getPages().find((page) => page.name === BACKUP_PAGE_NAME)
  if (byName) return byName
  const page = graph.addPage(BACKUP_PAGE_NAME)
  return graph.getNode(page.id) ?? page
}

function findContainer(graph: SceneGraph, pageId: string): SceneNode | undefined {
  const page = graph.getNode(pageId)
  if (!page) return undefined
  for (const childId of page.childIds) {
    const child = graph.getNode(childId)
    if (isHistoryContainer(child)) return child
  }
  return undefined
}

function createContainer(graph: SceneGraph, backupPageId: string): SceneNode {
  // T66 ⑤：统一放置策略（备份页顶层 bounds 右侧 + PLACEMENT_GAP，空页原点）；
  // 容器建后不再移动（备份页正常态只有这一个容器，实际恒落 (0,0)）。
  const position = findPlacementPositionOnPage(graph, backupPageId, { width: 0, height: 0 })

  const container = graph.createNode('FRAME', backupPageId, {
    name: CONTAINER_NAME,
    x: position.x,
    y: position.y,
    layoutMode: 'VERTICAL',
    itemSpacing: 24,
    primaryAxisSizing: 'HUG',
    counterAxisSizing: 'HUG',
    paddingTop: 24,
    paddingRight: 24,
    paddingBottom: 24,
    paddingLeft: 24,
    clipsContent: false,
    fills: [
      { type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.96, a: 1 }, opacity: 1, visible: true }
    ]
  })
  upsertMarkers(graph, container.id, [{ key: ROLE_KEY, value: ROLE_CONTAINER }])
  return container
}

function entriesOf(graph: SceneGraph, container: SceneNode, targetId: string): SceneNode[] {
  const entries: SceneNode[] = []
  for (const childId of container.childIds) {
    const child = graph.getNode(childId)
    if (child && isHistoryEntry(child) && markerValue(child, SOURCE_TARGET_KEY) === targetId) {
      entries.push(child)
    }
  }
  return entries
}

/**
 * Clone the target's current subtree into the backup page's history container.
 * Returns the snapshot, or undefined when there is nothing worth keeping
 * (empty node, or the same image already snapshotted for this target).
 *
 * T66 ⑤：容器落专用备份页（跨页 cloneTree——clone 是图层级子树拷贝，无同页
 * 假设）；entry 以 source-target 标记键定源（节点 id 全文档唯一），恢复/
 * 复用读取均按 id 全文档解析，无同页依赖。
 */
export function snapshotBeforeOverwrite(
  graph: SceneGraph,
  targetId: string
): HistorySnapshot | undefined {
  const target = graph.getNode(targetId)
  if (!target) return undefined

  // Only IMAGE fills are irreplaceable (generated art / uploaded assets).
  // Children survive a fill replacement, and solid/gradient fills are
  // one-line recreations — snapshotting them would flood the history with
  // placeholder noise.
  const hash = topImageHash(target)
  if (!hash) return undefined

  const backupPage = getOrCreateBackupPage(graph)
  const existingContainer = findContainer(graph, backupPage.id)
  const prior = existingContainer ? entriesOf(graph, existingContainer, targetId) : []
  if (prior.length > 0) {
    const latestHash = markerValue(prior[prior.length - 1], SOURCE_HASH_KEY)
    if (latestHash === hash) return undefined
  }

  const container = existingContainer ?? createContainer(graph, backupPage.id)
  const version = prior.length + 1
  const clone = graph.cloneTree(targetId, container.id, {
    name: `${target.name} · v${version}`,
    x: 0,
    y: 0,
    // The clone must not inherit fill/grow behavior from its old parent —
    // inside the history container it keeps its own fixed size.
    layoutGrow: 0,
    layoutAlignSelf: 'AUTO',
    layoutPositioning: 'AUTO'
  })
  if (!clone) return undefined

  // cloneTree copies pluginData — strip foreign markers so a snapshotted
  // marketing root (or other marked node) does not turn the history entry
  // into a phantom design/reference, then stamp our own.
  graph.updateNode(clone.id, { pluginData: [] })
  upsertMarkers(graph, clone.id, [
    { key: ROLE_KEY, value: ROLE_ENTRY },
    { key: SOURCE_TARGET_KEY, value: targetId },
    { key: SOURCE_HASH_KEY, value: hash },
    { key: VERSION_KEY, value: String(version) },
    { key: CAPTURED_AT_KEY, value: new Date().toISOString() }
  ])
  return { id: clone.id, name: clone.name, version }
}
