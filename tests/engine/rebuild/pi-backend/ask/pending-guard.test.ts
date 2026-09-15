/**
 * 2026-09-15 ask_user_question 挂起期 tool_call guard 钉扎。
 *
 * 决策单 §4 Phase 1 第 1 项验收映射——service.ts 装配的 inline extension
 * 由 createAskPendingGuardExtension 包 createAskPendingGuardHandler 而成；
 * 测试直钉 handler（免 ExtensionAPI 桩件与类型断言）。
 *
 * 覆盖：
 *  - pending + 非 ask 工具 → {block:true, reason}
 *  - pending + ask 自身 → undefined（alreadyPending 错误结果更具体）
 *  - 非 pending → undefined（透传）
 *  - session 隔离；resolve 后放行
 */

import { describe, expect, test } from 'bun:test'

import { createAskPendingStore } from '@/app/ai/pi-backend/ask/pending'
import { createAskPendingGuardHandler } from '@/app/ai/pi-backend/service'

describe('createAskPendingGuardHandler', () => {
  test('pending + 非 ask 工具 → block + reason', () => {
    const store = createAskPendingStore()
    store.register('s1', 'ask-1')
    const handler = createAskPendingGuardHandler(store, 's1')

    const result = handler({ toolName: 'create_brief' })
    expect(result).toEqual({
      block: true,
      reason:
        "A form is awaiting the user's answer; wait for ask_user_question to return before calling further tools."
    })
  })

  test('pending + ask 自身 → undefined（alreadyPending 错误结果由 execute 内部处理）', () => {
    const store = createAskPendingStore()
    store.register('s1', 'ask-1')
    const handler = createAskPendingGuardHandler(store, 's1')

    expect(handler({ toolName: 'ask_user_question' })).toBeUndefined()
  })

  test('非 pending → 任意工具调用都未 block', () => {
    const store = createAskPendingStore()
    const handler = createAskPendingGuardHandler(store, 's1')

    expect(handler({ toolName: 'create_brief' })).toBeUndefined()
    expect(handler({ toolName: 'ask_user_question' })).toBeUndefined()
    expect(handler({ toolName: 'setup_design' })).toBeUndefined()
  })

  test('session 隔离：s1 pending 不影响 s2', () => {
    const store = createAskPendingStore()
    store.register('s1', 'ask-1')
    const handler = createAskPendingGuardHandler(store, 's2')

    expect(handler({ toolName: 'create_brief' })).toBeUndefined()
  })

  test('resolve 后非 ask 工具不再 block', () => {
    const store = createAskPendingStore()
    store.register('s1', 'ask-1')
    const handler = createAskPendingGuardHandler(store, 's1')

    store.resolveByFormId('ask-1', { skip: true })
    expect(handler({ toolName: 'create_brief' })).toBeUndefined()
  })
})
