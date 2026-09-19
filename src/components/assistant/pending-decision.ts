/**
 * 2026-09-18 broker P1（前端件）：pending 决断卡共享助手——ask/authz 双族统筹
 * （设计真源 docs/202609181745-agent-permission-broker-design.md §5/§6）。
 *
 * 冻结契约（后端另一线并行开发，未落地时卡片留可重试态优雅降级）：
 *  - 未决授权请求经 SSE data part `data-authz-request` 直推（非 transient——
 *    ai SDK 会把它落进当前 assistant 消息 parts，见 dist/index.js
 *    isDataUIMessageChunk 分支），payload = AuthzRequestPartData。
 *  - 统一 answer 端点：POST /api/pi/decision-answer，body = DecisionAnswerPayload
 *    （kind 判别路由）；authz decision ∈ allow-once / allow-rule（带 ruleText =
 *    按钮上呈现的规则原文）/ deny（可附 note）；ask 维持 answer/skip 语义封装进
 *    同一端点形态。
 *
 * 未决/已决分面（§6 统筹形态）：
 *  - 未决态 pinned 输入区上方（ChatPanel dock，不随消息流滚动）；
 *  - 已决归档 = 消息流内同一 data part 以已决态渲染（本会话全量细节来自
 *    resolvedAuthzRecords；mid-stream 不能 appendHostMessage——AbstractChat
 *    write() 以 in-flight 消息整体 replace 末条，外部塞入的消息会被顶掉）。
 *  - 重载降级：会话内 resolved map 灭失后，由 formId（'authz-'+toolCallId）
 *    反查同消息 bash 工具 part 的终态推导出「已执行/未执行」弱化归档。
 */
import { getToolName, isToolUIPart } from 'ai'
import type { UIDataTypes, UIMessagePart, UITools } from 'ai'
import { reactive } from 'vue'

/** 后端直推的未决授权请求 data part 类型（冻结契约） */
export const AUTHZ_REQUEST_PART_TYPE = 'data-authz-request'

/** 事实层 schema（系统直出，guard 从 event.input 直取，不经模型——防注入面） */
export interface AuthzRequestPartData {
  formId: string
  kind: 'authz'
  toolName: string
  command: string
  cwd: string
  /** 规则原文（「你将放行的是什么」）；缺席时前端按 §11-4 默认口径派生兜底 */
  matchedRule?: string
}

export type AuthzDecision = 'allow-once' | 'allow-rule' | 'deny'

/** 已决记录（会话内全量细节；归档卡的渲染源） */
export interface AuthzDecisionRecord {
  formId: string
  command: string
  cwd: string
  decision: AuthzDecision
  /** decision === 'allow-rule' 时登记的规则原文（按钮上呈现的那串） */
  ruleText?: string
  /** decision === 'deny' 时用户附言（回传给 agent 的一句话） */
  note?: string
}

/** 统一 answer 端点载荷（冻结契约；kind 判别联合） */
export type DecisionAnswerPayload =
  | { kind: 'authz'; formId: string; decision: 'allow-once' }
  | { kind: 'authz'; formId: string; decision: 'allow-rule'; ruleText: string }
  | { kind: 'authz'; formId: string; decision: 'deny'; note?: string }
  | {
      kind: 'ask'
      formId: string
      decision: 'answer'
      answers: Record<
        string,
        { value?: string; values?: string[]; freeText?: string; notes?: string }
      >
      notes?: string
    }
  | { kind: 'ask'; formId: string; decision: 'skip' }

/**
 * POST /api/pi/decision-answer——统一决断回收端点。
 *
 * 不抛错（postIntentConfirm 先例）：成功 {ok:true}；HTTP 非 2xx / 校验失败 /
 * 网络错误一律 {ok:false, message}——端点未落地（404）时卡片转入可重试态。
 * formId 全局唯一（authz-<toolCallId> / ask-<toolCallId>），无需 windowId 路由
 * （ask-answer 端点同律不带）。
 */
