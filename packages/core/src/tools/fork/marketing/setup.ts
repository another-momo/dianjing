/**
 * setup_design core（T53，S3 §2 窄化：仅「新建」时调用）。
 *
 * 移植自 open-pencil 仓 feature/agent-backend @ 5d38aa4e
 * tools/marketing/setup.ts，差异（S3 §2 L47 删除不移植）：
 * - 领养发现逻辑（resolveExistingDesign / findRootFrame / ADOPTED 教学 note）
 *   与 registry.ts 进程态（WeakMap+clock）整体删除——窄化后重复调用 = 恒新建。
 * - 标记面走通用 get/setSharedPluginData（namespace 'open-pencil-marketing'，
 *   键面复用 brief.ts 单源常量），逐键写、每键写前重读防 stale 快照。
 * - 放置走共享 findPlacementPosition（页面 bounds 右侧 +100、y 跟随），
 *   创建后 scrollAndZoomIntoView。
 *
 * 2026-09-27 帧无身份（state-layering wave-2 §6.1/§6.3）：mode 绑定退役——
 *  - 设计根不再落盘身份三元组（modeId / profileId / briefId 均不写帧）：
 *    规制 = 用户层 page-state 文档标量（确认门直写），brief 按页发现，
 *    设计区身份 = 页本身（一页一作品）。
 *  - modeId / profileId 参数与 catalog 注入（__catalog）整体删除——尺寸 =
 *    显式 canvas 参数或 750 宽 + HUG 缺省；workflow 由装配按 page-state 注入。
 *  - 新建意图确认门（pluginData 四键 + awaiting 信封）随 intent 四键退役
 *    整体摘除——§6.2：setup_design 落点页建根帧，静默。
 *  - brief 关联（bound-designs 指针 + 关联设计区条目登记）保留——绑定天然
 *    页局部，跨页校验不复存在。
 *
 * T65（owner 2026-09-01 拍板 C）：尺寸语义——可选 `canvas` 参数覆盖
 * （自由值 `宽x`/`宽x高`，非法 → invalid_canvas；2026-09-27 起确认卡尺寸行
 * 摘除，来源只剩 agent 按对话/教学显式传）；缺省恒为 750 宽 + HUG。
 * 落盘 size 语义不变（{width, height|null}，null = HUG）。
 */

import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import type { Vector } from '@open-pencil/scene-graph/primitives'

import type { FigmaAPI } from '#core/figma-api'
import { getSharedPluginData, setSharedPluginData } from '#core/figma-api/plugin-data'
import { findPlacementPosition } from '#core/tools/fork/placement'

import {
  BRIEF_PLUGIN_NAMESPACE,
  BRIEF_ROLE_KEY,
  BRIEF_SCHEMA_VERSION,
  BRIEF_SCHEMA_VERSION_KEY,
  bindBriefToDesign,
  findBrief,
  generatePluginUniqueId,
  registerBriefDesignEntry,
  setDesignUniqueId,
  type BriefCandidate
} from './brief'
import { SETUP_TEXTS } from './texts'

/** 设计根 role 标记值（单源；image-gen/history.ts 的同名本地常量集成时改 import） */
export const MARKETING_ROLE_ROOT = 'marketing-root'

/** 缺省尺寸：750 宽 + HUG 高（长图默认，T62 定谳 1——所有 mode 同口径） */
const SETUP_DEFAULT_WIDTH = 750
/** HUG 高根 frame 的初始高度（随内容生长前的占位） */
const SETUP_HUG_INITIAL_HEIGHT = 400

// ── 尺寸契约：canvas 串解析（前后端校验共用单源）────────────────────────────

/**
 * 尺寸预设：label 中文名 + canvas 串（`宽x` = 高 HUG 随内容生长 / `宽x高` = 定高）。
 * studio frontmatter `sizes` 清单与 manifest 投影共用本形状
 * （type-shapes 门禁禁同构双写——消费侧一律 import type 或别名）。
 */
