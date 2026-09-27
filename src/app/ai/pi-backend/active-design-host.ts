/**
 * 每回合组装与页身份信封——pi 后端进程侧（state-layering wave-2 批 4 摘除半
 * + 批 5b 后形态）。
 *
 * 职责：
 *  - 落点单源化：落点 = page-state 标量 engagedPageId（前端落点拦截门确认
 *    写回 / 静默初始化写回，service 冻结同源），视图页 = run 起始一次不钉页
 *    活页读（probeSlot，§7.2 视图事实唯一读道）——两事实分离，落点冻结绝不
 *    读活页。
 *  - brief 按页发现：探针 eval RPC 携带冻结 page_id（桥 target.pageId 钉页，
 *    target.ts 已支持）扫落点页需求单（§5 绑定不靠指针，住在哪页服务哪页）。
 *  - 每回合组装：system = base + workflow + profile 全文（顺序固定）；
 *    context = 页身份信封 + 可选差分行（pi before_agent_start 的 result.message
 *    custom 通道注入——convertToLlm 转 user role 进模型上下文，不进 UI 流、
 *    不进历史回填）。
 *    页身份行恒在：`[施工页 page=<id> 模式=<modeId/profileId> brief=<id|无>]`；
 *    视图页 ≠ 落点页时追加 `[你正在看第X页]` 差分行（数据源 = probeSlot 活页
 *    读——裁决后发送时刻视图恒 == 落点，该行唯一有意义的生成点是 run 起始，
 *    覆盖「发送后翻页」与排队消息场景）。
 *    规制解析单源 = page-state 标量（modeId / profileId）；workflow/profile 的
 *    registry 查找在 probe 阶段完成（resolveTurnAssets），modeId 命中但
 *    workflow 文件缺失 → 一行提示 + 按 general 组装（不注 profile）。
 *    尾段追加「按需参考」索引节（active 资产 references 并集非空时），
 *    并集即本回合 load_reference 允许集（load-reference.ts）。
 *    2026-09-21 owner 拍板统一限定形寻址：索引行恒带桶前缀（`base/<path>` /
 *    `workflow:<id>/<path>` / `profile:<id>/<path>`），agent 唯一寻址手段 =
 *    照抄行首 key。
 *
 * 已退役机制（§6.3 被消灭的机制，2026-09-27 摘除）：文档根单槽 + 四事件移槽、
 * intent 四键 + newIntent 优先级、身份差分通知族（lastIdentity / pendingSource /
 * modeSwitchedNotice）、set_active_design 整工具与移槽端点、悬空清槽与
 * brief 悬空提示（绑定天然页局部，brief=无 即事实行）。
 *
 * 桥失败语义：探针不可达（无 discovery / 桥 502 / 无活动文档）→ 本回合按空
 * 规制组装并 warn（冒烟环境无浏览器即此路径；工具调用届时会各自显式失败）。
 *
 * 仅运行于独立后端进程；只允许相对导入与 node/依赖包导入（同 service.ts 纪律）。
 */

import { ACTIVE_DESIGN_PROBE_KEYS } from '@open-pencil/core/tools/fork/marketing/active-design'
import { ACTIVE_DESIGN_TEXTS } from '@open-pencil/core/tools/fork/marketing/texts'

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
  /** context 注入行（页身份信封 + 可选差分行 + 系统提示行） */
  contextLines: string[]
  /**
   * T85 定谳 4：本回合 load_reference 允许集（限定形 key → 加载期解析绝对路径；
   * 空 = 本回合不可读任何 reference）。宿主持有于 turn 缓存袋，finalizeTurn
   * 随 turn=null 一并复位。
   * 2026-09-21：key 形态恒为 `base/<path>` / `workflow:<id>/<path>` /
   * `profile:<id>/<path>`——base 桶特判 `base`，workflow/profile 保留 `${kind}:${id}`，
   * 与索引节渲染同源（`referenceAddressPrefix` 单源），见 types.ts。
   */
  allowedReferences: ReadonlyMap<string, string>
}

/** 索引节标题（T85 定谳 3 字面口径；P2-3 同步工具名） */
const REFERENCES_INDEX_HEADING = '## 按需参考（load_reference 工具按需读取）'

