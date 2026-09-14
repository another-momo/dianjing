/**
 * T60（Phase 3 W3/T-B9）active_design 宿主路由与每回合组装——pi 后端进程侧。
 *
 * 职责（T60-plan §2 定谳）：
 *  - 单槽读穿：文档根 sharedPluginData `activeDesignNodeId` 经桥 eval 探针取回
 *    （桥只剩 'tool' 指令面，core `eval` 工具在 ALL_TOOLS 内天然可达——不新增
 *    桥指令、不碰桥代码；键面常量 import core active-design.ts 单源插值）。
 *    合法性四条件判定跑在后端（core 纯函数 checkActiveDesignCandidate /
 *    evaluateActiveDesignSlot，桥只取裸数据——宿主永不猜测，也不把判定串化进
 *    eval 片段）。
 *  - 四事件移槽：①setup_design 成功回调（tools.ts 缝）→ 写槽；②/③端点
 *    POST /api/pi/active-design（setActiveDesignViaBridge，校验四条件 → 移槽 →
 *    返回身份三元组）；④ask_user_question 工具调用记录 formId→当时槽位
 *    （会话内不落盘），[表单作答 formId=…] 信封到达且节点仍合法 → 移槽。
 *  - 删除悬空清槽：每回合读穿发现槽位节点不存在/不再是设计区根框 → 清槽 +
 *    context 注入一行系统提示。
 *  - 每回合组装：system = base + workflow + profile 全文（顺序固定）；
 *    context = 身份封套 + 系统提示行（pi before_agent_start 的 result.message
 *    custom 通道注入——convertToLlm 转 user role 进模型上下文，不进 UI 流、
 *    不进历史回填）。
 *    P0-1（newIntent 时序缺口修复）：workflow/profile 的 registry 查找从
 *    assembleTurn 上移到 probe 阶段（resolveTurnAssets），优先级 **newIntent >
 *    slot**——newIntent 是「用户刚刚确认的意图」，slot 是「历史残留」。故
 *    「确认新建 → 设计区尚未落图」的 Turn 1 也拿到 workflow + profile
 *    （此前只有 base，工作流/风格/references 全丢）。空槽且无 newIntent
 *    = base only + 无封套；mode 有 id 但 workflow 文件缺失 → 一行提示 +
 *    按 general 组装（不注 profile）。
 *    T85 起尾段追加「按需参考」索引节（active 资产 references 并集非空时），
 *    并集即本回合 load_reference 允许集（load-reference.ts）。
 *  - 新建意图一次性旗标：首行信封 `[新建意图确认 modeId=<id> profileId=<id>
 *    canvas=<值>]`（字段可缺省，顺序固定；canvas 自 T65 起）剥离 → 本回合
 *    newIntentConfirmed() 返真 → run 结束 finalizeTurn（runPrompt finally）
 *    强制复位。T65 集成缺口修复：剥离时把确认参数组装成一行系统提示注入
 *    本回合 context（「用户已为本次新建确认参数：…（选择即锁定，不得覆盖）」，
 *    缺省字段省略；裸信封无参数不注入）——确认参数此前对 AI 不可见。
 *
 * 桥失败语义：探针不可达（无 discovery / 桥 502 / 无活动文档）→ 本回合按空槽
 * 组装并 warn（冒烟环境无浏览器即此路径；工具调用届时会各自显式失败）；
 * 端点路径则显式 502 bridge_unavailable（红线 #8 不静默）。
 *
 * 仅运行于独立后端进程；只允许相对导入与 node/依赖包导入（同 service.ts 纪律）。
 */

import {
  ACTIVE_DESIGN_PROBE_KEYS,
  checkActiveDesignCandidate,
  evaluateActiveDesignSlot,
  type ActiveDesignRejectReason,
  type ActiveDesignSlotState,
  type BriefLinkSnapshot,
  type DesignRootSnapshot
} from '@open-pencil/core/tools/fork/marketing/active-design'
import { parseAskAnswer } from '@open-pencil/core/tools/fork/marketing/ask-user-question'
import type { NewIntentState } from '@open-pencil/core/tools/fork/marketing/brief'
import { ACTIVE_DESIGN_TEXTS } from '@open-pencil/core/tools/fork/marketing/texts'

import { readDiscoveryFile } from '@/app/bridge/server/discovery'

import { postBridgeRPC } from './bridge-rpc'
import { referenceBucketKey } from './studio/types'
import type { StudioBase, StudioProfile, StudioRegistry, StudioWorkflow } from './studio/types'

// ── 新建意图信封（共享契约：首行 `[新建意图确认 modeId=<id> profileId=<id> canvas=<值>]`，
//    字段可缺省、顺序固定；canvas = 尺寸覆盖值，T65 §2.4）──────────────────────────