export interface CanvasSizePreset {
  label: string
  canvas: string
}

/** canvas 串格式（T65 §2.1/§2.2）：`宽x`（HUG 高）或 `宽x高`（定高） */
const CANVAS_SIZE_RE = /^(\d+)x(\d+)?$/

/** canvas 串 → 落盘尺寸语义（height null = HUG）；格式非法 → null */
export function parseCanvasSize(canvas: string): { width: number; height: number | null } | null {
  const match = CANVAS_SIZE_RE.exec(canvas)
  if (!match) return null
  const [, width, height] = match
  // 可选捕获组运行时可为 undefined（索引签名类型不含），truthy 守卫兼排两种
  return { width: Number(width), height: height ? Number(height) : null }
}

export interface SetupDesignArgs {
  briefId: string
  /** 尺寸覆盖（T65）：自由值 `宽x`/`宽x高`；格式非法 → invalid_canvas */
  canvas?: string
}

// ── 结果 ───────────────────────────────────────────────────────────────────

export type SetupDesignErrorCode = 'brief_not_found' | 'ambiguous_brief' | 'invalid_canvas'

export interface SetupDesignError {
  error: SetupDesignErrorCode
  /** 用户语言化说明（zh-cn，SETUP_TEXTS 外置） */
  message: string
  briefId?: string
  candidates?: BriefCandidate[]
}

export interface SetupDesignSuccess {
  rootId: string
  name: string
  /** 尺寸快照语义：height null = HUG（长图随内容生长，初始高占位 400） */
  size: { width: number; height: number | null }
  briefId: string
  placement: Vector
  /** 成功结果锚点行（agent 可见——工作区已落图的事实行） */
  message: string
}

export type SetupDesignResult = SetupDesignSuccess | SetupDesignError

// ── 标记读写（逐键写、写前重读，同 setBriefMarker 先例）───────────────────────

function setDesignMarker(graph: SceneGraph, nodeId: string, key: string, value: string): void {
  const node = graph.getNode(nodeId)
  if (!node) return
  setSharedPluginData(graph, node, BRIEF_PLUGIN_NAMESPACE, key, value)
}

export function isMarketingDesignRoot(node: SceneNode | undefined): node is SceneNode {
  if (node?.type !== 'FRAME') return false
  return getSharedPluginData(node, BRIEF_PLUGIN_NAMESPACE, BRIEF_ROLE_KEY) === MARKETING_ROLE_ROOT
}

// ── 尺寸与命名 ─────────────────────────────────────────────────────────────

/** 尺寸解析：显式 canvas 参数（非法 → invalid_canvas）> 750 宽 + HUG 缺省 */
function resolveSize(
  args: SetupDesignArgs
): { width: number; height: number | null } | SetupDesignError {
  if (args.canvas !== undefined) {
    const parsed = parseCanvasSize(args.canvas)
    if (!parsed) {
      return { error: 'invalid_canvas', message: SETUP_TEXTS.invalidCanvas(args.canvas) }
    }
    return parsed
  }
  return { width: SETUP_DEFAULT_WIDTH, height: null }
}

/**
 * 新根 frame 显示名：当前页设计根间取最小空闲「营销设计 N」（首个用裸基底，
 * N 自 2 递增）。名称仅展示用，机器身份看标记；命名去重域 = 当前页全部
 * 设计根（帧无身份后无 mode 子域）。
 */
