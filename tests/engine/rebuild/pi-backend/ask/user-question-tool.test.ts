/**
 * 2026-09-15 ask_user_question 软终止→硬阻断改造钉扎：工具工厂测试。
 *
 * 决策单 §4 Phase 1 第 1 项验收映射——execute 挂起 → 端点 resolve →
 * 作答/跳过作为本工具结果在同一 turn 返回：
 *  - 校验失败 → {error, message}（不挂起）
 *  - 挂起-作答：formId 派生、content 文本含「The user answered the form
 *    (formId=…).」、details {formId, status:'answered', questions, answers}
 *  - 挂起-跳过：content 含「The user skipped the form (formId=…). Proceed
 *    with your best judgment…」+ details {formId, status:'skipped', questions}
 *  - alreadyPending：同 session 第二表单 → {error:'ask_pending'}（硬错误结果）
 *  - formId 默认派生 = 'ask-' + toolCallId（双侧确定性）
 *  - onPendingRegistered 在 register 成功后回调（host 拿 formId→槽位映射用）
 *  - abort signal 注册时已 abort → reject 后挂起 promise 解锁为 Error('aborted')
 */

import { describe, expect, test } from 'bun:test'

import { createAskPendingStore, type AskPendingStore } from '@/app/ai/pi-backend/ask/pending'
import { createAskUserQuestionTool } from '@/app/ai/pi-backend/ask/user-question'

function singleSelect(id: string) {
  return {
    id,
    kind: 'single_select' as const,
    label: `Q ${id}`,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ]
  }
}

function textQ(id: string) {
  return { id, kind: 'text' as const, label: `Q ${id}` }
}

