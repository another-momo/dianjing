/**
 * 2026-09-27 sl-w2-locus-gate：落点拦截门（§3.1）纯逻辑层。
 *
 * 唯一职责：把「当前视图页 + GET 响应 + 文档状态」三件事实收口到一个判定结果，
 * 不触碰网络、不触碰 DOM、不触碰 store——上层（ChatPanel.handleSubmit 入口）
 * 拿到结果后自行走 PUT / switchPage / 放行发送等动作。
 *
 * 判定变体（与 §3.1 一一对应）：
 *  - `silent-init`           GET 成功 + 落点未设置（state 缺省 / engagedPageId 空串）
 *                            或落点悬空（原施工页已删、页列表查无）—— 静默 PUT
 *                            engagedPageId = currentPageId 后放行；纯流程不弹卡。
 *                            hasSession 仍保留在 GET 响应契约里（网络层照常解析），
 *                            判定层不再按它分支——「从未设置」与「真首跑」同口径静默。
 *  - `gate-resolve`          GET 成功 + 视图页与落点页不一致（落点页仍在）——
 *                            弹卡让用户二选一。
 *  - `same-page`             视图页 == 落点页 —— 直接放行，零动作。
 *
 * 端点不可达（GET / PUT 抛出或非 2xx）由 fetchLocusPageState / putLocusEngagedPage
 * 显式返 `{ kind: 'unreachable', message }`，上层按 fail-closed 阻塞发送——
 * 不在纯逻辑层吞掉「端点活但文件坏」与「端点死」两种语义，本模块只看端点活
 * 且已解析的 response 对象。
 *
 * 2026-09-27：网络层（fetchLocusPageState / putLocusEngagedPage /
 * parseLocusGetResponse / LocusState / probe 类型）迁至 app 层
 * @/app/ai/pi-backend/page-state-client——app 层模块不得 import components
 * 层（FSD），chips 回显（mode-selection）以 page-state 为真源需要读通道。
 * 本模块 re-export 既有名，导出面零破坏（现有 import 方不改）。
 */
import type { LocusGetResponse } from '@/app/ai/pi-backend/page-state-client'

export type {
  LocusGetResponse,
  LocusNetworkResult,
  LocusState
} from '@/app/ai/pi-backend/page-state-client'
export {
  fetchLocusPageState,
  parseLocusGetResponse,
  putLocusEngagedPage
} from '@/app/ai/pi-backend/page-state-client'

/** 拦截判定结果——上层按 kind 派发动作。 */
export type LocusIntercept =
  /** 视图页 == 落点页 —— 直接放行，零动作。 */
  | { kind: 'same-page' }
  /** 落点未设置（state 缺省 / 空串，不论 hasSession）或悬空（原施工页已删）——
   *  静默 PUT engaged=view 后放行。 */
  | { kind: 'silent-init'; currentPageId: string }
  /** 弹卡二选一：视图页 ≠ 落点页且落点页仍在 —— 留在落点页 / 切到当前页。 */
  | {
      kind: 'gate-resolve'
      currentPageId: string
      engagedPageId: string
    }

/** 拦截门确认卡渲染视图（ChatLocusGateCard props / ChatPanel 构造共用契约） */
export interface LocusGateView {
  /** 当前视图页名（用户发消息时所在的页） */
  viewPageName: string
  /** 现有落点页名——gate-resolve 仅剩 switch 单变体（落点页恒在），页名恒可解析 */
  engagedPageName: string
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
 *                       docUuid 由上层 preflight 即时铸造保证在先（2026-09-30
 *                       docUuid 铸造时机批），本函数不再按「文档是否已铸」分支。
 */
export function resolveLocusIntercept(args: {
  currentPageId: string
  pageList: readonly string[]
  response: LocusGetResponse
}): LocusIntercept {
  const engaged = args.response.state?.engagedPageId ?? null
  if (engaged === null || engaged === '') {
    // 落点从未设置——不论 hasSession 同口径静默（「从未设置」与「真首跑」同义放行）
    return { kind: 'silent-init', currentPageId: args.currentPageId }
  }
  if (engaged === args.currentPageId) {
    return { kind: 'same-page' }
  }
  // engaged 非空且与视图不一致——悬空（原施工页已删，页列表查无）同口径静默重锚；
  // 落点页仍在 → 弹卡二选一。
  if (!args.pageList.includes(engaged)) {
    return { kind: 'silent-init', currentPageId: args.currentPageId }
  }
  return {
    kind: 'gate-resolve',
    currentPageId: args.currentPageId,
    engagedPageId: engaged
  }
}

/** 上层失败兜底字符串（fail-closed toast 用）——i18n 文案在 fork locus 域。 */

// ── 网络层（fetch 包装）─────────────────────────────────────────────────────
//
// 与 resolveLocusIntercept 解耦：纯逻辑层做判定，网络层做 I/O；
// 单测只覆盖纯逻辑层，网络层经测试桩 fetch 钉扎。
//
// 2026-09-27：网络层本体迁至 @/app/ai/pi-backend/page-state-client（见文件头），
// 本文件仅以页首 export 块 re-export 既有名（导出面零破坏）。
