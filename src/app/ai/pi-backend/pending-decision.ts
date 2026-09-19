/**
 * 2026-09-19 broker P1 件1（仓外 docs/202609181745-agent-permission-broker-design.md
 * §6 统筹，拍板 9）：AskPendingStore 抽象化为 PendingDecisionStore——ask/authz
 * 双族共用挂起基建，kind 判别联合；ask 族自 ask/pending.ts 迁移本档（行为零
 * 变化，语义与生命周期与 2026-09-15 硬阻断改造一致）。
 *
 * 统筹依据（设计稿 §6 同构点）：同一阻断本质（agent 轮次挂起 → 用户决断 →
 * 答复继续/终止）、同一生命周期（注册 pending → SSE 推卡 → 端点回收答案 →
 * resolve 进同 turn 工具结果；abort/SSE 断连/会话 GC → reject 级联）、同一
 * 并发约束（pending 期间锁其他工具——ask/pending-guard.ts 双族覆盖）。
 *
 * 语义分界（不合并的依据）：ask = 模型主动发起、内容模型撰写、答案进模型
 * 上下文；authz = 系统发起（guard 拦截）、事实层系统直出、答复决定工具是否
 * 执行 + session 规则记忆面（authz-guard.ts）。
 *
 * 单例（service.ts createPendingDecisionStore 进程级），跨 session 共享；
 * formId 键（ask = 'ask-'+toolCallId；authz = 'authz-'+toolCallId）。同
 * session 同时刻最多 1 条 pending（双族合计）——重复 register 返
 * alreadyPending true（不消费旧条目）。
 *
 * kind 判别：resolveAsk 对 authz 条目（及反向）返 'not_found'——端点按
 * body.kind 路由，错族寻址视同无此 pending。
 *
 * 不吞错（no-silent-catch 纪律）；拒绝路径必显式 reject(err)。
 */

export type DecisionKind = 'ask' | 'authz'

/** ask 族作答载荷（自 ask/pending.ts 迁移，形状零变化） */
export interface AskAnswerPayload {
  /** formId→作答对象；跳过时缺省。
   *  Wave 2 扩展：单选/文本走 { value }；多选走 { values: string[] }；per-question notes 走 { notes }；
   *  values 与 value 至少其一为合法形态才计有效（与 normalizeQuestionAnswer 同律）。 */
  answers?: Record<string, { value?: string; values?: string[]; freeText?: string; notes?: string }>
  /** true = 跳过表单；与 answers 二选一 */
  skip?: boolean
  /** Wave 2 #9：提交时附加的全局备注（非空白才传） */
  notes?: string
}

/** authz 族决断值（冻结契约：/api/pi/decision-answer body.decision） */
export type AuthzDecision = 'allow-once' | 'allow-rule' | 'deny'

/**
 * authz 族作答载荷：allow-once = 放行本次；allow-rule = 放行并把 ruleText
 * （规则原文，用户确认）入 session 规则；deny = 阻断（note = 用户附回模型的
 * 一句话，进结构化回执）。
 */
export interface AuthzAnswerPayload {
  decision: AuthzDecision
  /** decision = 'allow-rule' 时必填：规则原文（guard 派生、卡按钮呈现、用户确认后回传入库） */
  ruleText?: string
  /** 拒绝附言（可选，进结构化回执） */
  note?: string
}

interface PendingEntry {
  sessionId: string
  formId: string
  kind: DecisionKind
  promise: Promise<unknown>
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
}

/**
 * POST /api/pi/decision-answer 端点的 service 入参（kind 判别联合——窄化后
 * payload 类型自动跟随，免断言；service.ts / decision-answer-route.ts 共用）。
 */
export type DecisionAnswerInput =
  | { kind: 'ask'; formId: string; payload: AskAnswerPayload }
  | { kind: 'authz'; formId: string; payload: AuthzAnswerPayload }

export interface DecisionRegistration<T> {
  promise: Promise<T>
  alreadyPending: boolean
}

