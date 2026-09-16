/**
 * 2026-09-15：ask_user_question 挂起期 tool_call guard——pending 期间拦截非
 * ask 工具调用（block+reason），强制模型停手等本工具结果返回；ask 自身不
 * block（其 execute 内部 alreadyPending 错误结果更具体）。
 * handler 与 extension 分离导出：测试直钉 handler（免 ExtensionAPI 桩件）。
 */
import type { InlineExtension } from '@earendil-works/pi-coding-agent'

export function createAskPendingGuardHandler(
  store: { hasPendingForSession(sessionId: string): boolean },
  sessionId: string
): (event: { toolName: string }) => { block: true; reason: string } | undefined {
  return (event) => {
    if (event.toolName === 'ask_user_question') return undefined
    if (store.hasPendingForSession(sessionId)) {
      return {
        block: true,
        reason:
          "A form is awaiting the user's answer; wait for ask_user_question to return before calling further tools."
      }
    }
    return undefined
  }
}

/** guard 的 inline extension 装配形态——session/assembly.ts 注入 extensionFactories */
export function createAskPendingGuardExtension(
  store: { hasPendingForSession(sessionId: string): boolean },
  sessionId: string
): InlineExtension {
  const handler = createAskPendingGuardHandler(store, sessionId)
  return (pi) => {
    pi.on('tool_call', handler)
  }
}
