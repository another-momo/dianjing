import { describe, expect, test } from 'bun:test'

import { memoizeAsync } from '#core/memoize-async'

describe('memoizeAsync（async 单例 in-flight 记忆化）', () => {
  test('并发调用共享同一次 factory 执行，结果同一引用', async () => {
    let calls = 0
    const get = memoizeAsync(async () => ({ id: ++calls }))
    const [a, b, c] = await Promise.all([get(), get(), get()])
    expect(calls).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  test('成功后永久缓存，factory 不再执行', async () => {
    let calls = 0
    const get = memoizeAsync(async () => ++calls)
    await get()
    await get()
    expect(calls).toBe(1)
  })

  test('失败清零允许重试：reject 后下次调用重新执行 factory', async () => {
    let calls = 0
    let fail = true
    const get = memoizeAsync(async () => {
      calls++
      if (fail) throw new Error('wasm fetch failed')
      return calls
    })
    await expect(get()).rejects.toThrow('wasm fetch failed')
    fail = false
    await expect(get()).resolves.toBe(2)
    expect(calls).toBe(2)
  })

  test('并发批次共享同一 rejection，批次结束后重试可成功', async () => {
    let calls = 0
    const get = memoizeAsync(async () => {
      calls++
      if (calls === 1) throw new Error('first attempt failed')
      return calls
    })
    const results = await Promise.allSettled([get(), get()])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(calls).toBe(1)
    await expect(get()).resolves.toBe(2)
    expect(calls).toBe(2)
  })

  test('参数仅首次调用生效', async () => {
    const seen: string[] = []
    const get = memoizeAsync(async (tag: string) => {
      seen.push(tag)
      return tag
    })
    const [a, b] = await Promise.all([get('first'), get('second')])
    expect(a).toBe('first')
    expect(b).toBe('first')
    expect(seen).toEqual(['first'])
  })
})