function nextDesignRootName(figma: FigmaAPI, label: string): string {
  const graph = figma.graph
  const page = graph.getNode(figma.currentPage.id)
  const taken = new Set<string>()
  for (const childId of page?.childIds ?? []) {
    const child = graph.getNode(childId)
    if (!child || !isMarketingDesignRoot(child)) continue
    taken.add(child.name)
  }
  if (!taken.has(label)) return label
  for (let n = 2; ; n++) {
    const candidate = `${label} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** 几何移植（保留值）：VERTICAL / counter FIXED / 高 HUG|'FIXED' / 白底 / clipsContent */
function createDesignRoot(
  figma: FigmaAPI,
  name: string,
  size: { width: number; height: number | null },
  position: Vector
): SceneNode {
  return figma.graph.createNode('FRAME', figma.currentPage.id, {
    name,
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height ?? SETUP_HUG_INITIAL_HEIGHT,
    layoutMode: 'VERTICAL',
    counterAxisSizing: 'FIXED',
    primaryAxisSizing: size.height === null ? 'HUG' : 'FIXED',
    clipsContent: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }]
  })
}

/**
 * 新建一张营销设计：校验（brief → canvas）→ 建框 → role/schemaVersion 落盘 →
 * brief 关联登记 → 视口聚焦。窄化后无领养无幂等——同参数再调恒新建第二框
 * （最小空闲名递增）。设计根不携带任何身份标记（§6.1 帧无身份）——落点页
 * 即施工面，装配输入 = page-state 规制标量 + 落点页 brief。
 */
export function setupDesign(figma: FigmaAPI, args: SetupDesignArgs): SetupDesignResult {
  const graph = figma.graph

  const resolution = findBrief(figma, args.briefId === '' ? undefined : args.briefId)
  if (resolution.status === 'not-found') {
    return {
      error: 'brief_not_found',
      message: SETUP_TEXTS.briefNotFound(resolution.briefId),
      briefId: resolution.briefId
    }
  }
  if (resolution.status === 'none') {
    return { error: 'brief_not_found', message: SETUP_TEXTS.briefNone }
  }
  if (resolution.status === 'ambiguous') {
    return {
      error: 'ambiguous_brief',
      message: SETUP_TEXTS.ambiguousBrief,
      candidates: resolution.candidates
    }
  }
  const brief = resolution.brief

  const size = resolveSize(args)
  if ('error' in size) return size

  const name = nextDesignRootName(figma, SETUP_TEXTS.designRootName)
  const position = findPlacementPosition(figma, {
    width: size.width,
    height: size.height ?? SETUP_HUG_INITIAL_HEIGHT
  })
  const root = createDesignRoot(figma, name, size, position)

  // role 标记 + schemaVersion（帧无身份——三元组不落盘，T62 遗产键天然忽略）
  setDesignMarker(graph, root.id, BRIEF_ROLE_KEY, MARKETING_ROLE_ROOT)
  setDesignMarker(graph, root.id, BRIEF_SCHEMA_VERSION_KEY, BRIEF_SCHEMA_VERSION)
  // T91a：写 design uniqueId（跨持久化边界稳定寻址键，UUID v4——brief↔design
  // 绑定的寻址键，非身份）
  setDesignUniqueId(graph, root.id, generatePluginUniqueId())

  // brief 关联：bound-designs 指针 + 关联设计区条目（页局部绑定，无跨页语义）
  bindBriefToDesign(figma, brief.id, root.id)
  registerBriefDesignEntry(figma, brief.id, root.id)

  const proxy = figma.getNodeById(root.id)
  if (proxy) figma.viewport.scrollAndZoomIntoView([proxy])

  return {
    rootId: root.id,
    name,
    size,
    briefId: brief.id,
    placement: position,
    message: SETUP_TEXTS.workspaceCreated()
  }
}

// ── 无状态扫描（页内设计根列表；无身份投影）────────────────────────────────

export interface MarketingDesignRef {
  rootId: string
  name: string
}

/** 扫当前页全部营销设计根（递归走查——用户可能把根 frame 编组；死节点读不到标记天然不出现） */
export function scanMarketingDesigns(figma: FigmaAPI): MarketingDesignRef[] {
  const graph = figma.graph
  const page = graph.getNode(figma.currentPage.id)
  if (!page) return []
  const designs: MarketingDesignRef[] = []
  const stack = [...page.childIds]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) break
    const node = graph.getNode(id)
    if (!node) continue
    if (isMarketingDesignRoot(node)) designs.push({ rootId: node.id, name: node.name })
    stack.push(...node.childIds)
  }
  return designs
}