/**
 * 本回合页身份上下文（agent 可见的「在何处按什么规制施工」事实行）——来源 =
 * page-state 标量（落点 + 规制）+ probe 一次不钉页活页读（视图页）+ 携带冻结
 * page_id 的探针按页扫描（落点页 brief）。落点冻结值与视图页是两个事实：
 * 落点是确认拦截门写回 / 初始化写回的事实值（恒 == 视图页或被用户改写过）；
 * 视图页是用户在浏览器里正在浏览的页（run 起始时刻取一次）。
 *
 * 字段全集可空 / 「无」字面量：
 *  - engagedPageId = 落点页 id；空 = 未初始化（首跑 / 腐烂）
 *  - modeId = 规制模式 id；空 = 未绑规制
 *  - profileId = 规制风格档案 id；空 = 未绑风格或 modeId 命中 general
 *  - briefId = 落点页需求单 id（按页发现，唯一 brief 命中才有值）；空 = 无
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

/**
 * 本回合资产解析结果（槽位态已随单槽退役整体摘除——只剩规制解析产物）。
 *
 * `resolvedWorkflow` / `resolvedProfile` 由 resolveTurnAssets 按 page-state
 * 标量完成 registry 查找后填入；assembleTurn 只消费已解析对象，不再自己查
 * registry。字段缺省（undefined）= 未解析出资产：base only 组装；modeId 非
 * general 且未命中 workflow → workflowMissingModeId 置位（缺失面判定同样落在
 * resolveTurnAssets）。
 */
export interface TurnAssets {
  resolvedWorkflow?: StudioWorkflow
  resolvedProfile?: StudioProfile
  /** page-state modeId 非空但 registry 未命中 workflow → 装配注 workflowMissing 提示 */
  workflowMissingModeId?: string
}

/**
 * 组装一回合的 system/context。规则（T60-plan 定谳 4 + P0-1 修订）：
 *  - 段序固定 base → workflow → profile（前缀缓存友好）；resolved 字段为空则该段跳过
 *  - 规制未绑：base only（空槽语义）
 *  - workflowMissingModeId 非空 → 一行 workflowMissing 提示
 *  - T85 定谳 3：本回合 active 资产（base 恒在 + 命中 workflow + 命中 profile）的
 *    references 并集非空时，systemPrompt 尾段追加「按需参考」索引节；并集即本回合
 *    load_reference 允许集（allowedReferences，finalizeTurn 复位）
 *  - 2026-09-21 统一限定形寻址：索引行恒带桶前缀，agent 唯一寻址手段 = 照抄
 *    行首 key
 *  - A3 B7：各段带来源头行——非空段前冠 `# studio base` / `# workflow: <id>` /
 *    `# profile: <id>`（asset.kind + asset.id，collectActiveReferences 同款）；
 *    空段不冠头（joinSegments 滤空串语义不变）。
 *  - 2026-09-27 sl-w2-state-chain：pageContext 恒在首行——「[施工页
 *    page=… 模式=… brief=…]」行 + 可选「[你正在看第X页]」差分行。
 *    位于 extraNotices 之前——事实 → 观察 → 提示 的注入序。
 */
export function assembleTurn(
  registry: StudioRegistry,
  assets: TurnAssets,
  pageContext: TurnPageContext,
  extraNotices: string[] = []
): TurnAssembly {
  const base = registry.base?.body ?? ''
  const baseAsset = registry.base ? [registry.base] : []
  const { resolvedWorkflow, resolvedProfile } = assets
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
  contextLines.push(...extraNotices)
  if (assets.workflowMissingModeId !== undefined) {
    contextLines.push(ACTIVE_DESIGN_TEXTS.workflowMissing(assets.workflowMissingModeId))
  }
  return finishTurn(registry, segments, contextLines, activeAssets)
}

/**
 * 本回合资产解析（纯函数；probe 阶段调用，装配侧只消费结果）。
 *
 * 规制输入单源 = page-state 标量（modeId / profileId，确认门直写的文档级
 * 最新值）。workflow 缺失语义（沿用 T60 定谳）：modeId 非空但 registry 未命中
 * workflow → workflowMissingModeId 置位 + **profile 不注入**（按 base only
 * 组装，避免 profile 规则悬空执行）。
 *
 * general 兼容行：A3 方案取消 general 的 workflow 身份（`studio/workflows/general/`
 * 已删除）。general 是无 workflow 的纯槽位标识——跳过 registry 查表、不置
 * workflowMissingModeId；profile 通道独立于 workflow（profileMatches 逻辑不动）。
 */
export function resolveTurnAssets(
  registry: StudioRegistry,
  pageState: { modeId: string | null; profileId: string | null } | null
): TurnAssets {
  const modeId = pageState?.modeId ?? ''
  if (modeId === '') return {}
  const profileId = pageState?.profileId ?? ''
  const profile = profileId === '' ? undefined : registry.profiles.get(profileId)
  // general 跳过 workflow 查表——纯槽位标识，不命中即合规（base only 组装）
  if (modeId === 'general') {
    const profileMatches = profile
      ? profile.modes.length === 0 || profile.modes.includes(modeId)
      : true
    return profile && profileMatches ? { resolvedProfile: profile } : {}
  }
  const workflow = registry.workflows.get(modeId)
  // 缺失 → 按 base only 组装（不注 profile）+ 提示行
  if (!workflow) return { workflowMissingModeId: modeId }
  // P2-10（2026-09-07）：profile 的 modes 字段是运行时过滤权威——UI 层（chips 菜单）
  // 与 prompt 注入层（本校验）都按 modes 筛选，缺省/空数组 = 所有 mode 可用。
  const profileMatches = profile
    ? profile.modes.length === 0 || profile.modes.includes(modeId)
    : true
  return {
    resolvedWorkflow: workflow,
    ...(profile && profileMatches ? { resolvedProfile: profile } : {})
  }
}

