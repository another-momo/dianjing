import { describe, expect, test } from 'bun:test'

import {
  MAX_AUTO_RESTARTS,
  RESTART_BACKOFF_MS,
  nextRestartDelay
} from '@/app/orchestration/restart'

describe('orchestration/restart', () => {
  test('returns the backoff schedule for valid counts', () => {
    expect(nextRestartDelay(0)).toBe(500)
    expect(nextRestartDelay(1)).toBe(1500)
    expect(nextRestartDelay(2)).toBe(4000)
  })

  test('returns null once max auto restarts is reached', () => {
    expect(nextRestartDelay(MAX_AUTO_RESTARTS)).toBeNull()
    expect(nextRestartDelay(MAX_AUTO_RESTARTS + 1)).toBeNull()
    expect(nextRestartDelay(100)).toBeNull()
  })

  test('returns null for negative counts', () => {
    // 防御性：调用方若传非法值（如 -1）走停手分支而非 throw
    expect(nextRestartDelay(-1)).toBeNull()
  })

  test('schedule matches T27 documented values', () => {
    // T27：500 / 1500 / 4000 ms——本测试钉扎防漂移（重构期易丢的常量大坑）
    expect(RESTART_BACKOFF_MS).toEqual([500, 1500, 4000])
    expect(MAX_AUTO_RESTARTS).toBe(3)
  })
})