export interface PendingDecisionStore {
  /**
   * 注册 ask 族 pending，返回挂起 promise 与是否已有 pending。
   * signal abort 时自动 reject（Error('aborted')）并从表移除——挂起期
   * agent 物理停摆、abort 信号透传到 pi run 收尾（参照 service.ts abort）。
   */
  registerAsk(
    sessionId: string,
    formId: string,
    signal?: AbortSignal
  ): DecisionRegistration<AskAnswerPayload>
  /** 注册 authz 族 pending（语义同 registerAsk；signal 通常缺省——abort 级联经 rejectForSession 覆盖） */
  registerAuthz(
    sessionId: string,
    formId: string,
    signal?: AbortSignal
  ): DecisionRegistration<AuthzAnswerPayload>
  /** 端点调用 resolve；'not_found' = 表中无该 formId 或 kind 不属本族（已答过/已 abort/未注册/错族寻址） */
  resolveAsk(formId: string, payload: AskAnswerPayload): 'ok' | 'not_found'
  resolveAuthz(formId: string, payload: AuthzAnswerPayload): 'ok' | 'not_found'
  /** abort / 会话 GC 清理——reject 该 session 全部 pending（双族），返清理条数 */
  rejectForSession(sessionId: string, err: Error): number
  /** guard 用：session 是否有 pending（双族合计） */
  hasPendingForSession(sessionId: string): boolean
  /** pending-guard 用：session 当前 pending 的 kind（无 → null）——锁面 reason 按族区分 */
  pendingKindForSession(sessionId: string): DecisionKind | null
}

export function createPendingDecisionStore(): PendingDecisionStore {
  // formId → entry（端点 resolve 按 formId 寻址；session 隔离同时按 formId 与 sessionId 双键保证）
  const byFormId = new Map<string, PendingEntry>()

  function registerInternal<T>(
    sessionId: string,
    formId: string,
    kind: DecisionKind,
    signal?: AbortSignal
  ): DecisionRegistration<T> {
    // 同 session 已有 pending（双族合计）→ 拒绝再次注册（alreadyPending）；不消费旧条目。
    // promise 断言：此路径调用方按 alreadyPending 短路、不消费 promise（ask 工具/authz
    // guard 同律），它族载荷类型不会被读取
    for (const entry of byFormId.values()) {
      if (entry.sessionId === sessionId) {
        return { promise: entry.promise as Promise<T>, alreadyPending: true }
      }
    }
    let resolve!: (payload: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    const entry: PendingEntry = {
      sessionId,
      formId,
      kind,
      promise,
      resolve: (payload: unknown) => resolve(payload as T),
      reject
    }
    byFormId.set(formId, entry)
    if (signal) {
      // abort 信号触发 → 自动 reject 并清条目；handler 是 fire-once 语义（once 包一层）
      const onAbort = () => {
        const current = byFormId.get(formId)
        if (current !== entry) return
        byFormId.delete(formId)
        reject(new Error('aborted'))
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    return { promise, alreadyPending: false }
  }

  function resolveInternal(
    formId: string,
    kind: DecisionKind,
    payload: unknown
  ): 'ok' | 'not_found' {
    const entry = byFormId.get(formId)
    // kind 判别：错族寻址视同无此 pending（端点按 body.kind 路由）
    if (!entry || entry.kind !== kind) return 'not_found'
    byFormId.delete(formId)
    entry.resolve(payload)
    return 'ok'
  }

  function rejectForSession(sessionId: string, err: Error): number {
    let count = 0
    for (const [formId, entry] of byFormId) {
      if (entry.sessionId !== sessionId) continue
      byFormId.delete(formId)
      entry.reject(err)
      count++
    }
    return count
  }

  function pendingKindForSession(sessionId: string): DecisionKind | null {
    for (const entry of byFormId.values()) {
      if (entry.sessionId === sessionId) return entry.kind
    }
    return null
  }

  return {
    registerAsk: (sessionId, formId, signal) => registerInternal(sessionId, formId, 'ask', signal),
    registerAuthz: (sessionId, formId, signal) =>
      registerInternal(sessionId, formId, 'authz', signal),
    resolveAsk: (formId, payload) => resolveInternal(formId, 'ask', payload),
    resolveAuthz: (formId, payload) => resolveInternal(formId, 'authz', payload),
    rejectForSession,
    hasPendingForSession: (sessionId) => pendingKindForSession(sessionId) !== null,
    pendingKindForSession
  }
}
