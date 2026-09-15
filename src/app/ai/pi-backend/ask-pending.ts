/**
 * ask_user_question 挂起期 pending-form 注册表（2026-09-15 ask-user-question
 * 软终止→硬阻断改造，决策单 §4 Phase 1 第 1 项）。
 *
 * 语义：ask_user_question 工具 execute 不再返回 awaiting_user + 软终止文本，
 * 而是把表单挂起（promise 挂起到前端 /api/pi/ask-answer 端点 / abort /
 * 会话 GC 触发 resolve/reject）；agent loop await 该 promise 期间物理停摆，
 * 答案作为工具结果在同一 turn 返回（user-facing SSE 流挂起；SSE 长连接 +
 * server.requestTimeout=0 已允许）。
 *
 * 单例（service.ts createAskPendingStore 进程级），跨 session 共享；formId
 * 键（toolCallId 派生，ask-user-question.ts makeId 默认 'ask-'+toolCallId）。
 *
 * 不吞错（no-silent-catch 纪律）；同 session 重复 register = alreadyPending
 * true（同 session 旧表单未答时新调工具的硬错误结果态）。
 */

export interface AskAnswerPayload {
  /** formId→作答对象；跳过时缺省 */
  answers?: Record<string, { value: string; freeText?: string }>
  /** true = 跳过表单；与 answers 二选一 */
  skip?: boolean
}

interface PendingEntry {
  sessionId: string
  formId: string
  promise: Promise<AskAnswerPayload>
  resolve: (payload: AskAnswerPayload) => void
  reject: (error: Error) => void
}

export interface AskPendingStore {
  /**
   * 注册一条 pending form，返回挂起 promise 与是否已有 pending。
   * signal abort 时自动 reject（Error('aborted')）并从表移除——挂起期
   * agent 物理停摆、abort 信号透传到 pi run 收尾（参照 service.ts abort）。
   */
  register(
    sessionId: string,
    formId: string,
    signal?: AbortSignal
  ): { promise: Promise<AskAnswerPayload>; alreadyPending: boolean }
  /** 端点调用 resolve；'not_found' = 表中无该 formId（已答过/已 abort/未注册） */
  resolveByFormId(formId: string, payload: AskAnswerPayload): 'ok' | 'not_found'
  /** abort / 会话 GC 清理——reject 该 session 全部 pending，返清理条数 */
  rejectForSession(sessionId: string, err: Error): number
  /** guard 用：session 是否有 pending（tool_call handler 据此 block 非 ask 工具） */
  hasPendingForSession(sessionId: string): boolean
}

export function createAskPendingStore(): AskPendingStore {
  // formId → entry（端点 resolve 按 formId 寻址；session 隔离同时按 formId 与 sessionId 双键保证）
  const byFormId = new Map<string, PendingEntry>()

  function register(
    sessionId: string,
    formId: string,
    signal?: AbortSignal
  ): { promise: Promise<AskAnswerPayload>; alreadyPending: boolean } {
    // 同 session 已有 pending → 拒绝再次注册（alreadyPending）；不消费旧条目
    for (const entry of byFormId.values()) {
      if (entry.sessionId === sessionId) {
        return { promise: entry.promise, alreadyPending: true }
      }
    }
    let resolve!: (payload: AskAnswerPayload) => void
    let reject!: (error: Error) => void
    const promise = new Promise<AskAnswerPayload>((res, rej) => {
      resolve = res
      reject = rej
    })
    const entry: PendingEntry = { sessionId, formId, promise, resolve, reject }
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

  function resolveByFormId(formId: string, payload: AskAnswerPayload): 'ok' | 'not_found' {
    const entry = byFormId.get(formId)
    if (!entry) return 'not_found'
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

  function hasPendingForSession(sessionId: string): boolean {
    for (const entry of byFormId.values()) {
      if (entry.sessionId === sessionId) return true
    }
    return false
  }

  return { register, resolveByFormId, rejectForSession, hasPendingForSession }
}