const NEW_INTENT_MARKER =
  /^\[新建意图确认(?:\s+modeId=([^\]\s]+))?(?:\s+profileId=([^\]\s]+))?(?:\s+canvas=([^\]\s]+))?\]\r?$/

export interface NewIntentEnvelope {
  modeId?: string
  profileId?: string
  /** 尺寸覆盖值（canvas 串原样透传；格式校验在 core setup_design，非法 → invalid_canvas） */
  canvas?: string
}

/** 剥首行信封；仅首行精确命中才剥离（容错：非首行/畸形一律不动原文） */
export function stripNewIntentEnvelope(text: string): {
  envelope: NewIntentEnvelope | null
  stripped: string
} {
  const newline = text.indexOf('\n')
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  const match = NEW_INTENT_MARKER.exec(firstLine)
  if (!match) return { envelope: null, stripped: text }
  const [, modeId, profileId, canvas] = match
  // 可选捕获组运行时可为 undefined（索引签名类型不含），truthy 守卫兼排两种
  const envelope: { modeId?: string; profileId?: string; canvas?: string } = {}
  if (modeId) envelope.modeId = modeId
  if (profileId) envelope.profileId = profileId
  if (canvas) envelope.canvas = canvas
  return {
    envelope,
    stripped: newline === -1 ? '' : text.slice(newline + 1)
  }
}

// ── 每回合组装（纯函数；base→workflow→profile 顺序固定，前缀缓存友好）─────────

export interface TurnAssembly {
  systemPrompt: string
  /** context 注入行（身份封套 + 系统提示）；空槽 → 空数组 */
  contextLines: string[]
  /**
   * T85 定谳 4：本回合 load_reference 允许集（声明 path → 加载期解析绝对路径；
   * 空 = 本回合不可读任何 reference）。宿主持有于 turn 缓存袋，finalizeTurn
   * 随 turn=null 一并复位（同 intentConfirmed 一次性态纪律）。
   */
  allowedReferences: ReadonlyMap<string, string>
}

/** 索引节标题（T85 定谳 3 字面口径；P2-3 同步工具名） */
const REFERENCES_INDEX_HEADING = '## 按需参考（load_reference 工具按需读取）'

/** 本回合 active 资产的 references 并集：base 恒在 + 命中的 workflow + 命中的 profile */
function collectActiveReferences(
  registry: StudioRegistry,
  assets: Array<StudioBase | StudioWorkflow | StudioProfile>
): { indexSection: string; allowed: Map<string, string> } {
  const lines: string[] = []
  const allowed = new Map<string, string>()
  for (const asset of assets) {
    if (!asset.references || asset.references.length === 0) continue
    const source = asset.kind === 'base' ? 'base' : `${asset.kind}: ${asset.id}`
    const bucket = registry.resolvedReferences.get(referenceBucketKey(asset.kind, asset.id))
    for (const ref of asset.references) {
      lines.push(`- ${ref.path} —— ${ref.description}（${source}）`)
      const abs = bucket?.get(ref.path)
      // 同 path 多资产声明冲突：先声明先赢（索引首条与允许集指向一致）
      if (abs && !allowed.has(ref.path)) allowed.set(ref.path, abs)
    }
  }
  return {
    indexSection: lines.length === 0 ? '' : `${REFERENCES_INDEX_HEADING}\n${lines.join('\n')}`,
    allowed
  }
}

/** 组装收尾：references 索引节追加进 systemPrompt 尾段（并集非空时）+ 允许集入 TurnAssembly */
function finishTurn(
  registry: StudioRegistry,
  segments: string[],
  contextLines: string[],
  activeAssets: Array<StudioBase | StudioWorkflow | StudioProfile>
): TurnAssembly {
  const { indexSection, allowed } = collectActiveReferences(registry, activeAssets)
  return {
    systemPrompt: joinSegments([...segments, indexSection]),
    contextLines,
    allowedReferences: allowed
  }
}

/** 身份封套首行（nodeId + briefId；P2-2 §8.1.1 移除 modeId/profileId——agent 从
 *  system prompt 内容本身知道当前 workflow/profile，不需文件名 id；暴露可能泄露
 *  给用户，且 id 不稳定）。注意：`[新建意图确认 modeId=... profileId=...]` 是
 *  P0-1 newIntent 流程的承重设计（setup_design 守卫依赖），绝不可动。 */
export function designTargetEnvelope(design: DesignRootSnapshot): string {
  return `[当前设计目标 nodeId=${design.nodeId} briefId=${design.briefId}]`
}

