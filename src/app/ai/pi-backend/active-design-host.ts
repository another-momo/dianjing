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
 *    2026-09-21 owner 拍板统一限定形寻址：索引行恒带桶前缀（`base/<path>` /
 *    `workflow:<id>/<path>` / `profile:<id>/<path>`），agent 唯一寻址手段 =
 *    照抄行首 key；冲突机制整段删除（key 全串唯一不可能冲突，first-wins 静默
 *    误指随之消失；registry 侧的跨桶同名检测仍保留作作者面响亮信号）。
 *  - 新建意图一次性旗标：本回合 newIntentConfirmed() 返真 → run 结束
 *    finalizeTurn（runPrompt finally）强制复位。
 *    批 1 后（2026-09-21 D2/D3 拍板）：信封通道整段退役，确认参数只走
 *    POST /api/pi/intent-confirm 写 document root pluginData 四键；首回合
 *    锁定行注入由 intent-confirm 端点置「新鲜」标记驱动，下回合 prepareTurn
 *    消费即清——防止 F3 锁定行每回合复发。
 *  - 2026-09-27 sl-w2-state-chain（批 4 接线半）：probe 增 docUuid 字段，
 *    服务侧读 page-state 拿落点 / 规制标量；每回合恒注页身份行
 *    `[施工页 page=<id> 模式=<modeId/profileId> brief=<id|无>]`；
 *    视图页 ≠ 落点页时追加 `[你正在看第X页]` 差分行（视图页来自 probe 不钉页
 *    的活页读——与落点是两个事实）。具体接读详见 `TurnPageContext` 与
 *    `assembleTurn` 注入段；旧 bridge 写 pluginData 四键的通路仍保留为死码，
 *    待阶段 2 摘除。
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
import {
  ACTIVE_DESIGN_TEXTS,
  EMPTY_IDENTITY_DISPLAY,
  GENERAL_MODE_DISPLAY,
  IDENTITY_DIFF_SOURCES,
  type IdentityDiffSource
} from '@open-pencil/core/tools/fork/marketing/texts'

import { readDiscoveryFile } from '@/app/bridge/server/discovery'

import { postBridgeRPC } from './bridge-rpc'
import {
  referenceAddressPrefix,
  referenceBucketKey,
  type StudioBase,
  type StudioProfile,
  type StudioRegistry,
  type StudioWorkflow
} from './studio/types'

// ── 每回合组装（纯函数；base→workflow→profile 顺序固定，前缀缓存友好）─────────

export interface TurnAssembly {
  systemPrompt: string
  /** context 注入行（身份封套 + 系统提示）；空槽 → 空数组 */
  contextLines: string[]
  /**
   * T85 定谳 4：本回合 load_reference 允许集（限定形 key → 加载期解析绝对路径；
   * 空 = 本回合不可读任何 reference）。宿主持有于 turn 缓存袋，finalizeTurn
   * 随 turn=null 一并复位（同 intentConfirmed 一次性态纪律）。
   * 2026-09-21：key 形态恒为 `base/<path>` / `workflow:<id>/<path>` /
   * `profile:<id>/<path>`——base 桶特判 `base`，workflow/profile 保留 `${kind}:${id}`，
   * 与索引节渲染同源（`referenceAddressPrefix` 单源），见 types.ts。
   */
  allowedReferences: ReadonlyMap<string, string>
}

/** 索引节标题（T85 定谳 3 字面口径；P2-3 同步工具名） */
const REFERENCES_INDEX_HEADING = '## 按需参考（load_reference 工具按需读取）'

/**
 * 2026-09-27 sl-w2-state-chain：本回合页身份上下文（agent 可见的「在何处按
 * 什么规制施工」事实行）——来源 = page-state 标量（落点 + 规制）+ probe
 * 一次不钉页活页读（视图页）。落点冻结值与视图页是两个事实：落点是确认
 * 拦截门写回 / 初始化写回的事实值（恒 == 视图页或被用户改写过）；视图页
 * 是用户在浏览器里正在浏览的页（run 起始时刻取一次）。
 *
 * 字段全集可空 / 「无」字面量：
 *  - engagedPageId = 落点页 id；空 = 未初始化（首跑 / 腐烂）
 *  - modeId = 规制模式 id；空 = 未绑规制
 *  - profileId = 规制风格档案 id；空 = 未绑风格或 modeId 命中 general
 *  - briefId = 当前施工面关联的需求单 id；空 = 无设计区 / 无需求单
 *  - viewPageId = 视图页 id（不钉页活页读）；空 = 桥不可达 / 无 tab
 */
export interface TurnPageContext {
  engagedPageId: string | null
  modeId: string | null
  profileId: string | null
  briefId: string | null
  viewPageId: string | null
}

