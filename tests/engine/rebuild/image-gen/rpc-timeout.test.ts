/**
 * T54：桥超时钉扎（验收锚 T54-plan §3.2）——
 * OPENPENCIL_RPC_TIMEOUT_MS env 设置→生效；缺省 ≥ 240s+余量（生图 HTTP
 * 上限 240s，SP-b 实证旧缺省 20s 会掐断长调用）；pi-backend 桥调用 fetch
 * 超时 = 桥超时 + 余量。
 */
import { describe, expect, test } from 'bun:test'

import {
  BRIDGE_FETCH_MARGIN_MS,
  BRIDGE_RPC_DEFAULT_TIMEOUT_MS,
  bridgeCallTimeoutMs
} from '@/app/ai/pi-backend/image-gen/bridge-call'
import { DEFAULT_RPC_TIMEOUT_MS, rpcTimeoutMs } from '@/app/bridge/server/browser-rpc'

function saveEnv(): string | undefined {
  return process.env.OPENPENCIL_RPC_TIMEOUT_MS
}

function restoreEnv(saved: string | undefined): void {
  if (saved === undefined) delete process.env.OPENPENCIL_RPC_TIMEOUT_MS
  else process.env.OPENPENCIL_RPC_TIMEOUT_MS = saved
}

describe('桥 RPC 超时（automation/bridge/server/browser-rpc.ts）', () => {
  test('缺省 ≥ 240s 生图上限 + 余量', () => {
    const saved = saveEnv()
    try {
      delete process.env.OPENPENCIL_RPC_TIMEOUT_MS
      expect(rpcTimeoutMs()).toBe(DEFAULT_RPC_TIMEOUT_MS)
      expect(DEFAULT_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(240_000 + 30_000)
    } finally {
      restoreEnv(saved)
    }
  })

  test('env 设置 → 生效（调用时读取，非模块加载快照）', () => {
    const saved = saveEnv()
    try {
      process.env.OPENPENCIL_RPC_TIMEOUT_MS = '60000'
      expect(rpcTimeoutMs()).toBe(60_000)
      process.env.OPENPENCIL_RPC_TIMEOUT_MS = '300000'
      expect(rpcTimeoutMs()).toBe(300_000)
    } finally {
      restoreEnv(saved)
    }
  })

  test('非法 env 值回退缺省', () => {
    const saved = saveEnv()
    try {
      process.env.OPENPENCIL_RPC_TIMEOUT_MS = 'abc'
      expect(rpcTimeoutMs()).toBe(DEFAULT_RPC_TIMEOUT_MS)
    } finally {
      restoreEnv(saved)
    }
  })
})

describe('pi-backend 桥调用 fetch 超时（image-gen/bridge-call.ts）', () => {
  test('缺省与桥一致 + 余量（两处缺省不得漂移）', () => {
    const saved = saveEnv()
    try {
      delete process.env.OPENPENCIL_RPC_TIMEOUT_MS
      expect(BRIDGE_RPC_DEFAULT_TIMEOUT_MS).toBe(DEFAULT_RPC_TIMEOUT_MS)
      expect(bridgeCallTimeoutMs()).toBe(DEFAULT_RPC_TIMEOUT_MS + BRIDGE_FETCH_MARGIN_MS)
    } finally {
      restoreEnv(saved)
    }
  })

  test('env 贯穿：设置后桥调用超时随动', () => {
    const saved = saveEnv()
    try {
      process.env.OPENPENCIL_RPC_TIMEOUT_MS = '120000'
      expect(bridgeCallTimeoutMs()).toBe(120_000 + BRIDGE_FETCH_MARGIN_MS)
    } finally {
      restoreEnv(saved)
    }
  })
})