/**
 * P0-1：装配输入 = core 槽位判定态 + probe 阶段已解析的资产对象。
 *
 * `resolvedWorkflow` / `resolvedProfile` 由 `probeSlotState` 按 **newIntent 优先于
 * slot** 的优先级完成 registry 查找后填入——newIntent 是「用户刚刚确认的意图」，
 * slot 是「历史残留」（可能指向旧设计），故 newIntent.confirmed && modeId 命中时
 * 覆盖 slot 的解析结果。`assembleTurn` 只消费已解析对象，不再自己查 registry。
 *
 * 字段缺省（两者皆 undefined）= 未解析出任何资产：空槽 → base only；有槽且
 * modeId 非 general → workflowMissing 提示（缺失面判定同样落在 probe 阶段，
 * 见 resolveTurnAssets）。
 */
export type TurnSlotState = ActiveDesignSlotState & {
  resolvedWorkflow?: StudioWorkflow
  resolvedProfile?: StudioProfile
  /** 落盘/意图 mode 有 id 但 registry 未命中 workflow → 装配注 workflowMissing 提示 */
  workflowMissingModeId?: string
}

/**
 * 组装一回合的 system/context。规则（T60-plan 定谳 4 + P0-1 修订）：
 *  - 段序固定 base → workflow → profile（前缀缓存友好）；resolved 字段为空则该段跳过
 *  - 空槽（status !== 'ok'）：无身份封套；resolved 命中时仍注 workflow/profile 段
 *    ——这是 P0-1 的核心修复：newIntent 已确认但设计区尚未落图的 Turn 1，
 *    AI 必须已经拿到 workflow（怎么做）与 profile（做成什么样）
 *  - 有槽：身份封套首行 + resolved 段；brief 悬空（需求单被删）→ 一行系统提示
 *  - workflowMissingModeId 非空 → 一行 workflowMissing 提示（身份封套保留——目标事实仍在）
 *  - T85 定谳 3：本回合 active 资产（base 恒在 + 命中 workflow + 命中 profile）的
 *    references 并集非空时，systemPrompt 尾段追加「按需参考」索引节；并集即本回合
 *    load_reference 允许集（allowedReferences，finalizeTurn 复位）
 */
export function assembleTurn(
  registry: StudioRegistry,
  slot: TurnSlotState,
  extraNotices: string[] = []
): TurnAssembly {
  const base = registry.base?.body ?? ''
  const baseAsset = registry.base ? [registry.base] : []
  const { resolvedWorkflow, resolvedProfile } = slot
  const activeAssets = [
    ...baseAsset,
    ...(resolvedWorkflow ? [resolvedWorkflow] : []),
    ...(resolvedProfile ? [resolvedProfile] : [])
  ]
  const segments = [base, resolvedWorkflow?.body ?? '', resolvedProfile?.body ?? '']

  const contextLines = slot.status === 'ok' ? [designTargetEnvelope(slot.design)] : []
  contextLines.push(...extraNotices)
  if (slot.status === 'ok' && slot.briefMissing) contextLines.push(ACTIVE_DESIGN_TEXTS.briefMissing)
  if (slot.workflowMissingModeId !== undefined) {
    contextLines.push(ACTIVE_DESIGN_TEXTS.workflowMissing(slot.workflowMissingModeId))
  }
  return finishTurn(registry, segments, contextLines, activeAssets)
}

/**
 * P0-1：本回合资产解析（纯函数；probe 阶段调用，装配侧只消费结果）。
 *
 * 优先级 **newIntent > slot**：`newIntent.confirmed && newIntent.modeId` 为真时按
 * newIntent 的 modeId/profileId 解析；否则按 slot.design 的落盘三元组解析。
 * 两者皆无 → 全空（空槽 base only）。
 *
 * workflow 缺失语义（沿用 T60 定谳）：modeId 非空但 registry 未命中 workflow
 * → workflowMissingModeId 置位 + **profile 不注入**（按 base only 组装，避免
 * profile 规则悬空执行）。general 与其他 mode 一律走 registry 查表——general
 * 在 workflows/general.md 落位后与 longform 等同（一致架构，无特殊分支）。
 */
export function resolveTurnAssets(
  registry: StudioRegistry,
  slot: ActiveDesignSlotState,
  newIntent: NewIntentState | null
): TurnSlotState {
  const useIntent = newIntent?.confirmed === true && newIntent.modeId !== ''
  const slotModeId = slot.status === 'ok' ? slot.design.modeId : ''
  const slotProfileId = slot.status === 'ok' ? slot.design.profileId : ''
  const modeId = useIntent ? newIntent.modeId : slotModeId
  const profileId = useIntent ? newIntent.profileId : slotProfileId
  if (modeId === '') return slot
  const profile = profileId === '' ? undefined : registry.profiles.get(profileId)
  const workflow = registry.workflows.get(modeId)
  // 缺失 → 按 base only 组装（不注 profile）+ 提示行
  if (!workflow) return { ...slot, workflowMissingModeId: modeId }
  // P2-10（2026-09-07）：profile 的 modes 字段是运行时过滤权威——UI 层（chips 菜单）
  // 与 prompt 注入层（本校验）都按 modes 筛选，缺省/空数组 = 所有 mode 可用。
  // 若 profile 显式列出 modes 但当前 modeId 不在列 → 不注入该 profile（防御层：
  // UI 正常不会选出这种组合，但 pluginData 信封跨文档残留等场景仍需拦截）。
  const profileMatches = profile
    ? profile.modes.length === 0 || profile.modes.includes(modeId)
    : true
  return {
    ...slot,
    resolvedWorkflow: workflow,
    ...(profile && profileMatches ? { resolvedProfile: profile } : {})
  }
}