function joinSegments(segments: string[]): string {
  return segments.filter((segment) => segment !== '').join('\n\n')
}

// ── 桥探针（经 core `eval` 工具，键面常量单源插值）────────────────────────────

export interface SlotProbeData {
  currentPageId: string
  /**
   * document root `openpencil.ai/docId` 条目读出的文档 UUID——page-state 与
   * session 索引皆以此键控；run 起始服务侧据此读 page-state 拿落点 / 规制
   * 标量；空串 = 文档尚未铸造 uuid（首跑 / 桥不可达子集情形）。该字段不参与
   * 组装判定，仅作为上层「是否做 page-state 读写」的依据。
   */
  docUuid: string
}

export interface ActiveDesignBridgeIO {
  /**
   * run 起始不钉页活页读（§7.2 视图事实唯一读道）：返回视图页 id + docUuid。
   * 桥不可达 → null（调用方按空规格制降级 + warn）。**落点冻结严禁读此页**——
   * 视图页只供信封差分行。
   */
  probeSlot(documentId?: string, windowId?: string): Promise<SlotProbeData | null>
  /**
   * 落点页需求单读取（§5 按页发现）：eval RPC 携带冻结 page_id（桥
   * resolveAutomationTarget 钉页）→ 扫该页顶层需求单根。返回页上全部需求单
   * 节点 id（0 / 1 / 多——多 brief = 歧义事实，不静默取第一个）；桥不可达 → null。
   */
  probeBrief(pageId: string, documentId?: string, windowId?: string): Promise<string[] | null>
}

const K = ACTIVE_DESIGN_PROBE_KEYS

/**
 * 视图探针 eval 片段：不钉页活页读——只取裸数据（视图页 id + docUuid），判定
 * 在后端。桥 resolveAutomationTarget 无 page_id 时 `figma.currentPage` 即用户
 * 实时视图页。
 */
function buildProbeSource(): string {
  return `const currentPageId = figma.currentPage.id;
// 2026-09-27 sl-w2-state-chain：document root 上的 docUuid 条目（与前端
// document-key.ts PI_DOC_NAMESPACE / PI_DOC_ENTRY_KEY 同源）——page-state 与
// 会话索引皆以此键控；空串 = 文档尚未铸造 uuid（首跑 / 根 pluginData 被导入
// 覆盖窗口），上层据此跳过 page-state 读写。
// 查询键是 'docId' 而非条目全键 'openpencil.ai/docId'：条目以自命名空间编码
// 形存储（key 本身带 'openpencil.ai/' 前缀），core 的匹配器剥前缀比对后缀——
// 传全键 = 双前缀恒 miss（推送前独立 review 在真实 store 上实证）。
const docUuid = figma.root.getSharedPluginData('openpencil.ai', 'docId') || '';
return { currentPageId, docUuid };`
}

/**
 * 落点页需求单扫描 eval 片段：RPC 携带 page_id → 桥钉页 → `figma.currentPage`
 * 即落点页；只扫顶层（需求单根住页顶层，createBrief 同律），role 标记判定。
 */
function buildProbeBriefSource(): string {
  return `const NS = ${JSON.stringify(K.namespace)};
const ROLE = ${JSON.stringify(K.roleKey)};
const ROLE_BRIEF = ${JSON.stringify(K.roleBrief)};
const briefIds = [];
for (const child of figma.currentPage.children) {
  if (child.getSharedPluginData(NS, ROLE) === ROLE_BRIEF) briefIds.push(child.id);
}
return { briefIds };`
}

