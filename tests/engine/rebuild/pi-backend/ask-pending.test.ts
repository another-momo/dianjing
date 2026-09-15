/**
 * 2026-09-15 ask_user_question 软终止→硬阻断改造钉扎：AskPendingStore 单元测试。
 *
 * 覆盖（决策单 §4 Phase 1 第 1 项验收映射）：
 *  - register 同 session 第二次注册 → alreadyPending=true（不消费旧条目）
 *  - register 不同 session → 各自独立挂起
 *  - resolveByFormId → 'ok' / 'not_found' / resolve 后再次 resolve → 'not_found'
 *  - rejectForSession(sessionId) → reject 该 session 全部 pending，返清理条数
 *  - abort signal：注册时带已 abort 的 signal → 自动 reject；注册时未 abort
 *    后再 abort → 自动 reject 并清条目
 *  - hasPendingForSession（guard 用）：同 session 多次 pending 仍 true
 *
 * 单例（createAskPendingStore）跨实例共享——用 fresh factory each test 避免
 * 跨用例状态泄漏。no-silent-catch 纪律：拒绝路径必显式 reject(err)。
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import { createAskPendingStore, type AskPendingStore } from '@/app/ai/pi-backend/ask-pending'

let store: AskPendingStore

beforeEach(() => {
  store = createAskPendingStore()
})

describe('AskPendingStore.register', () => {
  test('首次注册 → alreadyPending=false', () => {
    const result = store.register('s1', 'ask-1')
    expect(result.alreadyPending).toBe(false)
    expect(result.promise).toBeInstanceOf(Promise)
  })

  test('同 session 二次注册 → alreadyPending=true，返回旧 promise', () => {
    const first = store.register('s1', 'ask-1')
    const second = store.register('s1', 'ask-2')
    expect(second.alreadyPending).toBe(true)
    expect(second.promise).toBe(first.promise)
    // 旧条目未被覆盖——resolveByFormId('ask-2') 应 not_found
    expect(store.resolveByFormId('ask-2', { skip: true })).toBe('not_found')
    // 旧条目仍可被 resolveByFormId('ask-1') 解锁
    expect(store.resolveByFormId('ask-1', { skip: true })).toBe('ok')
  })

  test('不同 session 注册 → 各自独立挂起', async () => {
    const a = store.register('s1', 'ask-1')
    const b = store.register('s2', 'ask-2')
    expect(a.alreadyPending).toBe(false)
    expect(b.alreadyPending).toBe(false)
    expect(store.hasPendingForSession('s1')).toBe(true)
    expect(store.hasPendingForSession('s2')).toBe(true)
    // resolve s1 不影响 s2
    expect(store.resolveByFormId('ask-1', { answers: { q1: { value: 'a' } } })).toBe('ok')
    expect(store.hasPendingForSession('s1')).toBe(false)
    expect(store.hasPendingForSession('s2')).toBe(true)
    // s2 promise 未 resolve → await 不挂死（验证 promise 是真的 pending）
    let resolved = false
    void b.promise.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
  })
})

describe('AskPendingStore.resolveByFormId', () => {
  test('resolve 后 promise → payload 解锁', async () => {
    const { promise } = store.register('s1', 'ask-1')
    store.resolveByFormId('ask-1', { answers: { q1: { value: 'v' } } })
    await expect(promise).resolves.toEqual({ answers: { q1: { value: 'v' } } })
  })

  test('未知 formId → not_found', () => {
    expect(store.resolveByFormId('nonexistent', { skip: true })).toBe('not_found')
  })

  test('同一 formId 二次 resolve → 第一次 ok，第二次 not_found', () => {
    store.register('s1', 'ask-1')
    expect(store.resolveByFormId('ask-1', { skip: true })).toBe('ok')
    expect(store.resolveByFormId('ask-1', { skip: true })).toBe('not_found')
  })

  test('skip payload 透传', async () => {
    const { promise } = store.register('s1', 'ask-1')
    store.resolveByFormId('ask-1', { skip: true })
    await expect(promise).resolves.toEqual({ skip: true })
  })
})

describe('AskPendingStore.rejectForSession', () => {
  test('reject 该 session 全部 pending（当前实现：同 session 最多 1 pending），返清理条数', async () => {
    const a = store.register('s1', 'ask-1')
    store.register('s2', 'ask-2')
    // 消费 s1 promise 防止 unhandled rejection 报 false-fail
    void a.promise.catch(() => undefined)
    const cleared = store.rejectForSession('s1', new Error('aborted'))
    expect(cleared).toBe(1)
    expect(store.hasPendingForSession('s1')).toBe(false)
    expect(store.hasPendingForSession('s2')).toBe(true)
  })

  test('reject 触发 promise → Error 透传', async () => {
    const { promise } = store.register('s1', 'ask-1')
    const err = new Error('aborted')
    store.rejectForSession('s1', err)
    await expect(promise).rejects.toBe(err)
  })

  test('空 session → 返 0，不抛错', () => {
    expect(store.rejectForSession('unknown', new Error('aborted'))).toBe(0)
  })
})

describe('AskPendingStore abort signal', () => {
  test('注册时 signal 已 abort → 立即 reject 并清条目', async () => {
    const ac = new AbortController()
    ac.abort()
    const { promise } = store.register('s1', 'ask-1', ac.signal)
    await expect(promise).rejects.toThrow('aborted')
    expect(store.hasPendingForSession('s1')).toBe(false)
  })

  test('注册后 abort → 自动 reject 并清条目', async () => {
    const ac = new AbortController()
    const { promise } = store.register('s1', 'ask-1', ac.signal)
    expect(store.hasPendingForSession('s1')).toBe(true)
    ac.abort()
    await expect(promise).rejects.toThrow('aborted')
    expect(store.hasPendingForSession('s1')).toBe(false)
  })

  test('无 signal 注册 → 走 resolve 路径正常', async () => {
    const { promise } = store.register('s1', 'ask-1')
    store.resolveByFormId('ask-1', { skip: true })
    await expect(promise).resolves.toEqual({ skip: true })
  })
})

describe('AskPendingStore.hasPendingForSession', () => {
  test('未注册 → false', () => {
    expect(store.hasPendingForSession('unknown')).toBe(false)
  })
  test('已注册且未 resolve/reject → true', () => {
    store.register('s1', 'ask-1')
    expect(store.hasPendingForSession('s1')).toBe(true)
  })
  test('已 resolve → false', () => {
    store.register('s1', 'ask-1')
    store.resolveByFormId('ask-1', { skip: true })
    expect(store.hasPendingForSession('s1')).toBe(false)
  })
})
