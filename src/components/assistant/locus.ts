/**
 * 2026-09-27 sl-w2-locus-gate：落点拦截门（§3.1）纯逻辑层。
 *
 * 唯一职责：把「当前视图页 + GET 响应 + 文档状态」三件事实收口到一个判定结果，
 * 不触碰网络、不触碰 DOM、不触碰 store——上层（ChatPanel.handleSubmit 入口）
 * 拿到结果后自行走 PUT / switchPage / 放行发送等动作。
 *
 * 判定变体（与 §3.1 一一对应）：
 *  - `first-send-no-doc`     docUuid 不存在（首开消息）—— 无值可比，不拦；上层
 *                            先捕获 currentPageId 再发送，发送后 PUT 写回
 *                            engagedPageId（防竞态：捕获先于发送）。
 *  - `silent-init`           GET 成功 + state 缺省 + hasSession=false
 *                            （真首跑）—— 静默 PUT engagedPageId = currentPageId
 *                            后放行；纯流程不弹卡。
 *  - `gate-resolve`          GET 成功 + 视图页与落点页不一致（含悬空变体）——
 *                            弹卡让用户二选一；reason 区分文案与按钮形态。
 *  - `same-page`             视图页 == 落点页 —— 直接放行，零动作。
 *
 * 端点不可达（GET / PUT 抛出或非 2xx）由 fetchLocusPageState / putLocusEngagedPage
 * 显式返 `{ kind: 'unreachable', message }`，上层按 fail-closed 阻塞发送——
 * 不在纯逻辑层吞掉「端点活但文件坏」与「端点死」两种语义，本模块只看端点活
 * 且已解析的 response 对象。
 */

/** 文档级标量值——与 pi-backend page-state.ts PageState 同源；前端只关心 engagedPageId。 */
export interface LocusState {
  modeId: string | null
  profileId: string | null
  engagedPageId: string | null
}

/** GET /api/pi/page-state 响应（与路由端返回的 JSON 形状对齐）。 */
export interface LocusGetResponse {
  state: LocusState | null
  /** 后端 session index 是否存在该 docUuid 族谱——首跑 / 腐烂分档事实源。 */
  hasSession: boolean
}

/** 拦截判定结果——上层按 kind 派发动作。 */
export type LocusIntercept =
  /** 视图页 == 落点页 —— 直接放行，零动作。 */
  | { kind: 'same-page' }
  /** 真首跑（state 缺省 + 无 session）—— 静默 PUT engaged=view 后放行。 */
  | { kind: 'silent-init'; currentPageId: string }
  /** docUuid 不存在（首开消息）—— 不读 GET，先捕获 currentPageId 再发送；
   *  发送完成后 PUT engagedPageId = 捕获值。 */
  | { kind: 'first-send-no-doc'; currentPageId: string }
  /** 弹卡二选一：reason='switch' = 正常换页（两按钮），reason='orphan' =
   *  悬空 / 落点未设置（仅确认切到当前页）。 */
  | {
      kind: 'gate-resolve'
      currentPageId: string
      engagedPageId: string
      reason: 'switch' | 'orphan'
    }

/** 上层调用 fetchLocusPageState / putLocusEngagedPage 的网络结果。 */
export type LocusNetworkResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unreachable'; message: string }

/** GET 响应探测形状——具名结构替代 Record<string, unknown> 强转（门禁禁宽断言） */
interface LocusGetResponseProbe {
  state?: unknown
  hasSession?: unknown
}

/** 防御性解析 GET 响应——端点已 2xx 但形状坏（前端版本与后端不匹配 / 字段缺失）
 *  退化为 state=null / hasSession=false；上层若需严格语义应改读 throw。 */
export function parseLocusGetResponse(input: unknown): LocusGetResponse {
  if (!input || typeof input !== 'object') return { state: null, hasSession: false }
  const obj = input as LocusGetResponseProbe
  return {
    state: parseLocusState(obj.state),
    hasSession: typeof obj.hasSession === 'boolean' ? obj.hasSession : false
  }
}

/** 落点标量探测形状（同上） */
interface LocusStateProbe {
  modeId?: unknown
  profileId?: unknown
  engagedPageId?: unknown
}

function parseLocusState(input: unknown): LocusState | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as LocusStateProbe
  if (
    'modeId' in obj &&
    'profileId' in obj &&
    'engagedPageId' in obj &&
    (obj.modeId === null || typeof obj.modeId === 'string') &&
    (obj.profileId === null || typeof obj.profileId === 'string') &&
    (obj.engagedPageId === null || typeof obj.engagedPageId === 'string')
  ) {
    return {
      modeId: obj.modeId,
      profileId: obj.profileId,
      engagedPageId: obj.engagedPageId
    }
  }
  return null
}

