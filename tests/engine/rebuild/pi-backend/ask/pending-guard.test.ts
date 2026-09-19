/**
 * 2026-09-15 ask_user_question 挂起期 tool_call guard 钉扎。
 * 2026-09-19 broker P1 件3 锁面扩面钉扎：store 抽象为 PendingDecisionStore 后
 * 锁面双族共享——authz pending 拦截一切工具（含 bash 重入与 ask_user_question，
 * 一次只挂一张授权卡），reason 按族区分。
 *
 * 决策单 §4 Phase 1 第 1 项验收映射——service.ts 装配的 inline extension
 * 由 createAskPendingGuardExtension 包 createAskPendingGuardHandler 而成；
 * 测试直钉 handler（免 ExtensionAPI 桩件与类型断言）。
 *
 * 覆盖：
 *  - ask pending + 非 ask 工具 → {block:true, reason}（ask 文案）
 *  - ask pending + ask 自身 → undefined（alreadyPending 错误结果更具体）
 *  - authz pending + bash/任意工具/ask 自身 → {block:true, reason}（authz 文案）
 *  - 非 pending → undefined（透传）
 *  - session 隔离；resolve 后放行
 */

import { describe, expect, test } from 'bun:test'

import { createAskPendingGuardHandler } from '@/app/ai/pi-backend/ask/pending-guard'
import { createPendingDecisionStore } from '@/app/ai/pi-backend/pending-decision'

const ASK_REASON =
  "A form is awaiting the user's answer; wait for ask_user_question to return before calling further tools."
const AUTHZ_REASON =
  "A bash authorization request is awaiting the user's decision; wait for it to resolve before calling further tools."

describe('createAskPendingGuardHandler（ask pending）', () => {
  test('ask pending + 非 ask 工具 → block + ask reason', () => {
    const store = createPendingDecisionStore()
    store.registerAsk('s1', 'ask-1')
    const handler = createAskPendingGuardHandler(store, 's1')

    expect(handler({ toolName: 'create_brief' })).toEqual({ block: true, reason: ASK_REASON })
    expect(handler({ toolName: 'bash' })).toEqual({ block: true, reason: ASK_REASON })
  })

  test('ask pending + ask 自身 → undefined（alreadyPending 错误结果由 execute 内部处理）', () => {
    const store = createPendingDecisionStore()
    store.registerAsk('s1', 'ask-1')
    const handler = createAskPendingGuardHandler(store, 's1')

    expect(handler({ toolName: 'ask_user_question' })).toBeUndefined()
  })
})

describe('createAskPendingGuardHandler（authz pending 锁面扩面）', () => {
  test('authz pending + bash 重入 → block + authz reason（一次只挂一张授权卡）', () => {
    const store = createPendingDecisionStore()
    store.registerAuthz('s1', 'authz-1')
    const handler = createAskPendingGuardHandler(store, 's1')

    expect(handler({ toolName: 'bash' })).toEqual({ block: true, reason: AUTHZ_REASON })
  })

  test('authz pending + 任意其他工具 → block + authz reason', () => {
    const store = createPendingDecisionStore()
    store.registerAuthz('s1', 'authz-1')
    const handler = createAskPendingGuardHandler(store, 's1')

    expect(handler({ toolName: 'create_brief' })).toEqual({ block: true, reason: AUTHZ_REASON })
  })

  test('authz pending + ask_user_question → block + authz reason（不再透传）', () => {
    const store = createPendingDecisionStore()
    store.registerAuthz('s1', 'authz-1')
    const handler = createAskPendingGuardHandler(store, 's1')

    expect(handler({ toolName: 'ask_user_question' })).toEqual({
      block: true,
      reason: AUTHZ_REASON
    })
  })
})

describe('createAskPendingGuardHandler（透传与隔离）', () => {
  test('非 pending → 任意工具调用都未 block', () => {
    const store = createPendingDecisionStore()
    const handler = createAskPendingGuardHandler(store, 's1')

    expect(handler({ toolName: 'create_brief' })).toBeUndefined()
    expect(handler({ toolName: 'ask_user_question' })).toBeUndefined()
    expect(handler({ toolName: 'setup_design' })).toBeUndefined()
    expect(handler({ toolName: 'bash' })).toBeUndefined()
  })

  test('session 隔离：s1 pending 不影响 s2', () => {
    const store = createPendingDecisionStore()
    store.registerAsk('s1', 'ask-1')
    const handler = createAskPendingGuardHandler(store, 's2')

    expect(handler({ toolName: 'create_brief' })).toBeUndefined()
  })

  test('resolve 后非 ask 工具不再 block', () => {
    const store = createPendingDecisionStore()
    store.registerAsk('s1', 'ask-1')
    const handler = createAskPendingGuardHandler(store, 's1')

    store.resolveAsk('ask-1', { skip: true })
    expect(handler({ toolName: 'create_brief' })).toBeUndefined()
  })
})