/** `[施工页 page=<id|无> 模式=<modeId|无>/<profileId|无> brief=<id|无>]` —— 恒在注入行。
 *
 * 模式 = page-state.modeId / profileId（缺省 `无`，与缺省链兜底对齐——modeId
 * 未绑 = `无`/`无`，profileId 未绑 = 留 `无`）。落点页与需求单同理：未初始化
 * / 无关联 = `无`。Agent 看到的就是事实行——以 id 维稳，不混入展示语。 */
function buildConstructionPageLine(ctx: TurnPageContext): string {
  const page = ctx.engagedPageId ?? '无'
  const mode = ctx.modeId ?? '无'
  const profile = ctx.profileId ?? '无'
  const brief = ctx.briefId ?? '无'
  return `[施工页 page=${page} 模式=${mode}/${profile} brief=${brief}]`
}

/** `[你正在看第<viewPageId>页]` 差分行——视图页 ≠ 落点页时追加。两事实均
 *  非空才生效；任一空 = 不注（首跑 / 桥不可达场景）。 */
function buildViewPageDiffLine(
  viewPageId: string | null,
  engagedPageId: string | null
): string | null {
  if (!viewPageId || !engagedPageId) return null
  if (viewPageId === engagedPageId) return null
  return `[你正在看第${viewPageId}页]`
}

/** 索引节下首行操作指令——agent 照抄行首 key 即唯一寻址手段（2026-09-21 owner 拍板加注） */
const REFERENCES_INDEX_INSTRUCTION = 'path 参数 = 照抄下行行首 key（含桶前缀）'

/** 限定形寻址 key：`referenceAddressPrefix(kind, id) + '/' + path`（types.ts 单源；
 *  base 桶特判 `base`，workflow/profile 桶 `${kind}:${id}`）。agent 唯一寻址手段。 */
function qualifiedReferenceKey(
  kind: 'base' | 'workflow' | 'profile',
  id: string,
  path: string
): string {
  return `${referenceAddressPrefix(kind, id)}/${path}`
}

/** 本回合 active 资产的 references 并集：base 恒在 + 命中的 workflow + 命中的 profile。
 *
 * 2026-09-21 owner 拍板：统一限定形寻址（agent 侧只剩一条规则——照抄索引行首 key）。
 * 索引行恒带桶前缀（`base/<path>` / `workflow:<id>/<path>` / `profile:<id>/<path>`），
 * key 全串唯一，不可能跨桶同名冲突——first-wins 静默误指随之消失。允许集同样只登
 * 记限定 key，Map 天然去重覆盖同桶同名 path 重复声明。
 */