/**
 * 把三件事实收敛成一个 LocusIntercept——纯函数，无副作用，可单测覆盖。
 *
 * @param currentPageId  当前视图页（store.state.currentPageId）。空串视为非法，
 *                       但调用方需先保证非空；本函数不二次校验以免与「切换中
 *                       视图瞬态为空」打架——上层应守卫。
 * @param pageList       当前文档页 id 列表（store.graph.getPages().map(p=>p.id)）；
 *                       悬空检测的唯一来源；空数组 = 文档无任何页（极异常路径，
 *                       上层若触发 silent-init 即可放行）。
 * @param response       GET /api/pi/page-state 已解析响应（端点已 2xx）。
 * @param docUuidPresent 文档根 sharedPluginData 是否有 openpencil.ai/docId 条目
 *                       ——首开消息路径判定。true = 曾 AI 交互过；false = 首开。
 */
export function resolveLocusIntercept(args: {
  currentPageId: string
  pageList: readonly string[]
  response: LocusGetResponse
  docUuidPresent: boolean
}): LocusIntercept {
  if (!args.docUuidPresent) {
    return { kind: 'first-send-no-doc', currentPageId: args.currentPageId }
  }
  const engaged = args.response.state?.engagedPageId ?? null
  if (engaged === null || engaged === '') {
    // 落点缺省——分档仅看 hasSession：曾有族谱 = 视同换页（不能静默重锚，
    // 否则用户已被旧浏览页污染）；无族谱 = 真首跑，静默写回。
    if (!args.response.hasSession) {
      return { kind: 'silent-init', currentPageId: args.currentPageId }
    }
    return {
      kind: 'gate-resolve',
      currentPageId: args.currentPageId,
      engagedPageId: '',
      reason: 'orphan'
    }
  }
  if (engaged === args.currentPageId) {
    return { kind: 'same-page' }
  }
  // engaged 非空且与视图不一致——悬空（页列表查无）→ orphan；否则正常换页。
  if (!args.pageList.includes(engaged)) {
    return {
      kind: 'gate-resolve',
      currentPageId: args.currentPageId,
      engagedPageId: engaged,
      reason: 'orphan'
    }
  }
  return {
    kind: 'gate-resolve',
    currentPageId: args.currentPageId,
    engagedPageId: engaged,
    reason: 'switch'
  }
}

/** 上层失败兜底字符串（fail-closed toast 用）——i18n 文案在 fork locus 域。 */

// ── 网络层（fetch 包装）─────────────────────────────────────────────────────
//
// 与 resolveLocusIntercept 解耦：纯逻辑层做判定，网络层做 I/O；
// 单测只覆盖纯逻辑层，网络层经测试桩 fetch 钉扎。

/**
 * GET /api/pi/page-state?docUuid=<uuid>——网络层包装。解析失败 / 非 2xx / fetch
 * 抛出均返 `{ kind: 'unreachable' }`，由上层按 fail-closed 阻塞发送。响应 JSON
 * 形状坏 → 退化为 `{ state: null, hasSession: false }`（按缺省链兜底）。
 */
export async function fetchLocusPageState(
  docUuid: string
): Promise<LocusNetworkResult<LocusGetResponse>> {
  try {
    const res = await fetch(`/api/pi/page-state?docUuid=${encodeURIComponent(docUuid)}`)
    if (!res.ok) {
      return { kind: 'unreachable', message: `HTTP ${res.status}` }
    }
    const body = (await res.json().catch(() => null)) as unknown
    return { kind: 'ok', value: parseLocusGetResponse(body) }
  } catch (error) {
    return { kind: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * PUT /api/pi/page-state { docUuid, patch: { engagedPageId } }——网络层包装。
 * 非 2xx / fetch 抛 → `{ kind: 'unreachable' }`；与 fetchLocusPageState 共享
 * 同一 fail-closed 语义。
 */
export async function putLocusEngagedPage(args: {
  docUuid: string
  engagedPageId: string
}): Promise<LocusNetworkResult<LocusState>> {
  try {
    const res = await fetch('/api/pi/page-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docUuid: args.docUuid, patch: { engagedPageId: args.engagedPageId } })
    })
    if (!res.ok) {
      return { kind: 'unreachable', message: `HTTP ${res.status}` }
    }
    const body = (await res.json().catch(() => null)) as { state?: unknown } | null
    const state = parseLocusState(body?.state) ?? {
      modeId: null,
      profileId: null,
      engagedPageId: args.engagedPageId
    }
    return { kind: 'ok', value: state }
  } catch (error) {
    return { kind: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}
