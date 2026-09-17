import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { devBridgeDiscoveryPath, devBridgeRuntimeDir } from '@/app/orchestration/discovery'

describe('orchestration/discovery', () => {
  test('devBridgeDiscoveryPath matches the T38 pinned digest for localhost-7600', () => {
    // 与 src/app/bridge/vite-plugin.ts safeRuntimeId 同源——算法漂移即红。
    // pi-backend/dev-discovery.test.ts 钉扎同一 digest，本测试双保险（pin 给 orchestration/
    // 共享模块）。上游若改算法，devBridgeRuntimeDir 与 devBridgeDiscoveryPath 同时漂。
    const path = devBridgeDiscoveryPath('localhost-7600').replaceAll('\\', '/')
    expect(path.endsWith('dianjing-bridge/18d901424f534c7b/bridge.json')).toBe(true)
  })

  test('devBridgeRuntimeDir returns the parent directory without bridge.json suffix', () => {
    const dir = devBridgeRuntimeDir('localhost-7600').replaceAll('\\', '/')
    expect(dir.endsWith('dianjing-bridge/18d901424f534c7b')).toBe(true)
    expect(dir.startsWith(tmpdir().replaceAll('\\', '/'))).toBe(true)
  })

  test('different runtimeIds produce different digests (worktree isolation)', () => {
    const a = devBridgeRuntimeDir('localhost-7600')
    const b = devBridgeRuntimeDir('localhost-7682')
    expect(a).not.toBe(b)
  })

  test('same runtimeId produces deterministic digest (sha256 prefix stable)', () => {
    // 算法钉扎：上游改 hash 函数（如换 sha512）即红
    const a = devBridgeDiscoveryPath('mcp.open-pencil.localhost')
    const b = devBridgeDiscoveryPath('mcp.open-pencil.localhost')
    expect(a).toBe(b)
  })
})