describe('createAskUserQuestionTool（execute 挂起 → 端点 resolve 路径）', () => {
  test('合法定义 → register 挂起；resolve(answers) → content+details 双带', async () => {
    const store = createAskPendingStore()
    const tool = createAskUserQuestionTool({
      store,
      sessionId: 's1'
      // 默认 makeId = 'ask-' + toolCallId
    })
    const input = { questions: [singleSelect('q1'), textQ('q2')] }
    const resultPromise = tool.execute('call-1', input, undefined)

    // store 已注册
    expect(store.hasPendingForSession('s1')).toBe(true)

    // resolve
    const ok = store.resolveByFormId('ask-call-1', {
      answers: { q1: { value: 'a' }, q2: { value: 'hello' } }
    })
    expect(ok).toBe('ok')

    const result = await resultPromise
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toContain('The user answered the form (formId=ask-call-1).')
    const details = result.details as {
      formId: string
      status: string
      questions: Array<{ id: string }>
      answers: Record<string, { value: string }>
    }
    expect(details.formId).toBe('ask-call-1')
    expect(details.status).toBe('answered')
    expect(details.questions.map((q) => q.id)).toEqual(['q1', 'q2'])
    expect(details.answers).toEqual({ q1: { value: 'a' }, q2: { value: 'hello' } })
    // 信封 JSON 嵌入 content（模型视野稳定）
    expect(text).toContain('[表单作答 formId=ask-call-1]')
    expect(text).toContain('"q1":{"value":"a"}')
  })

  test('resolve(skip:true) → status=skipped + 「Proceed with your best judgment…」', async () => {
    const store = createAskPendingStore()
    const tool = createAskUserQuestionTool({ store, sessionId: 's1' })
    const resultPromise = tool.execute('call-2', { questions: [singleSelect('q1')] }, undefined)
    expect(store.resolveByFormId('ask-call-2', { skip: true })).toBe('ok')
    const result = await resultPromise
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toContain('The user skipped the form (formId=ask-call-2).')
    expect(text).toContain('Proceed with your best judgment')
    const details = result.details as { status: string; questions: unknown; answers?: unknown }
    expect(details.status).toBe('skipped')
    expect(details.questions).toBeDefined()
    expect(details.answers).toBeUndefined()
  })

  test('校验失败 → {error, message}，不挂起（不注册 store）', async () => {
    const store = createAskPendingStore()
    const tool = createAskUserQuestionTool({ store, sessionId: 's1' })
    const result = await tool.execute('call-3', { questions: [] }, undefined)
    const details = result.details as { error?: string; formId?: string }
    expect(details.error).toBe('questions_bounds')
    expect(details.formId).toBeUndefined()
    expect(store.hasPendingForSession('s1')).toBe(false)
  })

  test('同 session 第二表单 → {error:ask_pending}，不挂起（execute 不阻塞）', async () => {
    const store = createAskPendingStore()
    const tool = createAskUserQuestionTool({ store, sessionId: 's1' })
    const first = tool.execute('call-a', { questions: [singleSelect('q1')] }, undefined)
    // 第二表单同 session（first 未 resolve）
    const second = await tool.execute('call-b', { questions: [singleSelect('q2')] }, undefined)
    const details = second.details as { error?: string; message?: string }
    expect(details.error).toBe('ask_pending')
    expect(typeof details.message).toBe('string')
    // 第一个仍挂起；解析收尾避免 unhandled
    store.resolveByFormId('ask-call-a', { skip: true })
    await first
  })

  test('formId 默认派生 = "ask-" + toolCallId（双侧确定性，无 makeId 注入）', async () => {
    const store: AskPendingStore = createAskPendingStore()
    const tool = createAskUserQuestionTool({ store, sessionId: 's1' })
    const p = tool.execute('xyz-abc', { questions: [singleSelect('q1')] }, undefined)
    expect(store.resolveByFormId('ask-xyz-abc', { skip: true })).toBe('ok')
    const result = await p
    const details = result.details as { formId: string }
    expect(details.formId).toBe('ask-xyz-abc')
  })

  test('makeId 注入 → 派生自定义', async () => {
    const store = createAskPendingStore()
    const tool = createAskUserQuestionTool({
      store,
      sessionId: 's1',
      makeId: (toolCallId) => `custom-${toolCallId}`
    })
    const p = tool.execute('tc-1', { questions: [singleSelect('q1')] }, undefined)
    expect(store.resolveByFormId('custom-tc-1', { skip: true })).toBe('ok')
    const result = await p
    const details = result.details as { formId: string }
    expect(details.formId).toBe('custom-tc-1')
  })

  test('onPendingRegistered 在 register 成功后立即触发（异步 resolve 前）', async () => {
    const store = createAskPendingStore()
    let observed: string | null = null
    const tool = createAskUserQuestionTool({
      store,
      sessionId: 's1',
      onPendingRegistered: (formId) => {
        observed = formId
      }
    })
    const p = tool.execute('call-x', { questions: [singleSelect('q1')] }, undefined)
    expect(observed).toBe('ask-call-x')
    store.resolveByFormId('ask-call-x', { skip: true })
    await p
  })

  test('alreadyPending 触发时 onPendingRegistered 不调用', async () => {
    const store = createAskPendingStore()
    let calls = 0
    const tool = createAskUserQuestionTool({
      store,
      sessionId: 's1',
      onPendingRegistered: () => {
        calls++
      }
    })
    const first = tool.execute('a', { questions: [singleSelect('q1')] }, undefined)
    expect(calls).toBe(1)
    await tool.execute('b', { questions: [singleSelect('q2')] }, undefined)
    expect(calls).toBe(1)
    store.resolveByFormId('ask-a', { skip: true })
    await first
  })

  test('signal 已 abort → register 立即 reject，execute 抛 Error（沿工具失败路径传播）', async () => {
    const store = createAskPendingStore()
    const tool = createAskUserQuestionTool({ store, sessionId: 's1' })
    const ac = new AbortController()
    ac.abort()
    // abort signal 触发 → store 立即 reject promise → execute await 抛 Error
    // （runPrompt subscribe mapToolExecutionEnd 把 isError 标 true；与 generate.ts
    // 已知限制平行——本工具必须接 signal，让错误沿工具失败路径传播）
    let thrown: unknown = null
    try {
      await tool.execute('c', { questions: [singleSelect('q1')] }, ac.signal)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('aborted')
    expect(store.hasPendingForSession('s1')).toBe(false)
  })
})