function joinSegments(segments: string[]): string {
  return segments.filter((segment) => segment !== '').join('\n\n')
}

// ── 桥探针 / 写槽（经 core `eval` 工具，键面常量单源插值）──────────────────────

export interface SlotProbeData {
  slotNodeId: string
  currentPageId: string
  design: DesignRootSnapshot | null
  brief: BriefLinkSnapshot | null
  materialized: boolean
  /**
   * P0-1：newIntent 三键随槽位探针同片段取回（合并前的 probeNewIntent 独立
   * eval 已并入 buildProbeSource）。桥不可达时整个 probe 返 null；片段执行成功
   * 但三键缺省 → { modeId:'', profileId:'', confirmed:false }。
   */
  newIntent: NewIntentState
}

export interface CandidateProbeData {
  currentPageId: string
  design: DesignRootSnapshot | null
  brief: BriefLinkSnapshot | null
  materialized: boolean
}

export interface ActiveDesignBridgeIO {
  /**
   * 桥不可达 → null（调用方按空槽降级 + warn）。
   * P0-1：返值含 newIntent 三键（原独立 probeNewIntent 已并入本探针）。
   */
  probeSlot(documentId?: string, windowId?: string): Promise<SlotProbeData | null>
  probeCandidate(
    nodeId: string,
    documentId?: string,
    windowId?: string
  ): Promise<CandidateProbeData | null>
  /** nodeId '' = 清槽；桥不可达/执行失败 → false */
  writeSlot(nodeId: string, documentId?: string, windowId?: string): Promise<boolean>
  /**
   * T91b：setup_design 成功后清 document root pluginData 三键（避免下次
   * 装配误用旧 modeId）。桥不可达/执行失败 → false（不影响主流程——设计已落图）。
   */
  clearNewIntent(documentId?: string, windowId?: string): Promise<boolean>
}

/** T91b：pluginData 三键快照形状复用 brief.ts NewIntentState（避免双写） */

const K = ACTIVE_DESIGN_PROBE_KEYS

/**
 * 探针 eval 片段：只取裸数据（快照 + 页归属 + 物化判据原料 + newIntent 三键），
 * 判定在后端。P0-1：newIntent 三键并入本片段——原 probeNewIntent 独立 eval 撤销，
 * 每回合桥 eval 从 2 次减为 1 次。
 */
function buildProbeSource(candidateNodeId?: string): string {
  return `const NS = ${JSON.stringify(K.namespace)};
const CANDIDATE = ${JSON.stringify(candidateNodeId ?? '')};
const pageOf = (n) => { let cur = n; while (cur) { if (cur.type === 'CANVAS') return cur.id; cur = cur.parent; } return null; };
const snap = (id) => {
  const n = figma.getNodeById(id);
  if (!n) return null;
  return { nodeId: n.id, name: n.name, type: n.type, pageId: pageOf(n),
    marketingRoot: n.getSharedPluginData(NS, ${JSON.stringify(K.roleKey)}) === ${JSON.stringify(K.roleRoot)},
    modeId: n.getSharedPluginData(NS, ${JSON.stringify(K.modeKey)}),
    profileId: n.getSharedPluginData(NS, ${JSON.stringify(K.profileKey)}),
    briefId: n.getSharedPluginData(NS, ${JSON.stringify(K.briefKey)}),
    uniqueId: n.getSharedPluginData(NS, ${JSON.stringify(K.uniqueIdKey)}) };
};
const briefSnap = (briefId) => {
  if (!briefId) return null;
  // T91a 形态兼容：新文档 design.briefId 存 brief uniqueId（UUID v4）——先按
  // uniqueId 扫页级 brief（core listBriefs 同口径），落空回退节点 id 直查
  // （老文档残留形态）。只按 getNodeById 会让全部新文档 422 brief_mismatch。
  let b = null;
  for (const child of figma.currentPage.children) {
    if (child.getSharedPluginData(NS, ${JSON.stringify(K.roleKey)}) === ${JSON.stringify(K.roleBrief)} &&
        child.getSharedPluginData(NS, ${JSON.stringify(K.uniqueIdKey)}) === briefId) { b = child; break; }
  }
  if (!b) b = figma.getNodeById(briefId);
  if (!b || b.getSharedPluginData(NS, ${JSON.stringify(K.roleKey)}) !== ${JSON.stringify(K.roleBrief)}) return null;
  const raw = b.getSharedPluginData(NS, ${JSON.stringify(K.bindingKey)});
  return { briefId: b.id, pageId: pageOf(b), boundDesignIds: raw ? raw.split(',').filter(Boolean) : [] };
};
const hasMaterial = (rootId) => {
  const root = figma.getNodeById(rootId);
  if (!root) return false;
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if ((n.fills || []).some((f) => f.type === 'IMAGE')) return true;
    if (n.getSharedPluginData(NS, ${JSON.stringify(K.heroGeometryKey)})) return true;
    stack.push(...(n.children || []));
  }
  return false;
};
const currentPageId = figma.currentPage.id;
const slotNodeId = figma.root.getSharedPluginData(NS, ${JSON.stringify(K.slotKey)});
const targetId = CANDIDATE || slotNodeId;
const design = targetId ? snap(targetId) : null;
const brief = design ? briefSnap(design.briefId) : null;
// T91a：briefId 归一为节点 id（snapshotDesignRoot 同语义）——下游信封/响应沿用旧形态
if (design && brief) design.briefId = brief.briefId;
const newIntent = { modeId: figma.root.getSharedPluginData(NS, ${JSON.stringify(K.newIntentModeIdKey)}),
  profileId: figma.root.getSharedPluginData(NS, ${JSON.stringify(K.newIntentProfileIdKey)}),
  confirmed: figma.root.getSharedPluginData(NS, ${JSON.stringify(K.newIntentConfirmedKey)}) === 'true' };
return { slotNodeId, currentPageId, design, brief, materialized: design ? hasMaterial(design.nodeId) : false, newIntent };`
}