function collectActiveReferences(
  registry: StudioRegistry,
  assets: Array<StudioBase | StudioWorkflow | StudioProfile>
): { indexSection: string; allowed: Map<string, string> } {
  const lines: string[] = []
  const allowed = new Map<string, string>()
  for (const asset of assets) {
    if (!asset.references || asset.references.length === 0) continue
    const bucket = registry.resolvedReferences.get(referenceBucketKey(asset.kind, asset.id))
    for (const ref of asset.references) {
      const abs = bucket?.get(ref.path)
      if (!abs) continue
      const qualified = qualifiedReferenceKey(asset.kind, asset.id, ref.path)
      // 同桶同名 path 重复声明：Map 天然去重 + 渲染侧保留全部条目（资产作者面可见）
      lines.push(`- ${qualified} —— ${ref.description}`)
      if (!allowed.has(qualified)) allowed.set(qualified, abs)
    }
  }
  if (lines.length === 0) return { indexSection: '', allowed }
  return {
    indexSection: `${REFERENCES_INDEX_HEADING}\n${REFERENCES_INDEX_INSTRUCTION}\n${lines.join('\n')}`,
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
 *  给用户，且 id 不稳定）。setup_design 守卫只依赖 document root pluginData
 *  四键 + args.confirmedNewIntent（批 1 后不再读用户消息首行信封）。 */
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
 *  - 2026-09-21 统一限定形寻址：索引行恒带桶前缀（`base/<path>` /
 *    `workflow:<id>/<path>` / `profile:<id>/<path>`），agent 唯一寻址手段 = 照抄
 *    行首 key；冲突机制整段删除（key 全串唯一不可能冲突，first-wins 静默误指
 *    随之消失；registry 侧的跨桶同名检测仍保留作作者面响亮信号）
 *  - A3 B7：各段带来源头行——非空段前冠 `# studio base` / `# workflow: <id>` /
 *    `# profile: <id>`（asset.kind + asset.id，collectActiveReferences 同款）；
 *    空段不冠头（joinSegments 滤空串语义不变）。Agent 可机械分辨当前注入构成——
 *    不见 workflow 行即通用模式（与 base.md 真源教学段互锁）。
 *  - 2026-09-27 sl-w2-state-chain：pageContext 恒在首行——「[施工页
 *    page=… 模式=… brief=…]」行 + 可选「[你正在看第X页]」差分行。
 *    两行位于 identity 封套与 extraNotices 之前，确保事实行永远在
 *    观察行（封套）+ 一次性旗标（D3 锁定行）+ 系统提示行（悬空 /
 *    workflowMissing）之前——事实 → 观察 → 提示 的注入序。
 */
export function assembleTurn(
  registry: StudioRegistry,
  slot: TurnSlotState,
  pageContext: TurnPageContext,
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
  // A3 B7：非空段前冠来源头；空段不冠头——joinSegments 仍按 \n\n 拼接
  const segments = [
    base !== '' ? `# studio base\n${base}` : '',
    resolvedWorkflow && resolvedWorkflow.body !== ''
      ? `# workflow: ${resolvedWorkflow.id}\n${resolvedWorkflow.body}`
      : '',
    resolvedProfile && resolvedProfile.body !== ''
      ? `# profile: ${resolvedProfile.id}\n${resolvedProfile.body}`
      : ''
  ]

  const contextLines: string[] = []
  contextLines.push(buildConstructionPageLine(pageContext))
  const viewDiff = buildViewPageDiffLine(pageContext.viewPageId, pageContext.engagedPageId)
  if (viewDiff) contextLines.push(viewDiff)
  if (slot.status === 'ok') contextLines.push(designTargetEnvelope(slot.design))
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
 * 优先级 **page-state > newIntent > slot**（2026-09-27 sl-w2-state-chain 批 4
 * 接线半——规制真源迁移到 page-state 标量）：
 *  1. page-state 有值（modeId 非空）→ 用 page-state.modeId/profileId 解析
 *  2. 否则 `newIntent.confirmed && newIntent.modeId` → 用 pluginData 四键解析
 *  3. 否则按 slot.design 落盘三元组解析（旧帧身份，向后兼容过渡）
 *  4. 全空 → base only（空槽语义）
 *
 * workflow 缺失语义（沿用 T60 定谳）：modeId 非空但 registry 未命中 workflow
 * → workflowMissingModeId 置位 + **profile 不注入**（按 base only 组装，避免
 * profile 规则悬空执行）。
 *
 * general 兼容行：A3 方案取消 general 的 workflow 身份（`studio/workflows/general/`
 * 已删除）。general 是无 workflow 的纯槽位标识——跳过 registry 查表、不置
 * workflowMissingModeId；profile 通道独立于 workflow（profileMatches 逻辑不动）。
 * 旧 general 槽位文档继续工作：base only + 身份封套 + profile（若有）。
 *
 * 阶段 2：page-state 单源后，`fallbackNewIntent` 与 `slot.design.modeId/profileId`
 * 两条回退路径删除；本阶段保留作为无 page-state 时的兜底（首跑 + 桥不可达
 * 场景）。
 */
/**
 * 规制来源取值（page-state > newIntent > slot 帧身份，逐段提前返回摊派
 * resolveTurnAssets 复杂度）。返回空串 modeId = 全空（空槽语义）。
 */
function resolveRegulationSource(
  slot: ActiveDesignSlotState,
  pageState: { modeId: string | null; profileId: string | null } | null,
  fallbackNewIntent: NewIntentState | null
): { modeId: string; profileId: string } {
  const pageModeId = pageState?.modeId ?? ''
  if (pageModeId !== '') {
    return { modeId: pageModeId, profileId: pageState?.profileId ?? '' }
  }
  if (fallbackNewIntent?.confirmed === true && fallbackNewIntent.modeId !== '') {
    return { modeId: fallbackNewIntent.modeId, profileId: fallbackNewIntent.profileId }
  }
  return {
    modeId: slot.status === 'ok' ? slot.design.modeId : '',
    profileId: slot.status === 'ok' ? slot.design.profileId : ''
  }
}

export function resolveTurnAssets(
  registry: StudioRegistry,
  slot: ActiveDesignSlotState,
  pageState: { modeId: string | null; profileId: string | null } | null,
  fallbackNewIntent: NewIntentState | null
): TurnSlotState {
  const { modeId, profileId } = resolveRegulationSource(slot, pageState, fallbackNewIntent)
  if (modeId === '') return slot
  const profile = profileId === '' ? undefined : registry.profiles.get(profileId)
  // general 跳过 workflow 查表——纯槽位标识，不命中即合规（base only 组装）
  if (modeId === 'general') {
    const profileMatches = profile
      ? profile.modes.length === 0 || profile.modes.includes(modeId)
      : true
    return {
      ...slot,
      ...(profile && profileMatches ? { resolvedProfile: profile } : {})
    }
  }
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
  /**
   * P0-1：newIntent 三键随槽位探针同片段取回（合并前的 probeNewIntent 独立
   * eval 已并入 buildProbeSource）。桥不可达时整个 probe 返 null；片段执行成功
   * 但三键缺省 → { modeId:'', profileId:'', confirmed:false }。
   */
  newIntent: NewIntentState
  /**
   * 2026-09-27 sl-w2-state-chain：document root `openpencil.ai/docId` 条目读出的
   * 文档 UUID——page-state 与 session 索引皆以此键控；run 起始服务侧据此读
   * page-state 拿落点 / 规制标量；空串 = 文档尚未铸造 uuid（首跑 / 桥不可达
   * 子集情形）。该字段不参与组装判定，仅作为上层「是否做 page-state 读写」
   * 的依据。
   */
  docUuid: string
}

export interface CandidateProbeData {
  currentPageId: string
  design: DesignRootSnapshot | null
  brief: BriefLinkSnapshot | null
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
 * 探针 eval 片段：只取裸数据（快照 + 页归属 + newIntent 四键 + docUuid），判定在后端。
 * C1：物化判据已随 A3/C1 退役——不再下发 hasMaterial helper 与 materialized 字段。
 * P0-1：newIntent 三键并入本片段——原 probeNewIntent 独立 eval 撤销，
 * 每回合桥 eval 从 2 次减为 1 次。
 * 2026-09-27 sl-w2-state-chain：docUuid（document root `openpencil.ai/docId` 条目
 * 值）并入——服务侧以此为键读 page-state 与会话索引。
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
const currentPageId = figma.currentPage.id;
const slotNodeId = figma.root.getSharedPluginData(NS, ${JSON.stringify(K.slotKey)});
const targetId = CANDIDATE || slotNodeId;
const design = targetId ? snap(targetId) : null;
const brief = design ? briefSnap(design.briefId) : null;
// T91a：briefId 归一为节点 id（snapshotDesignRoot 同语义）——下游信封/响应沿用旧形态
if (design && brief) design.briefId = brief.briefId;
const newIntent = { modeId: figma.root.getSharedPluginData(NS, ${JSON.stringify(K.newIntentModeIdKey)}),
  profileId: figma.root.getSharedPluginData(NS, ${JSON.stringify(K.newIntentProfileIdKey)}),
  confirmed: figma.root.getSharedPluginData(NS, ${JSON.stringify(K.newIntentConfirmedKey)}) === 'true',
  canvas: figma.root.getSharedPluginData(NS, ${JSON.stringify(K.newIntentCanvasKey)}) || '' };
// 2026-09-27 sl-w2-state-chain：document root 上的 docUuid 条目（与前端
// document-key.ts PI_DOC_NAMESPACE / PI_DOC_ENTRY_KEY 同源）——page-state 与
// 会话索引皆以此键控；空串 = 文档尚未铸造 uuid（首跑 / 根 pluginData 被导入
// 覆盖窗口），上层据此跳过 page-state 读写。
const docUuid = figma.root.getSharedPluginData('openpencil.ai', 'openpencil.ai/docId') || '';
return { slotNodeId, currentPageId, docUuid, design, brief, newIntent };`
}

function buildWriteSlotSource(nodeId: string): string {
  return `figma.root.setSharedPluginData(${JSON.stringify(K.namespace)}, ${JSON.stringify(K.slotKey)}, ${JSON.stringify(nodeId)});
return { ok: true };`
}

/** T91b：探针 / 清键 桥 eval 片段共享的命名常量前缀（A3 扩四键：新增 canvas） */
const NEW_INTENT_EVAL_PROLOGUE = (): string => {
  const NS = JSON.stringify(K.namespace)
  const M = JSON.stringify(K.newIntentModeIdKey)
  const P = JSON.stringify(K.newIntentProfileIdKey)
  const C = JSON.stringify(K.newIntentConfirmedKey)
  const V = JSON.stringify(K.newIntentCanvasKey)
  return `const NS = ${NS};
const M = ${M};
const P = ${P};
const C = ${C};
const V = ${V};`
}

/** T91b：清 document root 上 newIntent 四键（空串置位 = 读侧视为缺省） */
function buildClearNewIntentSource(): string {
  return `${NEW_INTENT_EVAL_PROLOGUE()}
figma.root.setSharedPluginData(NS, M, '');
figma.root.setSharedPluginData(NS, P, '');
figma.root.setSharedPluginData(NS, C, '');
figma.root.setSharedPluginData(NS, V, '');
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
  if (!isRecord(raw)) return { modeId: '', profileId: '', confirmed: false, canvas: '' }
  return {
    modeId: asString(raw.modeId),
    profileId: asString(raw.profileId),
    confirmed: raw.confirmed === true,
    canvas: asString(raw.canvas)
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
      newIntent: parseNewIntent(raw.newIntent),
      docUuid: asString(raw.docUuid)
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
        brief: data.brief
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

// ── A3：身份差分（B3）——装配后取生效身份，与上回合闭包 diff ────────────────

/** 装配后生效身份（resolveTurnAssets 解析后的 modeId+profileId 二元组） */
function effectiveIdentity(
  slot: TurnSlotState,
  probeIntent: NewIntentState | null,
  pageContext: TurnPageContext
): { modeId: string; profileId: string } {
  // 2026-09-27 sl-w2-state-chain：page-state 标量优先（与 resolveTurnAssets
  // 同构），fallback = probeIntent，末位 = slot 帧身份。空串 = 空身份。
  if (pageContext.modeId !== null && pageContext.modeId !== '') {
    return { modeId: pageContext.modeId, profileId: pageContext.profileId ?? '' }
  }
  if (probeIntent?.confirmed && probeIntent.modeId !== '') {
    return { modeId: probeIntent.modeId, profileId: probeIntent.profileId }
  }
  if (slot.status === 'ok') {
    return { modeId: slot.design.modeId, profileId: slot.design.profileId }
  }
  return { modeId: '', profileId: '' }
}

function identityChanged(
  a: { modeId: string; profileId: string },
  b: { modeId: string; profileId: string }
): boolean {
  return a.modeId !== b.modeId || a.profileId !== b.profileId
}

/** X/Y 侧 modeId 显示值：空身份与 general 各有固定措辞，其余原样透出。 */
function identityModeDisplay(modeId: string): string {
  if (modeId === '') return EMPTY_IDENTITY_DISPLAY
  if (modeId === 'general') return GENERAL_MODE_DISPLAY
  return modeId
}

/** 渲染身份差分通知文案。Y=general 表述为「通用（无专项流程，走基础路由）」；
 *  X=空身份（首回合后从空槽到有身份）表述为「通用」同理处理。 */
function buildIdentityDiffNotice(
  prev: { modeId: string; profileId: string },
  curr: { modeId: string; profileId: string },
  source: string
): string {
  const modeChanged = prev.modeId !== curr.modeId
  const xModeDisplay = identityModeDisplay(prev.modeId)
  const yModeDisplay = identityModeDisplay(curr.modeId)
  if (modeChanged) {
    return ACTIVE_DESIGN_TEXTS.modeSwitchedNotice(xModeDisplay, yModeDisplay, source)
  }
  if (prev.profileId !== curr.profileId) {
    return ACTIVE_DESIGN_TEXTS.profileSwitchedNotice(prev.profileId, curr.profileId, source)
  }
  return ''
}

/** B2.③：参数锁定行注入——intent 任一源（信封 / pluginData 探针）确认后构
 *  confirmedLine 推入 notices。两路径共用同一注入体，行为归一、不重复注入。 */
function pushConfirmedIntentLine(notices: string[], intent: NewIntentState): void {
  const confirmedLine = ACTIVE_DESIGN_TEXTS.newIntentConfirmed({
    modeId: intent.modeId || undefined,
    profileId: intent.profileId || undefined,
    canvas: intent.canvas || undefined
  })
  if (confirmedLine !== '') notices.push(confirmedLine)
}

export interface ActiveDesignHostDeps {
  registry(): StudioRegistry
  bridge: ActiveDesignBridgeIO
  /**
   * 2026-09-27 sl-w2-state-chain：page-state 标量读取器——按 docUuid 读
   * 文档级规制（modeId / profileId）+ 落点（engagedPageId）。无 docUuid
   * （首跑 / 桥不可达）或文件缺失 / 腐烂 → 返 null，host 兜底走
   * fallbackNewIntent + slot 帧身份。注入式参数（测试纪律：禁读真实 env /
   * 进程全局走参数）。
   */
  pageStateReader: (
    docUuid: string
  ) => { modeId: string | null; profileId: string | null; engagedPageId: string | null } | null
}

export interface ActiveDesignHost {
  /** setup_design 注入缝真源：本回合新建意图旗标（run 结束 finalizeTurn 复位） */
  newIntentConfirmed(): boolean
  /** 工具结果观察：ask_user_question awaiting 信封 → 记录 formId→当时槽位
   *  2026-09-15：详情 status='answered' 且 formId 命中映射 → 按合法性检查移槽后
   *  delete 该 formId 映射（与 awaiting envelope 同判据复用 isFormTargetStillValid） */
  observeToolExecution(toolName: string, isError: boolean, details: unknown): void
  /** 事件①：setup_design 成功（结果含新 root id）→ 移槽（失败只 warn，设计已建不回吐） */
  onDesignCreated(rootId: string, documentId?: string, windowId?: string): Promise<void>
  /** A3：B3 触发源标定——set_active_design 同意切换成功（service 在写槽前调） */
  onSlotSwitchedViaBridge(): void
  /** 2026-09-15：ask_user_question 挂起期注册回调——工具 register 成功即记
   *  formId→当时 currentSlotNodeId（与 awaiting envelope 路径等价但触发时点
   *  提前到挂起完成前，answer envelope 不再走聊天回流路径） */
  recordAskForm(formId: string): void
  /** D3 锁定行只注一次：intent-confirm 端点调 confirmNewIntent 成功后置标记——
   *  下回合 prepareTurn 注入确认参数行后即消费；防止 pluginData.confirmed
   *  持久态下锁定行每回合复发。多次 confirm 重复置位（last-write-wins） */
  markNewIntentFresh(): void
  /** 回合入口：移槽（formAnswer）→ 槽位读穿/清悬空 → 资产解析 → 新鲜锁定行消费 → 组装 */
  prepareTurn(text: string, documentId?: string, windowId?: string): Promise<{ promptText: string }>
  /** before_agent_start 钩子读取的当回合组装结果（prepareTurn 后恒非空） */
  turnAssembly(): TurnAssembly | null
  /** run 结束 finally：旗标复位 + 回合态清零（freshIntent 不清——见 markNewIntentFresh 注释） */
  finalizeTurn(): void
}

export function createActiveDesignHost(deps: ActiveDesignHostDeps): ActiveDesignHost {
  let intentConfirmed = false
  let turn: TurnAssembly | null = null
  let currentSlotNodeId = ''
  const formDesignByFormId = new Map<string, string>()
  // A3：身份差分通知（B3）——闭包记录上回合解析身份 + 触发源短时记忆。
  // 首回合（lastIdentity === null）不注入通知；其余回合在资产解析后 diff。
  // 触发源闭包旗标：即用即清——setActiveDesignViaBridge / onDesignCreated /
  // probeConfirmed 任意其一标定本回合触发源；首注即用即清。
  let lastIdentity: { modeId: string; profileId: string } | null = null
  let pendingSource: IdentityDiffSource | null = null
  // D3 锁定行只注一次：intent-confirm 端点置位、prepareTurn 消费即清；
  // 不在 finalizeTurn 清（端点跨 run 边界调用，与 finalize 同处一 run）；
  // 用户连续多回合只在 confirm 后的下一回合看到锁定行。
  let freshIntent = false

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
   * 一次桥 eval 同时取回槽位快照 + newIntent 四键 + docUuid（原 probeSlot
   * + probeNewIntent 两次 eval 合并）。`intentConfirmed` 返值即 pluginData 侧
   * 确认旗标——prepareTurn 直接取作用为 setup_design 守卫真源。
   *
   * 批 1 后（2026-09-21 D2/D3 拍板）：信封通道整段退役，asset 解析主路 =
   * page-state 标量（probe.docUuid 解析得到），fallbackNewIntent + slot 帧身份
   * 留作无 page-state 时的兜底（首跑 / 腐烂 / 桥不可达）。
   */
  async function probeSlotState(
    documentId?: string,
    windowId?: string
  ): Promise<{
    slot: TurnSlotState
    notices: string[]
    /** pluginData 侧 confirmed 旗标（桥不可达 → false，按未确认降级） */
    intentConfirmed: boolean
    /** 探针 newIntent 原始快照（B2.③：参数锁定行持久路径行为归一源） */
    probeIntent: NewIntentState | null
    /** 2026-09-27 sl-w2-state-chain：本回合页身份上下文——落点 + 模式 + brief
     *  + 视图页，恒在注入行的数据源。probe 不可达时全空。 */
    pageContext: TurnPageContext
  }> {
    const probe = await deps.bridge.probeSlot(documentId, windowId)
    if (!probe) {
      console.warn(
        '[pi-backend] active_design 桥探针不可用——本回合按空槽组装（桥不可达或无活动文档）'
      )
      return {
        slot: resolveTurnAssets(deps.registry(), { status: 'empty' }, null, null),
        notices: [],
        intentConfirmed: false,
        probeIntent: null,
        pageContext: {
          engagedPageId: null,
          modeId: null,
          profileId: null,
          briefId: null,
          viewPageId: null
        }
      }
    }
    const evaluated = evaluateActiveDesignSlot(probe.slotNodeId, probe.design, probe.brief)
    const intentConfirmed = probe.newIntent.confirmed
    const pageState = probe.docUuid ? deps.pageStateReader(probe.docUuid) : null
    // 规制输入（resolveTurnAssets 只看 modeId / profileId，落点不进资产解析）
    const pageStateRegulation = pageState
      ? { modeId: pageState.modeId, profileId: pageState.profileId }
      : null
    const slotBriefId = evaluated.status === 'ok' ? evaluated.design.briefId : ''
    const pageContext: TurnPageContext = {
      // 2026-09-27 sl-w2-state-chain：落点标量来自 page-state；空 = 首跑 /
      // 腐烂 / 未初始化。视图页 = probe 一次不钉页活页读（与落点是两个事实）。
      engagedPageId: pageState?.engagedPageId ?? null,
      modeId: pageState?.modeId ?? null,
      profileId: pageState?.profileId ?? null,
      briefId: slotBriefId || null,
      viewPageId: probe.currentPageId || null
    }
    if (evaluated.status !== 'dangling') {
      return {
        slot: resolveTurnAssets(deps.registry(), evaluated, pageStateRegulation, probe.newIntent),
        notices: [],
        intentConfirmed,
        probeIntent: probe.newIntent,
        pageContext
      }
    }
    // 定谳 3：槽位节点删除/失格 → 清槽 + 一行系统提示
    await moveSlot('', documentId, windowId)
    return {
      slot: resolveTurnAssets(
        deps.registry(),
        { status: 'empty' },
        pageStateRegulation,
        probe.newIntent
      ),
      notices: [ACTIVE_DESIGN_TEXTS.slotCleared],
      intentConfirmed,
      probeIntent: probe.newIntent,
      pageContext
    }
  }

  return {
    newIntentConfirmed: () => intentConfirmed,
    observeToolExecution(toolName, isError, details) {
      if (toolName !== 'ask_user_question' || isError || !isRecord(details)) return
      // 2026-09-15：新流 awaiting envelope 不再触发（execute register 已在
      // recordAskForm 提前记录）——保留 awaiting 观察点是为降级兼容（若旧
      // 版本前端/后端混搭仍可能命中）
      if (details.status === 'awaiting_user' && typeof details.formId === 'string') {
        formDesignByFormId.set(details.formId, currentSlotNodeId)
        return
      }
      // 新流：answered 结果点移槽——formId 命中映射 → 合法性检查 → 移槽 → 清 newIntent → 删映射
      // 异步移槽无法 await（observeToolExecution 同步契约）；fire-and-forget，
      // 失败仅 warn，桥不可达按降级（不移槽——下回合探针读穿为准）
      // D3（批 1 后）：移槽清键——answered 路径是显式移槽，意图即视为落定
      if (details.status === 'answered' && typeof details.formId === 'string') {
        const formId = details.formId
        const mapped = formDesignByFormId.get(formId)
        formDesignByFormId.delete(formId)
        if (!mapped) return
        void (async () => {
          const probe = await deps.bridge.probeCandidate(mapped)
          if (probe && isFormTargetStillValid(probe)) {
            await moveSlot(mapped)
            await deps.bridge.clearNewIntent()
          }
        })().catch((error: unknown) => {
          console.warn(
            '[active-design-host] 表单作答结果点移槽失败（降级不移槽）：' +
              (error instanceof Error ? error.message : String(error))
          )
        })
      }
    },
    recordAskForm(formId) {
      formDesignByFormId.set(formId, currentSlotNodeId)
    },
    async onDesignCreated(rootId, documentId, windowId) {
      await moveSlot(rootId, documentId, windowId)
      // T91b：设计落图后清 document root pluginData 三键——避免下次装配读到
      // 旧 modeId 误用。失败仅 warn（设计已建不需回吐；下回合探针自然读空）
      await deps.bridge.clearNewIntent(documentId, windowId)
      // A3：身份差分通知（B3）触发源标定——落图是合法触发源（B6 静默建通用
      // 工作区移槽产生真实 diff，与通知行触发源清单「新设计落图」一致）
      pendingSource = IDENTITY_DIFF_SOURCES.newDesignCreated
    },
    onSlotSwitchedViaBridge() {
      // A3：B3 触发源标定——set_active_design 同意切换成功（service 端点 200 后调）
      pendingSource = IDENTITY_DIFF_SOURCES.userAgreedSwitch
    },
    async prepareTurn(text, documentId, windowId) {
      // 回合开始强制清零（防御：finalizeTurn 遗漏也不跨回合滞留）
      intentConfirmed = false
      const intentNotices: string[] = []
      await resolveFormAnswer(text, documentId, windowId)
      const {
        slot,
        notices,
        intentConfirmed: probeConfirmed,
        probeIntent,
        pageContext
      } = await probeSlotState(documentId, windowId)
      // T91b：pluginData 探针确认是 setup_design 守卫真源（批 1 后信封通道退役，
      // 不再有 envelope 兼容路径）。守卫旗标保留手动管理，不采文档建议的
      // `slot.status !== 'ok' && resolvedWorkflow != null` 派生式——纯 general
      // 静默放行路径下该派生式恒假，会把 setup_design 的 __confirmedNewIntent
      // 守卫误关。
      if (probeConfirmed) intentConfirmed = true
      // D3 锁定行只注一次：pluginData 已确认 + 本会话 fresh 标记在位 → 注一行
      // 参数锁定行 + 触发源标定 + 立即消费（防止 pluginData 持久态下每回合复发）
      if (probeConfirmed && probeIntent && freshIntent) {
        pushConfirmedIntentLine(intentNotices, probeIntent)
        // A3：B3 触发源标定——fresh 路径 = 用户确认新建（pluginData 持久态亦归此类）
        pendingSource = IDENTITY_DIFF_SOURCES.userConfirmedNew
        freshIntent = false
      }
      currentSlotNodeId = slot.status === 'ok' ? slot.design.nodeId : ''
      // A3：B3 身份差分——装配后取生效身份（page-state 标量优先 → probeIntent
      // → slot 帧身份；与 resolveTurnAssets 优先级同构）。首回合 lastIdentity
      // === null → 不注入。
      const effective = effectiveIdentity(slot, probeIntent, pageContext)
      const identityNotices: string[] = []
      if (lastIdentity !== null && identityChanged(lastIdentity, effective)) {
        const source = pendingSource ?? IDENTITY_DIFF_SOURCES.externalChange
        const notice = buildIdentityDiffNotice(lastIdentity, effective, source)
        if (notice !== '') identityNotices.push(notice)
      }
      // 即用即清（首注即清；无 diff 不读、不延后至下回合）
      pendingSource = null
      lastIdentity = effective
      turn = assembleTurn(deps.registry(), slot, pageContext, [
        ...intentNotices,
        ...identityNotices,
        ...notices
      ])
      return { promptText: text }
    },
    turnAssembly: () => turn,
    finalizeTurn() {
      intentConfirmed = false
      turn = null
    },
    markNewIntentFresh() {
      freshIntent = true
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
    }
  | { ok: false; error: ActiveDesignRejectReason | 'bridge_unavailable'; message: string }

/**
 * POST /api/pi/active-design 的处理本体：四条件校验 → 移槽 → 清 newIntent → 身份三元组。
 * documentId 缺省 = 桥当前活动 tab（同工具 document_id 缺省语义）。
 * T98-路由：windowId 透传——多窗时按发起窗路由探针/写槽，避免 A 窗操作串到 B 窗。
 * D3（批 1 后）：移槽成功即清 document root newIntent 四键——面板「设为当前」
 * 与同意卡共用此收口点；显式移槽走完意图即视为落定，避免 confirmed=true 长期残留
 * 与新槽身份不一致（intent > slot 优先级把陈旧意图压过真实槽位）。失败仅 warn：
 * 下回合探针读穿为准，不影响主流程。
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
  // D3 移槽清键：与 onDesignCreated 同律——避免 confirmed=true 残留与新槽身份不一致
  await bridge.clearNewIntent(documentId, windowId)
  return {
    ok: true,
    modeId: check.design.modeId,
    profileId: check.design.profileId,
    briefId: check.design.briefId,
    name: check.design.name
  }
}

// ── 端点：newIntent 确认（T91b）──────────────────────────────────────────────

export type ConfirmNewIntentResult =
  | { ok: true; modeId: string; profileId: string; canvas: string }
  | { ok: false; error: 'bridge_unavailable' | 'invalid_args'; message: string }

/** T91b：写 document root sharedPluginData 四键（modeId / profileId / confirmed=true / canvas）。
 * A3 方案：canvas 与其他三键同持久化（确认意图本就该持久至落图/被覆盖——§2.2）。 */
function buildWriteNewIntentSource(modeId: string, profileId: string, canvas: string): string {
  return `const NS = ${JSON.stringify(K.namespace)};
const M = ${JSON.stringify(K.newIntentModeIdKey)};
const P = ${JSON.stringify(K.newIntentProfileIdKey)};
const C = ${JSON.stringify(K.newIntentConfirmedKey)};
const V = ${JSON.stringify(K.newIntentCanvasKey)};
figma.root.setSharedPluginData(NS, M, ${JSON.stringify(modeId)});
figma.root.setSharedPluginData(NS, P, ${JSON.stringify(profileId)});
figma.root.setSharedPluginData(NS, C, 'true');
figma.root.setSharedPluginData(NS, V, ${JSON.stringify(canvas)});
return { ok: true };`
}

/**
 * POST /api/pi/intent-confirm 的处理本体：写 pluginData 四键（modeId /
 * profileId / confirmed=true / canvas）。前端 ChatNewIntentCard 确认按钮触发。
 * documentId 缺省 = 桥当前活动 tab（同工具 document_id 缺省语义）。
 * T98-路由：windowId 透传——按发起窗路由（多窗时只有目标窗的 pluginData 被写）。
 */
export async function confirmNewIntentViaBridge(
  args: { modeId: string; profileId?: string; canvas?: string },
  documentId?: string,
  windowId?: string
): Promise<ConfirmNewIntentResult> {
  if (!args.modeId) {
    return { ok: false, error: 'invalid_args', message: 'modeId 不能为空' }
  }
  const profileId = args.profileId ?? ''
  const canvas = args.canvas ?? ''
  try {
    const discovery = await readDiscoveryFile()
    if (!discovery) throw new Error('bridge discovery missing')
    const code = buildWriteNewIntentSource(args.modeId, profileId, canvas)
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
    return { ok: true, modeId: args.modeId, profileId, canvas }
  } catch {
    return {
      ok: false,
      error: 'bridge_unavailable',
      message: '画布桥不可达——确认 dev server 已启动且浏览器已打开 app，然后重试。'
    }
  }
}
