/**
 * 2026-09-27 page-state 前端网络层（自 components/assistant/locus.ts 迁入）。
 *
 * 职责：GET/PUT /api/pi/page-state 的 fetch 包装 + 响应防御性解析——纯 I/O，
 * 不做判定（落点拦截判定留在 components/assistant/locus.ts 纯逻辑层）。
 *
 * 落点本层的理由（FSD 分层）：app 层模块不得 import components 层——chips
 * 回显（mode-selection.ts，app 层）以 page-state 为真源需要读通道，而
 * 网络层原先长在 components 层 locus.ts。迁入后 locus.ts 改为 import +
 * re-export 既有名，导出面零破坏（locus.ts 现有 import 方不改）。
 *
 * 命名沿用 Locus* 前缀（迁移不改名——消费方与单测经 locus.ts re-export
 * 取原名；类型单源：LocusState = PageState 别名，重复字面量形状过不了
 * test:type-shapes 门禁）。
 */
import type { PageState } from './page-state'

/** 文档级标量值——真源在 pi-backend page-state.ts PageState，前端并型别名复用
 * （重复字面量形状过不了 test:type-shapes 门禁）。 */
export type LocusState = PageState

/** GET /api/pi/page-state 响应（与路由端返回的 JSON 形状对齐）。 */
export interface LocusGetResponse {
  state: LocusState | null
  /** 后端 session index 是否存在该 docUuid 族谱——首跑 / 腐烂分档事实源。 */
  hasSession: boolean
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

/** 落点标量探测形状（Partial 映射型——字面量重复过不了 test:type-shapes） */
type LocusStateProbe = Partial<Record<keyof LocusState, unknown>>

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
