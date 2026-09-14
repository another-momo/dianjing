import { describe, expect, test } from 'bun:test'

import { generateToken } from '@/app/orchestration/token'

describe('orchestration/token', () => {
  test('returns 32-character hex string', () => {
    const token = generateToken()
    expect(token).toMatch(/^[0-9a-f]{32}$/)
  })

  test('two consecutive calls produce different tokens', () => {
    // 16 random bytes 撞同值概率 2^-64——单测不应红
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
  })
})