export async function postDecisionAnswer(
  payload: DecisionAnswerPayload
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch('/api/pi/decision-answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean
      error?: string
      message?: string
    } | null
    if (res.ok && body?.ok !== false) return { ok: true }
    return { ok: false, message: body?.error ?? body?.message ?? `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** data part 载荷防御性归一（形状不符 → null，渲染层不崩不渲染）。
 *  `in` 收窄逐字段取（parseSetActiveDesignProposed 先例），不做宽断言 */
export function parseAuthzRequestData(input: unknown): AuthzRequestPartData | null {
  if (typeof input !== 'object' || input === null) return null
  if (!('kind' in input) || input.kind !== 'authz') return null
  if (!('formId' in input) || typeof input.formId !== 'string' || input.formId === '') return null
  if (!('command' in input) || typeof input.command !== 'string' || input.command === '') {
    return null
  }
  const toolName =
    'toolName' in input && typeof input.toolName === 'string' && input.toolName !== ''
      ? input.toolName
      : 'bash'
  const cwd = 'cwd' in input && typeof input.cwd === 'string' ? input.cwd : ''
  const matchedRule =
    'matchedRule' in input && typeof input.matchedRule === 'string' && input.matchedRule !== ''
      ? input.matchedRule
      : undefined
  return {
    formId: input.formId,
    kind: 'authz',
    toolName,
    command: input.command,
    cwd,
    ...(matchedRule !== undefined ? { matchedRule } : {})
  }
}

/** 可识别子命令（小写词/连字符；旗标与路径不算）——§11-4 默认规则口径 */
const SUBCOMMAND_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * 规则原文兜底派生（matchedRule 缺席时）：argv[0] + 可识别子命令前缀 + ' *'，
 * 如 `bun test src/x.test.ts` → `bun test *`、`git status` → `git status *`。
 * 粒度不由系统猜的落点 = 按钮呈现规则原文，用户点按即确认该文本入库；
 * 后端给了 matchedRule 时一律以它为准（不派生）。
 */
export function deriveDefaultBashRule(command: string): string {
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '')
  if (tokens.length === 0) return '*'
  const first = tokens[0]
  const second = tokens.at(1)
  const prefix =
    second !== undefined && SUBCOMMAND_PATTERN.test(second) ? `${first} ${second}` : first
  return `${prefix} *`
}

/** formId ↔ toolCallId：'authz-'+toolCallId（冻结契约） */
const AUTHZ_FORM_ID_PREFIX = 'authz-'

export function authzToolCallId(formId: string): string | null {
  return formId.startsWith(AUTHZ_FORM_ID_PREFIX) && formId.length > AUTHZ_FORM_ID_PREFIX.length
    ? formId.slice(AUTHZ_FORM_ID_PREFIX.length)
    : null
}

// ── 会话级已决记录（模块级 reactive Map；formId 全局唯一，不清仓无害） ─────────

const resolvedAuthzRecords = reactive(new Map<string, AuthzDecisionRecord>())

export function markAuthzResolved(record: AuthzDecisionRecord): void {
  resolvedAuthzRecords.set(record.formId, record)
}

export function getAuthzResolved(formId: string): AuthzDecisionRecord | undefined {
  return resolvedAuthzRecords.get(formId)
}

// ── 卡片视图联合（ChatPanel dock 构造 / PendingDecisionCard prop / PiChatMessage 归档） ──

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { toolCallId: string }>

/** ask 皮肤视图——沿用 AskUserQuestionCard 的 props 语义（part + partState 原值） */
export interface AskDecisionView {
  kind: 'ask'
  part: ToolPart
  /** part.state 原值直传（ai SDK 就地改 part 对象，引用不变——原值才能穿透浅比较） */
  partState: ToolPart['state']
}

export type AuthzCardMode = 'pending' | 'resolved' | 'expired'

export interface AuthzDecisionView {
  kind: 'authz'
  request: AuthzRequestPartData
  /** pending = 未决可交互（pinned dock）；resolved = 已决归档；expired = 未答复但轮次已结束 */
  mode: AuthzCardMode
  record?: AuthzDecisionRecord
  /** expired 弱化推导：同消息 bash 工具 part 终态（重载后 resolved map 灭失的兜底） */
  expiredHint?: 'executed' | 'blocked' | null
}

export type PendingDecisionView = AskDecisionView | AuthzDecisionView

/**
 * pinned 未决收集（ChatPanel dock 数据源）——只喂末条 assistant 消息的 parts：
 * pending 只可能存在于在途 run；旧消息的未决残留一律是死轮残留，归 PiChatMessage
 * 的 expired/locked 渲染。
 *  - ask 未决 = input-* 态的 ask_user_question 工具 part（且不在已答信封集）；
 *  - authz 未决 = data-authz-request part 且会话 resolved map 未命中（已决即收卡）。
 */
export function collectPinnedDecisions(
  parts: UIMessagePart<UIDataTypes, UITools>[],
  answeredFormIds: ReadonlySet<string>
): PendingDecisionView[] {
  const out: PendingDecisionView[] = []
  for (const part of parts) {
    if (isToolUIPart(part) && getToolName(part) === 'ask_user_question') {
      if (part.state !== 'input-streaming' && part.state !== 'input-available') continue
      if (answeredFormIds.has(`ask-${part.toolCallId}`)) continue
      out.push({ kind: 'ask', part, partState: part.state })
      continue
    }
    if (part.type === AUTHZ_REQUEST_PART_TYPE && 'data' in part) {
      const request = parseAuthzRequestData(part.data)
      if (!request || getAuthzResolved(request.formId)) continue
      out.push({ kind: 'authz', request, mode: 'pending' })
    }
  }
  return out
}
