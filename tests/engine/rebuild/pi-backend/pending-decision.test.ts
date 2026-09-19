/**
 * 2026-09-19 broker P1 件1：PendingDecisionStore 单元测试（自 ask/pending.test.ts
 * 迁移——AskPendingStore 抽象化为双族 kind 判别 store，ask 行为零变化回归 +
 * authz 族与双族判别钉扎）。
 *
 * 覆盖：
 *  - ask 族迁移回归（原 AskPendingStore 全量语义）：register 同 session 二次
 *    注册 alreadyPending、不同 session 独立、resolveAsk ok/not_found/二次
 *    resolve、rejectForSession 清理、abort signal 自动 reject、hasPending
 *  - authz 族：registerAuthz/resolveAuthz 闭环（allow-once/allow-rule/deny 载荷）
 *  - 双族判别：resolveAsk 对 authz 条目（及反向）→ 'not_found'（错族寻址）
 *  - 双族互斥：同 session 已挂 ask 再 registerAuthz → alreadyPending（一次一张卡）
 *  - pendingKindForSession：kind 返回与 resolve/reject 后归 null
 *
 * 单例（createPendingDecisionStore）跨实例共享——用 fresh factory each test 避免
 * 跨用例状态泄漏。no-silent-catch 纪律：拒绝路径必显式 reject(err)。
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import {
  createPendingDecisionStore,
  type PendingDecisionStore
} from '@/app/ai/pi-backend/pending-decision'

let store: PendingDecisionStore

beforeEach(() => {
  store = createPendingDecisionStore()
})

describe('PendingDecisionStore ask 族（迁移回归：registerAsk/resolveAsk）', () => {
  test('首次注册 → alreadyPending=false', () => {
    const result = store.registerAsk('s1', 'ask-1')
    expect(result.alreadyPending).toBe(false)
    expect(result.promise).toBeInstanceOf(Promise)
  })

  test('同 session 二次注册 → alreadyPending=true，返回旧 promise', () => {
    const first = store.registerAsk('s1', 'ask-1')
    const second = store.registerAsk('s1', 'ask-2')
    expect(second.alreadyPending).toBe(true)
    expect(second.promise).toBe(first.promise)
    // 旧条目未被覆盖——resolveAsk('ask-2') 应 not_found
    expect(store.resolveAsk('ask-2', { skip: true })).toBe('not_found')
    // 旧条目仍可被 resolveAsk('ask-1') 解锁
    expect(store.resolveAsk('ask-1', { skip: true })).toBe('ok')
  })

  test('不同 session 注册 → 各自独立挂起', async () => {
    const a = store.registerAsk('s1', 'ask-1')
    const b = store.registerAsk('s2', 'ask-2')
    expect(a.alreadyPending).toBe(false)
    expect(b.alreadyPending).toBe(false)
    expect(store.hasPendingForSession('s1')).toBe(true)
    expect(store.hasPendingForSession('s2')).toBe(true)
    // resolve s1 不影响 s2
    expect(store.resolveAsk('ask-1', { answers: { q1: { value: 'a' } } })).toBe('ok')
    expect(store.hasPendingForSession('s1')).toBe(false)
    expect(store.hasPendingForSession('s2')).toBe(true)
    // s2 promise 未 resolve → await 不挂死（验证 promise 是真的 pending）
    let resolved = false
    void b.promise.then(() => {
      resolved = true
      return null
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
  })

  test('resolve 后 promise → payload 解锁', async () => {
    const { promise } = store.registerAsk('s1', 'ask-1')
    store.resolveAsk('ask-1', { answers: { q1: { value: 'v' } } })
    await expect(promise).resolves.toEqual({ answers: { q1: { value: 'v' } } })
  })

  test('未知 formId → not_found', () => {
    expect(store.resolveAsk('nonexistent', { skip: true })).toBe('not_found')
  })

  test('同一 formId 二次 resolve → 第一次 ok，第二次 not_found', () => {
    store.registerAsk('s1', 'ask-1')
    expect(store.resolveAsk('ask-1', { skip: true })).toBe('ok')
    expect(store.resolveAsk('ask-1', { skip: true })).toBe('not_found')
  })

  test('skip payload 透传', async () => {
    const { promise } = store.registerAsk('s1', 'ask-1')
    store.resolveAsk('ask-1', { skip: true })
    await expect(promise).resolves.toEqual({ skip: true })
  })

  test('rejectForSession 触发 promise → Error 透传', async () => {
    const { promise } = store.registerAsk('s1', 'ask-1')
    const err = new Error('aborted')
    store.rejectForSession('s1', err)
    await expect(promise).rejects.toBe(err)
  })

  test('注册时 signal 已 abort → 立即 reject 并清条目', async () => {
    const ac = new AbortController()
    ac.abort()
    const { promise } = store.registerAsk('s1', 'ask-1', ac.signal)
    await expect(promise).rejects.toThrow('aborted')
    expect(store.hasPendingForSession('s1')).toBe(false)
  })

  test('注册后 abort → 自动 reject 并清条目', async () => {
    const ac = new AbortController()
    const { promise } = store.registerAsk('s1', 'ask-1', ac.signal)
    expect(store.hasPendingForSession('s1')).toBe(true)
    ac.abort()
    await expect(promise).rejects.toThrow('aborted')
    expect(store.hasPendingForSession('s1')).toBe(false)
  })
})

describe('PendingDecisionStore authz 族（registerAuthz/resolveAuthz）', () => {
  test('allow-once 载荷闭环', async () => {
    const { promise, alreadyPending } = store.registerAuthz('s1', 'authz-call-1')
    expect(alreadyPending).toBe(false)
    expect(store.resolveAuthz('authz-call-1', { decision: 'allow-once' })).toBe('ok')
    await expect(promise).resolves.toEqual({ decision: 'allow-once' })
  })

  test('allow-rule + ruleText 载荷闭环', async () => {
    const { promise } = store.registerAuthz('s1', 'authz-call-2')
    store.resolveAuthz('authz-call-2', { decision: 'allow-rule', ruleText: 'bun test *' })
    await expect(promise).resolves.toEqual({ decision: 'allow-rule', ruleText: 'bun test *' })
  })

  test('deny + note 载荷闭环', async () => {
    const { promise } = store.registerAuthz('s1', 'authz-call-3')
    store.resolveAuthz('authz-call-3', { decision: 'deny', note: '别动生产' })
    await expect(promise).resolves.toEqual({ decision: 'deny', note: '别动生产' })
  })

  test('注册后 abort signal → 自动 reject（等效 deny 由 guard 转换）', async () => {
    const ac = new AbortController()
    const { promise } = store.registerAuthz('s1', 'authz-call-4', ac.signal)
    ac.abort()
    await expect(promise).rejects.toThrow('aborted')
    expect(store.hasPendingForSession('s1')).toBe(false)
  })
})

describe('PendingDecisionStore 双族判别与互斥', () => {
  test('resolveAsk 对 authz 条目 → not_found（错族寻址）', () => {
    store.registerAuthz('s1', 'authz-1')
    expect(store.resolveAsk('authz-1', { skip: true })).toBe('not_found')
    // 错族 resolve 不消费条目——正确 kind 仍可解锁
    expect(store.resolveAuthz('authz-1', { decision: 'allow-once' })).toBe('ok')
  })

  test('resolveAuthz 对 ask 条目 → not_found（错族寻址）', () => {
    store.registerAsk('s1', 'ask-1')
    expect(store.resolveAuthz('ask-1', { decision: 'allow-once' })).toBe('not_found')
    expect(store.resolveAsk('ask-1', { skip: true })).toBe('ok')
  })

  test('同 session 已挂 ask 再 registerAuthz → alreadyPending（一次一张卡，双族互斥）', () => {
    const first = store.registerAsk('s1', 'ask-1')
    const second = store.registerAuthz('s1', 'authz-1')
    expect(second.alreadyPending).toBe(true)
    expect(second.promise).toBe(first.promise)
    expect(store.resolveAuthz('authz-1', { decision: 'deny' })).toBe('not_found')
  })

  test('同 session 已挂 authz 再 registerAsk → alreadyPending', () => {
    store.registerAuthz('s1', 'authz-1')
    const second = store.registerAsk('s1', 'ask-1')
    expect(second.alreadyPending).toBe(true)
    expect(store.resolveAsk('ask-1', { skip: true })).toBe('not_found')
  })

  test('rejectForSession 双族合计清理，返清理条数', async () => {
    const a = store.registerAuthz('s1', 'authz-1')
    store.registerAsk('s2', 'ask-2')
    // 消费 s1 promise 防止 unhandled rejection 报 false-fail
    void a.promise.catch(() => undefined)
    const cleared = store.rejectForSession('s1', new Error('aborted'))
    expect(cleared).toBe(1)
    expect(store.hasPendingForSession('s1')).toBe(false)
    expect(store.hasPendingForSession('s2')).toBe(true)
  })

  test('空 session rejectForSession → 返 0，不抛错', () => {
    expect(store.rejectForSession('unknown', new Error('aborted'))).toBe(0)
  })
})

describe('PendingDecisionStore.pendingKindForSession', () => {
  test('未注册 → null', () => {
    expect(store.pendingKindForSession('unknown')).toBe(null)
  })

  test('ask pending → "ask"；resolve 后归 null', () => {
    store.registerAsk('s1', 'ask-1')
    expect(store.pendingKindForSession('s1')).toBe('ask')
    store.resolveAsk('ask-1', { skip: true })
    expect(store.pendingKindForSession('s1')).toBe(null)
  })

  test('authz pending → "authz"；reject 后归 null', () => {
    const { promise } = store.registerAuthz('s1', 'authz-1')
    void promise.catch(() => undefined)
    expect(store.pendingKindForSession('s1')).toBe('authz')
    store.rejectForSession('s1', new Error('aborted'))
    expect(store.pendingKindForSession('s1')).toBe(null)
  })
})
