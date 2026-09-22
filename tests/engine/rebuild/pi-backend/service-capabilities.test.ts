/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * T87：service.ts 装配 capabilities seam——store 实例接进 service，
 * getStudioManifest 透传 capabilities + skills，getCapabilities/setCapabilities
 * 委托给 store。
 * T96：三档位装配门控钉扎——mock createAgentSession/DefaultResourceLoader
 * 捕获装配入参，钉 off→noTools:'builtin' / readonly→tools 只读四件+全部
 * 自定义工具名（SDK tools 是全局白名单，不带 customTools 会把设计工具一并
 * 禁用）/ full→两键全省略，及 noSkills 由 agentSkills 独控（与 builtinTools 解耦）。
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// T96：装配入参捕获袋（createAgentSession options + DefaultResourceLoader ctor）
const capturedSessionOptions: Record<string, unknown>[] = []
const capturedLoaderOptions: Record<string, unknown>[] = []

// mock pi SDK 同 service-abort.test：只桩 createAgentSession + DefaultResourceLoader，
// 其余走真实现（capabilities.ts 依赖真 loadSkillsFromDir）
mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async (options: Record<string, unknown>) => {
    capturedSessionOptions.push(options)
    return {
      session: {
        prompt: () => Promise.resolve(),
        subscribe: () => () => undefined,
        abort: () => Promise.resolve(),
        sessionManager: { getSessionFile: () => null }
      }
    }
  },
  DefaultResourceLoader: class {
    constructor(options: Record<string, unknown>) {
      capturedLoaderOptions.push(options)
    }
    async reload(): Promise<void> {
      // eslint-disable-next-line no-promise-executor-return -- 同步桩返回
      return Promise.resolve() as Promise<void>
    }
  },
  SessionManager: {
    create: () => ({ getSessionFile: () => null }),
    open: () => ({ getSessionFile: () => null })
  },
  defineTool: (def: unknown) => def,
  // T91c 修复：mock.module 是 process 级（bun:test 语义），
  // 同批跑的 marketing/ask-user-question-roundtrip.test.ts 用 readPiHistoryFile
  // 依赖真 parseSessionEntries；stub 成 () => [] 会让 roundtrip 测试拿到空历史。
  parseSessionEntries: (content: string): unknown[] => {
    const entries: unknown[] = []
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
        // oxlint-disable-next-line open-pencil/no-silent-catch -- 容错 skip 是 SDK 真语义：malformed 行静默跳过，非错误吞没
      } catch {
        // skip malformed
      }
    }
    return entries
  }
}))

import { createPiChatService } from '@/app/ai/pi-backend/service'

function makeService(rootDir: string) {
  return createPiChatService({
    rootDir,
    admin: { resolveModel: async () => ({ modelRuntime: null, model: null }) } as never,
    imageGenCredentials: {} as never,
    imageGenSettings: {} as never,
    mcpConnections: { list: () => [], get: () => null } as never
  })
}

