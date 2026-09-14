import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { devMCPDiscoveryPath, devMCPRuntimeDir } from '@/app/orchestration/discovery'

describe('orchestration/discovery', () => {
  test('devMCPDiscoveryPath matches the T38 pinned digest for localhost-7600', () => {
    // 与 src/app/bridge/vite-plugin.ts safeRuntimeId 同源——算法漂移即红。
    // pi-backend/dev-discovery.test.ts 钉扎同一 digest，本测试双保险（pin 给 orchestration/
    // 共享模块）。上游若改算法，devMCPRuntimeDir 与 devMCPDiscoveryPath 同时漂。
    const path = devMCPDiscoveryPath('localhost-7600').replaceAll('\\', '/')
    expect(path.endsWith('dianjing-mcp/18d901424f534c7b/mcp.json')).toBe(true)
  })

  test('devMCPRuntimeDir returns the parent directory without mcp.json suffix', () => {
    const dir = devMCPRuntimeDir('localhost-7600').replaceAll('\\', '/')
    expect(dir.endsWith('dianjing-mcp/18d901424f534c7b')).toBe(true)
    expect(dir.startsWith(tmpdir().replaceAll('\\', '/'))).toBe(true)
  })

  test('different runtimeIds produce different digests (worktree isolation)', () => {
    const a = devMCPRuntimeDir('localhost-7600')
    const b = devMCPRuntimeDir('localhost-7682')
    expect(a).not.toBe(b)
  })

  test('same runtimeId produces deterministic digest (sha256 prefix stable)', () => {
    // 算法钉扎：上游改 hash 函数（如换 sha512）即红
    const a = devMCPDiscoveryPath('mcp.open-pencil.localhost')
    const b = devMCPDiscoveryPath('mcp.open-pencil.localhost')
    expect(a).toBe(b)
  })
})
