import { describe, expect, test } from 'bun:test'

import { waitForHealthPolling } from '@/app/orchestration/health'

describe('orchestration/health', () => {
  test('returns when probe becomes healthy within the timeout', async () => {
    let probeCalls = 0
    const onReady = (): void => {}
    await waitForHealthPolling({
      intervalMs: 5,
      timeoutMs: 200,
      probe: async () => {
        probeCalls++
        return probeCalls >= 3
      },
      onReady
    })
    expect(probeCalls).toBeGreaterThanOrEqual(3)
  })

  test('calls onTimeout without throwing when probe never becomes healthy (warn mode)', async () => {
    let onTimeoutCalls = 0
    let onReadyCalls = 0
    await waitForHealthPolling({
      intervalMs: 5,
      timeoutMs: 30,
      probe: async () => false,
      onReady: () => {
        onReadyCalls++
      },
      onTimeout: () => {
        onTimeoutCalls++
      }
    })
    expect(onReadyCalls).toBe(0)
    expect(onTimeoutCalls).toBe(1)
  })

  test('throws from onTimeout when caller wants throw semantics (host.ts semantic)', async () => {
    await expect(
      waitForHealthPolling({
        intervalMs: 5,
        timeoutMs: 30,
        probe: async () => false,
        onTimeout: () => {
          throw new Error('not ready in time')
        }
      })
    ).rejects.toThrow('not ready in time')
  })

  test('treats probe exceptions as not-ready (does not propagate)', async () => {
    // 探针内连接拒绝/404 即「未就绪」，属预期路径——waitForHealthPolling 内部
    // catch 静默；调用方决定是否在 onReady/onTimeout 内观察副作用
    let probeCalls = 0
    await waitForHealthPolling({
      intervalMs: 5,
      timeoutMs: 30,
      probe: async () => {
        probeCalls++
        throw new Error('ECONNREFUSED')
      },
      onReady: () => {},
      onTimeout: () => {}
    })
    expect(probeCalls).toBeGreaterThan(0)
  })

  test('aborts early when isAlive returns false (子进程已退出)', async () => {
    let probeCalls = 0
    let onTimeoutCalls = 0
    await waitForHealthPolling({
      intervalMs: 5,
      timeoutMs: 1000,
      isAlive: () => false,
      probe: async () => {
        probeCalls++
        return false
      },
      onTimeout: () => {
        onTimeoutCalls++
      }
    })
    // isAlive=false 立即放弃：probe 不应被调用，onTimeout 不触发
    expect(probeCalls).toBe(0)
    expect(onTimeoutCalls).toBe(0)
  })

  test('silently returns when onTimeout is omitted (no warn/throw path)', async () => {
    // 不传 onTimeout → 静默返回（与 Electron main 行为差异：Electron 必传 onTimeout
    // 打 warn，本路径仅校验省略 onTimeout 不抛错）
    await waitForHealthPolling({
      intervalMs: 5,
      timeoutMs: 20,
      probe: async () => false
    })
    // 仅断言「不抛」
  })
})
