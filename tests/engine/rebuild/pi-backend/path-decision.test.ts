/**
 * 2026-09-18 broker P0-1 判定面收编：decidePath（path-decision.ts）直钉单测。
 *
 * 覆盖：facet 两态入签名（现行 read/write 同语义）/ workspace 子树 allow
 * （含相对路径按缺省 workspace cwd 解析、workspace 本体）/ protectedWriteRoots
 * 命中 deny（denyCause='protected'）/ 出界 deny（denyCause='outside'）/
 * deny 侧 absolutePath 带出（P0-2 观测层消费）。
 *
 * fixture = 纯字符串路径运算（无真实 IO），与 key-guard.test.ts 同纪律。
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { decidePath } from '@/app/ai/pi-backend/path-decision'

const ROOT = resolve('/fake/pd-root')
const WORKSPACE = resolve(ROOT, 'workspace')

function decide(input: string, facet: 'read' | 'write' = 'read') {
  return decidePath(input, { facet, rootDir: ROOT, homeDir: ROOT })
}

describe('decidePath — facet 两态（现行同语义）', () => {
  test('workspace 子树绝对路径：read 与 write facet 均 allow（absolutePath 大小写保留）', () => {
    const target = resolve(WORKSPACE, 'Assets', 'Logo.PNG')
    for (const facet of ['read', 'write'] as const) {
      const d = decide(target, facet)
      expect(d.ok).toBe(true)
      if (d.ok) expect(d.absolutePath).toBe(target.replaceAll('\\', '/'))
    }
  })

  test('相对路径按缺省 cwd（workspace）解析 → allow', () => {
    const d = decide('logo.png')
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.absolutePath).toBe(resolve(WORKSPACE, 'logo.png').replaceAll('\\', '/'))
  })

  test('workspace 本体（恰等于 workspace 目录）→ allow', () => {
    expect(decide(WORKSPACE).ok).toBe(true)
  })
})

describe('decidePath — deny 双侧判别（denyCause + absolutePath）', () => {
  test('workspace/.agents/** → deny，denyCause=protected，absolutePath 带出', () => {
    const target = resolve(WORKSPACE, '.agents', 'skills', 'x', 'SKILL.md')
    const d = decide(target, 'write')
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.reason).toBe('denied')
      expect(d.denyCause).toBe('protected')
      expect(d.error).toContain('protected agent configuration area')
      expect(d.absolutePath).toBe(target.replaceAll('\\', '/'))
    }
  })

  test('pi-agent/**（~ 展开命中，homeDir=root）→ deny protected', () => {
    const d = decide('~/pi-agent/settings.json', 'write')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.denyCause).toBe('protected')
  })

  test('出界（rootDir 一级）→ deny，denyCause=outside', () => {
    const d = decide(resolve(ROOT, 'secret.png'))
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.denyCause).toBe('outside')
      expect(d.error).toContain('outside workspace')
    }
  })

  test('盘外绝对路径 → deny outside（read/write 同语义）', () => {
    for (const facet of ['read', 'write'] as const) {
      const d = decide('/etc/hosts/logo.png', facet)
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.denyCause).toBe('outside')
    }
  })
})
