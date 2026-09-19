/**
 * 2026-09-15：ask_user_question 挂起期 tool_call guard——pending 期间拦截非
 * ask 工具调用（block+reason），强制模型停手等本工具结果返回。
 * 2026-09-19 broker P1 件3 锁面扩面（设计稿 §6 统筹：pending 期间锁其他工具，
 * 双族共享）：store 抽象为 PendingDecisionStore 后 pending 查询覆盖 authz
 * pending——authz 挂起期拦截一切工具（含 bash 自身重入与 ask_user_question，
 * 一次只挂一张授权卡）；reason 按族区分。ask pending 时 ask 自身仍不 block
 * （其 execute 内部 alreadyPending 错误结果更具体）。
 * handler 与 extension 分离导出：测试直钉 handler（免 ExtensionAPI 桩件）。
 */
import type { InlineExtension } from '@earendil-works/pi-coding-agent'

import type { PendingDecisionStore } from '../pending-decision'

const ASK_PENDING_REASON =
  "A form is awaiting the user's answer; wait for ask_user_question to return before calling further tools."

const AUTHZ_PENDING_REASON =
  "A bash authorization request is awaiting the user's decision; wait for it to resolve before calling further tools."

type PendingKindReader = Pick<PendingDecisionStore, 'pendingKindForSession'>

export function createAskPendingGuardHandler(
  store: PendingKindReader,
  sessionId: string
): (event: { toolName: string }) => { block: true; reason: string } | undefined {
  return (event) => {
    const kind = store.pendingKindForSession(sessionId)
    if (kind === null) return undefined
    // ask pending 时 ask 自身不 block（alreadyPending 错误结果更具体）；
    // authz pending 时一切工具拦截（含 bash 重入与 ask_user_question——一次只挂一张授权卡）
    if (kind === 'ask' && event.toolName === 'ask_user_question') return undefined
    return { block: true, reason: kind === 'ask' ? ASK_PENDING_REASON : AUTHZ_PENDING_REASON }
  }
}

/** guard 的 inline extension 装配形态——session/assembly.ts 注入 extensionFactories */
export function createAskPendingGuardExtension(
  store: PendingKindReader,
  sessionId: string
): InlineExtension {
  const handler = createAskPendingGuardHandler(store, sessionId)
  return (pi) => {
    pi.on('tool_call', handler)
  }
}