describe('pi-backend service.ts capabilities seam（T87）', () => {
  let rootDir = ''

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'pi-svc-cap-'))
    mkdirSync(join(rootDir, 'pi-agent'), { recursive: true })
    capturedSessionOptions.length = 0
    capturedLoaderOptions.length = 0
  })

  test('getCapabilities：缺省 DEFAULTS（capabilities.json 不存在 → 失败安全兜底）', () => {
    const svc = makeService(rootDir)
    expect(svc.getCapabilities()).toEqual({ builtinTools: 'full', agentSkills: true })
  })

  test('setCapabilities → getCapabilities 往返：与 capabilitiesStore 实例共享', () => {
    const svc = makeService(rootDir)
    // T96：set 只给 agentSkills 时 builtinTools 保留旧值（缺省 'full'）
    expect(svc.setCapabilities({ agentSkills: true })).toEqual({
      builtinTools: 'full',
      agentSkills: true
    })
    expect(svc.getCapabilities()).toEqual({ builtinTools: 'full', agentSkills: true })

    // 落盘后可被新实例读出（验证持久化层一致）
    const svc2 = makeService(rootDir)
    expect(svc2.getCapabilities()).toEqual({ builtinTools: 'full', agentSkills: true })
  })

  test('setCapabilities 非布尔 → 抛错', () => {
    const svc = makeService(rootDir)
    expect(() => svc.setCapabilities({ agentSkills: 'yes' })).toThrow(/boolean/)
  })

  test('T96 setCapabilities 非法 builtinTools → 抛错', () => {
    const svc = makeService(rootDir)
    expect(() => svc.setCapabilities({ agentSkills: true, builtinTools: 'write' })).toThrow(
      /builtinTools/
    )
  })

  test('getStudioManifest：缺省（agentSkills ON）时 skills 如实扫描；空目录 → skills=[]', () => {
    const svc = makeService(rootDir)
    const manifest = svc.getStudioManifest()
    // 缺省 agentSkills=true——manifest.capabilities 随 DEFAULTS（2026-09-22 翻转 full）
    expect(manifest.capabilities).toEqual({ builtinTools: 'full', agentSkills: true })
    expect(manifest.skills).toEqual([])
  })

  test('getStudioManifest：capabilities ON 时 listSkills 反映 skills 扫描', () => {
    // T89 → D2 → 2026-09-18 重排：扫描目录现行 = workspace/.agents/skills
    const skillDir = join(rootDir, 'workspace', '.agents', 'skills', 'svc-test')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: svc-test
description: service 装配 seam 测试
---

正文
`,
      'utf8'
    )

    const svc = makeService(rootDir)
    svc.setCapabilities({ agentSkills: true, builtinTools: 'full' })
    const manifest = svc.getStudioManifest()
    expect(manifest.capabilities).toEqual({ builtinTools: 'full', agentSkills: true })
    expect(manifest.skills).toEqual([{ name: 'svc-test', description: 'service 装配 seam 测试' }])
  })

  test('setCapabilities OFF → manifest.skills=[]（listSkills 守门）', () => {
    const skillDir = join(rootDir, 'workspace', '.agents', 'skills', 'svc-test')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: svc-test
description: x
---

`,
      'utf8'
    )
    const svc = makeService(rootDir)
    svc.setCapabilities({ agentSkills: false })
    expect(svc.getStudioManifest().skills).toEqual([])
  })

  // ── T96：三档位装配门控（createAgentSession 入参捕获） ─────────────────

  test('T96 装配门控：builtinTools 缺省（2026-09-22 翻转 full 档）→ noTools/tools 两键全省略', async () => {
    const svc = makeService(rootDir)
    // 2026-09-22 翻转：缺省 readonly→full——装配面从 tools 白名单变全省略（SDK 默认）
    await svc.prompt('s-default', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const opts = capturedSessionOptions.at(-1)
    expect(opts).toBeDefined()
    expect('noTools' in (opts ?? {})).toBe(false)
    expect('tools' in (opts ?? {})).toBe(false)
  })

  test('T96 装配门控：builtinTools off（显式关）→ noTools:"builtin"，无 tools 键', async () => {
    const svc = makeService(rootDir)
    svc.setCapabilities({ agentSkills: true, builtinTools: 'off' })
    await svc.prompt('s-off', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const opts = capturedSessionOptions.at(-1)
    expect(opts).toBeDefined()
    expect(opts?.noTools).toBe('builtin')
    expect('tools' in (opts ?? {})).toBe(false)
  })

  test('T96 装配门控：builtinTools readonly → tools 只读四件 + 全部自定义工具，无 noTools 键', async () => {
    const svc = makeService(rootDir)
    svc.setCapabilities({ agentSkills: false, builtinTools: 'readonly' })
    await svc.prompt('s-ro', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const opts = capturedSessionOptions.at(-1)
    // SDK tools 语义是全局白名单（只激活名单内工具）——readonly 档必须把
    // customTools 名一并列入，否则设计工具全丢（owner 实测回归实证）
    const customNames = ((opts?.customTools ?? []) as Array<{ name: string }>).map(
      (tool) => tool.name
    )
    expect(customNames.length).toBeGreaterThan(0)
    expect(opts?.tools).toEqual(['read', 'grep', 'find', 'ls', ...customNames])
    expect('noTools' in (opts ?? {})).toBe(false)
  })

  test('T96 装配门控：builtinTools full → noTools/tools 两键全省略（SDK 默认）', async () => {
    const svc = makeService(rootDir)
    svc.setCapabilities({ agentSkills: true, builtinTools: 'full' })
    await svc.prompt('s-full', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const opts = capturedSessionOptions.at(-1)
    expect('noTools' in (opts ?? {})).toBe(false)
    expect('tools' in (opts ?? {})).toBe(false)
  })

  test('T96 解耦钉扎：noSkills 由 agentSkills 独控，与 builtinTools 无关', async () => {
    const svc = makeService(rootDir)
    // builtinTools full + agentSkills false → loader noSkills 仍 true
    svc.setCapabilities({ agentSkills: false, builtinTools: 'full' })
    await svc.prompt('s-noskills', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    expect(capturedLoaderOptions.at(-1)?.noSkills).toBe(true)
    // agentSkills true + builtinTools off → loader noSkills false，session 仍 noTools
    svc.setCapabilities({ agentSkills: true, builtinTools: 'off' })
    await svc.prompt('s-skills-only', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    expect(capturedLoaderOptions.at(-1)?.noSkills).toBe(false)
    expect(capturedSessionOptions.at(-1)?.noTools).toBe('builtin')
  })
})