function buildWriteSlotSource(nodeId: string): string {
  return `figma.root.setSharedPluginData(${JSON.stringify(K.namespace)}, ${JSON.stringify(K.slotKey)}, ${JSON.stringify(nodeId)});
return { ok: true };`
}

/** T91b：探针 / 清键 桥 eval 片段共享的命名常量前缀 */
const NEW_INTENT_EVAL_PROLOGUE = (): string => {
  const NS = JSON.stringify(K.namespace)
  const M = JSON.stringify(K.newIntentModeIdKey)
  const P = JSON.stringify(K.newIntentProfileIdKey)
  const C = JSON.stringify(K.newIntentConfirmedKey)
  return `const NS = ${NS};
const M = ${M};
const P = ${P};
const C = ${C};`
}

/** T91b：清 document root 上 newIntent 三键（空串置位 = 读侧视为缺省） */
function buildClearNewIntentSource(): string {
  return `${NEW_INTENT_EVAL_PROLOGUE()}
figma.root.setSharedPluginData(NS, M, '');
figma.root.setSharedPluginData(NS, P, '');
figma.root.setSharedPluginData(NS, C, '');
return { ok: true };`
}

async function callBridgeEval(
  code: string,
  documentId?: string,
  windowId?: string
): Promise<unknown> {
  const discovery = await readDiscoveryFile()
  if (!discovery) throw new Error('bridge discovery missing')
  const args = documentId ? { code, document_id: documentId } : { code }
  const res = await postBridgeRPC(discovery, 'tool', { name: 'eval', args }, windowId)
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null
  if (!res.ok || body?.ok !== true) throw new Error(`bridge eval failed: HTTP ${res.status}`)
  return body.result ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseDesignSnapshot(raw: unknown): DesignRootSnapshot | null {
  if (!isRecord(raw)) return null
  if (typeof raw.nodeId !== 'string' || typeof raw.type !== 'string') return null
  return {
    nodeId: raw.nodeId,
    name: asString(raw.name),
    type: raw.type,
    pageId: typeof raw.pageId === 'string' ? raw.pageId : null,
    marketingRoot: raw.marketingRoot === true,
    modeId: asString(raw.modeId),
    profileId: asString(raw.profileId),
    briefId: asString(raw.briefId),
    uniqueId: asString(raw.uniqueId)
  }
}

function parseBriefSnapshot(raw: unknown): BriefLinkSnapshot | null {
  if (!isRecord(raw) || typeof raw.briefId !== 'string') return null
  return {
    briefId: raw.briefId,
    pageId: typeof raw.pageId === 'string' ? raw.pageId : null,
    boundDesignIds: Array.isArray(raw.boundDesignIds)
      ? raw.boundDesignIds.filter((id): id is string => typeof id === 'string')
      : []
  }
}

function parseNewIntent(raw: unknown): NewIntentState {
  if (!isRecord(raw)) return { modeId: '', profileId: '', confirmed: false }
  return {
    modeId: asString(raw.modeId),
    profileId: asString(raw.profileId),
    confirmed: raw.confirmed === true
  }
}

/** 生产桥实现：eval 探针/写槽；一切桥故障 → null/false（调用方定降级语义） */
/**
 * evalCode 可注入（默认走真桥 callBridgeEval）——测试借此把同一份生成的
 * eval 串在真实 store 上执行，覆盖「生成代码 × 真实数据形态」的接线面
 * （T91a UUID 迁移曾在此断裂且 mock 桥测不出来）。
 */
export function createBridgeSlotIO(
  evalCode: (
    code: string,
    documentId?: string,
    windowId?: string
  ) => Promise<unknown> = callBridgeEval
): ActiveDesignBridgeIO {
  async function probe(
    nodeId?: string,
    documentId?: string,
    windowId?: string
  ): Promise<SlotProbeData | null> {
    let raw: unknown
    try {
      raw = await evalCode(buildProbeSource(nodeId), documentId, windowId)
    } catch {
      return null
    }
    if (!isRecord(raw)) return null
    return {
      slotNodeId: asString(raw.slotNodeId),
      currentPageId: asString(raw.currentPageId),
      design: parseDesignSnapshot(raw.design),
      brief: parseBriefSnapshot(raw.brief),
      materialized: raw.materialized === true,
      newIntent: parseNewIntent(raw.newIntent)
    }
  }
  return {
    probeSlot: (documentId, windowId) => probe(undefined, documentId, windowId),
    probeCandidate: async (nodeId, documentId, windowId) => {
      const data = await probe(nodeId, documentId, windowId)
      if (!data) return null
      return {
        currentPageId: data.currentPageId,
        design: data.design,
        brief: data.brief,
        materialized: data.materialized
      }
    },
    writeSlot: async (nodeId, documentId, windowId) => {
      try {
        await evalCode(buildWriteSlotSource(nodeId), documentId, windowId)
        return true
      } catch {
        return false
      }
    },
    clearNewIntent: async (documentId, windowId) => {
      try {
        await evalCode(buildClearNewIntentSource(), documentId, windowId)
        return true
      } catch {
        return false
      }
    }
  }
}

// ── 宿主会话态（每 session 一份；formId 映射会话内不落盘）─────────────────────

/** 表单作答移槽的节点合法性（④）：存在 + 仍是设计区根框 + 同页（brief 可能已删，不作驳回依据） */
export function isFormTargetStillValid(probe: CandidateProbeData): boolean {
  const { design } = probe
  if (design === null) return false
  return design.marketingRoot && design.pageId !== null && design.pageId === probe.currentPageId
}

export interface ActiveDesignHostDeps {
  registry(): StudioRegistry
  bridge: ActiveDesignBridgeIO
}

export interface ActiveDesignHost {
  /** setup_design 注入缝真源：本回合新建意图旗标（run 结束 finalizeTurn 复位） */
  newIntentConfirmed(): boolean
  /** 工具结果观察：ask_user_question awaiting 信封 → 记录 formId→当时槽位 */
  observeToolExecution(toolName: string, isError: boolean, details: unknown): void
  /** 事件①：setup_design 成功（结果含新 root id）→ 移槽（失败只 warn，设计已建不回吐） */
  onDesignCreated(rootId: string, documentId?: string, windowId?: string): Promise<void>
  /** 回合入口：剥信封 → 置旗标 + 确认参数系统提示行（T65）→ ④移槽 → 槽位读穿/清悬空 → 组装 */
  prepareTurn(text: string, documentId?: string, windowId?: string): Promise<{ promptText: string }>
  /** before_agent_start 钩子读取的当回合组装结果（prepareTurn 后恒非空） */
  turnAssembly(): TurnAssembly | null
  /** run 结束 finally：旗标复位 + 回合态清零（信封永不跨回合滞留） */
  finalizeTurn(): void
}

export function createActiveDesignHost(deps: ActiveDesignHostDeps): ActiveDesignHost {
  let intentConfirmed = false
  let turn: TurnAssembly | null = null
  let currentSlotNodeId = ''
  const formDesignByFormId = new Map<string, string>()

  async function moveSlot(nodeId: string, documentId?: string, windowId?: string): Promise<void> {
    const ok = await deps.bridge.writeSlot(nodeId, documentId, windowId)
    if (ok) {
      currentSlotNodeId = nodeId
    } else {
      console.warn('[pi-backend] active_design 移槽写桥失败（忽略，下回合探针读穿为准）')
    }
  }

  async function resolveFormAnswer(
    text: string,
    documentId?: string,
    windowId?: string
  ): Promise<void> {
    const answer = parseAskAnswer(text)
    // 仅 [表单作答] 移槽（共享契约字面）；[表单跳过] 不构成目标授权
    if (!answer || answer.aborted) return
    const mapped = formDesignByFormId.get(answer.formId)
    if (!mapped) return // 刷新丢映射 → 事件④静默不发生（已知边界，T60-plan 定谳 2）
    const probe = await deps.bridge.probeCandidate(mapped, documentId, windowId)
    if (probe && isFormTargetStillValid(probe)) await moveSlot(mapped, documentId, windowId)
  }

  /**
   * 槽位读穿 + 本回合资产解析（P0-1）。
   *
   * 一次桥 eval 同时取回槽位快照与 newIntent 三键（原 probeSlot + probeNewIntent
   * 两次 eval 合并）。`intentConfirmed` 返值即 pluginData 侧确认旗标——prepareTurn
   * 与信封路径 OR 后作为 setup_design 守卫真源。
   */
  async function probeSlotState(
    envelopeIntent: NewIntentState | null,
    documentId?: string,
    windowId?: string
  ): Promise<{
    slot: TurnSlotState
    notices: string[]
    /** pluginData 侧 confirmed 旗标（桥不可达 → false，按未确认降级） */
    intentConfirmed: boolean
  }> {
    const probe = await deps.bridge.probeSlot(documentId, windowId)
    if (!probe) {
      console.warn(
        '[pi-backend] active_design 桥探针不可用——本回合按空槽组装（桥不可达或无活动文档）'
      )
      // 桥不可达但信封已带参数 → 仍按信封意图解析资产（Turn 1 不该退化成 base only）
      return {
        slot: resolveTurnAssets(deps.registry(), { status: 'empty' }, envelopeIntent),
        notices: [],
        intentConfirmed: false
      }
    }
    const evaluated = evaluateActiveDesignSlot(probe.slotNodeId, probe.design, probe.brief)
    // newIntent 优先级：信封（本回合一次性，最新）> pluginData 三键
    const intent = envelopeIntent && envelopeIntent.modeId !== '' ? envelopeIntent : probe.newIntent
    const intentConfirmed = probe.newIntent.confirmed
    if (evaluated.status !== 'dangling') {
      return {
        slot: resolveTurnAssets(deps.registry(), evaluated, intent),
        notices: [],
        intentConfirmed
      }
    }
    // 定谳 3：槽位节点删除/失格 → 清槽 + 一行系统提示
    await moveSlot('', documentId, windowId)
    return {
      slot: resolveTurnAssets(deps.registry(), { status: 'empty' }, intent),
      notices: [ACTIVE_DESIGN_TEXTS.slotCleared],
      intentConfirmed
    }
  }

  return {
    newIntentConfirmed: () => intentConfirmed,
    observeToolExecution(toolName, isError, details) {
      if (toolName !== 'ask_user_question' || isError || !isRecord(details)) return
      if (details.status !== 'awaiting_user' || typeof details.formId !== 'string') return
      formDesignByFormId.set(details.formId, currentSlotNodeId)
    },
    async onDesignCreated(rootId, documentId, windowId) {
      await moveSlot(rootId, documentId, windowId)
      // T91b：设计落图后清 document root pluginData 三键——避免下次装配读到
      // 旧 modeId 误用。失败仅 warn（设计已建不需回吐；下回合探针自然读空）
      await deps.bridge.clearNewIntent(documentId, windowId)
    },
    async prepareTurn(text, documentId, windowId) {
      // 回合开始强制清零（防御：finalizeTurn 遗漏也不跨回合滞留）
      intentConfirmed = false
      const { envelope, stripped } = stripNewIntentEnvelope(text)
      const intentNotices: string[] = []
      let envelopeIntent: NewIntentState | null = null
      if (envelope) {
        intentConfirmed = true
        // P0-1：信封参数同样参与资产解析（前端确认卡未写 pluginData 的兼容路径）
        envelopeIntent = {
          modeId: envelope.modeId ?? '',
          profileId: envelope.profileId ?? '',
          confirmed: true
        }
        // T65 集成缺口修复：确认参数随本回合 context 对 AI 可见（选择即锁定）；
        // 裸信封（无任何参数）不注入——无可锁定字段
        const confirmedLine = ACTIVE_DESIGN_TEXTS.newIntentConfirmed(envelope)
        if (confirmedLine !== '') intentNotices.push(confirmedLine)
      }
      await resolveFormAnswer(text, documentId, windowId)
      const {
        slot,
        notices,
        intentConfirmed: probeConfirmed
      } = await probeSlotState(envelopeIntent, documentId, windowId)
      // T91b：pluginData 探针确认（二级信源；前端 ChatNewIntentCard 确认后写入）。
      // OR 信封兼容路径——任一为真即放行。探针不可达按未确认降级。
      // 偏差说明（P0-1）：守卫旗标保留手动管理，不采文档建议的
      // `slot.status !== 'ok' && resolvedWorkflow != null` 派生式——裸信封、
      // modeId=general、slot=ok 的替换/新建议图三条路径下该派生式恒假，
      // 会把 setup_design 的 __confirmedNewIntent 守卫误关。
      if (!intentConfirmed && probeConfirmed) intentConfirmed = true
      currentSlotNodeId = slot.status === 'ok' ? slot.design.nodeId : ''
      turn = assembleTurn(deps.registry(), slot, [...intentNotices, ...notices])
      return { promptText: stripped }
    },
    turnAssembly: () => turn,
    finalizeTurn() {
      intentConfirmed = false
      turn = null
    }
  }
}

// ── 端点（②面板点选 / ③AI 声明+同意 共用）─────────────────────────────────────

export type SetActiveDesignResult =
  | {
      ok: true
      modeId: string
      profileId: string
      briefId: string
      name: string
      /** 物化判据结果（Case A/B 分叉数据，T61 消费；判据见 core active-design.ts 头注） */
      materialized: boolean
    }
  | { ok: false; error: ActiveDesignRejectReason | 'bridge_unavailable'; message: string }

/**
 * POST /api/pi/active-design 的处理本体：四条件校验 → 移槽 → 身份三元组。
 * documentId 缺省 = 桥当前活动 tab（同工具 document_id 缺省语义）。
 * T98-路由：windowId 透传——多窗时按发起窗路由探针/写槽，避免 A 窗操作串到 B 窗。
 */
export async function setActiveDesignViaBridge(
  nodeId: string,
  documentId?: string,
  bridge: ActiveDesignBridgeIO = createBridgeSlotIO(),
  windowId?: string
): Promise<SetActiveDesignResult> {
  const probe = await bridge.probeCandidate(nodeId, documentId, windowId)
  if (!probe) {
    return {
      ok: false,
      error: 'bridge_unavailable',
      message: '画布桥不可达——确认 dev server 已启动且浏览器已打开 app，然后重试。'
    }
  }
  const check = checkActiveDesignCandidate(nodeId, probe.design, probe.brief, probe.currentPageId)
  if (!check.ok) return { ok: false, error: check.reason, message: check.message }
  const moved = await bridge.writeSlot(nodeId, documentId, windowId)
  if (!moved) {
    return {
      ok: false,
      error: 'bridge_unavailable',
      message: '画布桥写槽失败——确认 dev server 已启动且浏览器已打开 app，然后重试。'
    }
  }
  return {
    ok: true,
    modeId: check.design.modeId,
    profileId: check.design.profileId,
    briefId: check.design.briefId,
    name: check.design.name,
    materialized: probe.materialized
  }
}

// ── 端点：newIntent 确认（T91b）──────────────────────────────────────────────

export type ConfirmNewIntentResult =
  | { ok: true; modeId: string; profileId: string }
  | { ok: false; error: 'bridge_unavailable' | 'invalid_args'; message: string }

/** T91b：写 document root sharedPluginData 三键（modeId / profileId / confirmed=true）。 */
function buildWriteNewIntentSource(modeId: string, profileId: string): string {
  return `const NS = ${JSON.stringify(K.namespace)};
const M = ${JSON.stringify(K.newIntentModeIdKey)};
const P = ${JSON.stringify(K.newIntentProfileIdKey)};
const C = ${JSON.stringify(K.newIntentConfirmedKey)};
figma.root.setSharedPluginData(NS, M, ${JSON.stringify(modeId)});
figma.root.setSharedPluginData(NS, P, ${JSON.stringify(profileId)});
figma.root.setSharedPluginData(NS, C, 'true');
return { ok: true };`
}

/**
 * POST /api/pi/intent-confirm 的处理本体：写 pluginData 三键（modeId /
 * profileId / confirmed=true）。前端 ChatNewIntentCard 确认按钮触发。
 * documentId 缺省 = 桥当前活动 tab（同工具 document_id 缺省语义）。
 * T98-路由：windowId 透传——按发起窗路由（多窗时只有目标窗的 pluginData 被写）。
 */
export async function confirmNewIntentViaBridge(
  args: { modeId: string; profileId?: string },
  documentId?: string,
  windowId?: string
): Promise<ConfirmNewIntentResult> {
  if (!args.modeId) {
    return { ok: false, error: 'invalid_args', message: 'modeId 不能为空' }
  }
  const profileId = args.profileId ?? ''
  try {
    const discovery = await readDiscoveryFile()
    if (!discovery) throw new Error('bridge discovery missing')
    const code = buildWriteNewIntentSource(args.modeId, profileId)
    const res = await postBridgeRPC(
      discovery,
      'tool',
      {
        name: 'eval',
        args: documentId ? { code, document_id: documentId } : { code }
      },
      windowId
    )
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
    if (!res.ok || body?.ok !== true) throw new Error(`bridge eval failed: HTTP ${res.status}`)
    return { ok: true, modeId: args.modeId, profileId }
  } catch {
    return {
      ok: false,
      error: 'bridge_unavailable',
      message: '画布桥不可达——确认 dev server 已启动且浏览器已打开 app，然后重试。'
    }
  }
}