async function callBridgeEval(
  code: string,
  args: { documentId?: string; pageId?: string },
  windowId?: string
): Promise<unknown> {
  const discovery = await readDiscoveryFile()
  if (!discovery) throw new Error('bridge discovery missing')
  const envelope: Record<string, unknown> = { code }
  if (args.documentId) envelope.document_id = args.documentId
  if (args.pageId) envelope.page_id = args.pageId
  const res = await postBridgeRPC(discovery, 'tool', { name: 'eval', args: envelope }, windowId)
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

/** 生产桥实现：eval 探针；一切桥故障 → null（调用方定降级语义） */
/**
 * evalCode 可注入（默认走真桥 callBridgeEval）——测试借此把同一份生成的
 * eval 串在真实 store 上执行，覆盖「生成代码 × 真实数据形态」的接线面。
 */
export function createBridgeSlotIO(
  evalCode: (
    code: string,
    args: { documentId?: string; pageId?: string },
    windowId?: string
  ) => Promise<unknown> = callBridgeEval
): ActiveDesignBridgeIO {
  return {
    probeSlot: async (documentId, windowId) => {
      let raw: unknown
      try {
        raw = await evalCode(buildProbeSource(), { documentId }, windowId)
      } catch {
        return null
      }
      if (!isRecord(raw)) return null
      return { currentPageId: asString(raw.currentPageId), docUuid: asString(raw.docUuid) }
    },
    probeBrief: async (pageId, documentId, windowId) => {
      let raw: unknown
      try {
        raw = await evalCode(buildProbeBriefSource(), { documentId, pageId }, windowId)
      } catch {
        return null
      }
      if (!isRecord(raw) || !Array.isArray(raw.briefIds)) return null
      return raw.briefIds.filter((id): id is string => typeof id === 'string' && id !== '')
    }
  }
}

export interface ActiveDesignHostDeps {
  registry(): StudioRegistry
  bridge: ActiveDesignBridgeIO
  /**
   * 2026-09-27 sl-w2-state-chain：page-state 标量读取器——按 docUuid 读
   * 文档级规制（modeId / profileId）+ 落点（engagedPageId）。无 docUuid
   * （首跑 / 桥不可达）或文件缺失 / 腐烂 → 返 null，host 按空规格制组装。
   * 注入式参数（测试纪律：禁读真实 env / 进程全局走参数）。
   */
  pageStateReader: (
    docUuid: string
  ) => { modeId: string | null; profileId: string | null; engagedPageId: string | null } | null
}

export interface ActiveDesignHost {
  /** 回合入口：落点读穿 → 规制解析 → brief 按页发现 → 组装 */
  prepareTurn(text: string, documentId?: string, windowId?: string): Promise<{ promptText: string }>
  /** before_agent_start 钩子读取的当回合组装结果（prepareTurn 后恒非空） */
  turnAssembly(): TurnAssembly | null
  /** run 结束 finally：回合态清零 */
  finalizeTurn(): void
}

export function createActiveDesignHost(deps: ActiveDesignHostDeps): ActiveDesignHost {
  let turn: TurnAssembly | null = null

  /**
   * 落点读穿 + 规制解析 + 落点页需求单发现。
   *
   * 一次不钉页活页读取回视图页 + docUuid；page-state 按后者读取落点 / 规制；
   * 落点非空时再发一次携带冻结 page_id 的探针扫落点页需求单（多 brief =
   * 歧义事实，信封 brief 行不静默取第一个 → 无）。
   */
  async function probeTurnState(
    documentId?: string,
    windowId?: string
  ): Promise<{ assets: TurnAssets; pageContext: TurnPageContext }> {
    const probe = await deps.bridge.probeSlot(documentId, windowId)
    if (!probe) {
      console.warn('[pi-backend] 桥探针不可用——本回合按空规制组装（桥不可达或无活动文档）')
      return {
        assets: resolveTurnAssets(deps.registry(), null),
        pageContext: {
          engagedPageId: null,
          modeId: null,
          profileId: null,
          briefId: null,
          viewPageId: null
        }
      }
    }
    const pageState = probe.docUuid ? deps.pageStateReader(probe.docUuid) : null
    const assets = resolveTurnAssets(
      deps.registry(),
      pageState ? { modeId: pageState.modeId, profileId: pageState.profileId } : null
    )
    const engagedPageId = pageState?.engagedPageId ?? null
    // 落点页需求单按页发现：唯一 brief → id；无 brief / 多 brief 歧义 → 无
    //（不静默取第一个）；落点未初始化（首跑）→ 信封 page=无，brief 同步留空。
    let briefId: string | null = null
    if (engagedPageId) {
      const briefs = await deps.bridge.probeBrief(engagedPageId, documentId, windowId)
      briefId = briefs?.length === 1 ? (briefs[0] ?? null) : null
    }
    return {
      assets,
      pageContext: {
        engagedPageId,
        modeId: pageState?.modeId ?? null,
        profileId: pageState?.profileId ?? null,
        briefId,
        viewPageId: probe.currentPageId || null
      }
    }
  }

  return {
    async prepareTurn(text, documentId, windowId) {
      const { assets, pageContext } = await probeTurnState(documentId, windowId)
      turn = assembleTurn(deps.registry(), assets, pageContext)
      return { promptText: text }
    },
    turnAssembly: () => turn,
    finalizeTurn() {
      turn = null
    }
  }
}
