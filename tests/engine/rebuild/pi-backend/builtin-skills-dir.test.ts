/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * layer-splitting 内置 skill 装配层 — 双测：
 *  1. resolveBuiltinSkillsDir 纯函数 join 语义
 *  2. service.ts additionalSkillPaths 在 DIANJING_STUDIO_BUILTIN_DIR 注入下
 *     把内置 skills 目录喂给 SDK DefaultResourceLoader（与用户层同构，
 *     双源语义：用户覆盖内置）
 *
 * 装配套路：mock @earendil-works/pi-coding-agent 捕 DefaultResourceLoader ctor
 * options.additionalSkillPaths（与同目录 service-capabilities.test.ts:14-63 同
 * 模式）；createPiChatService 时 service.ts:190 会读 readStudioBuiltinDir()，
 * 此时 process.env.DIANJING_STUDIO_BUILTIN_DIR 已被测试桩注入。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPiChatService } from '@/app/ai/pi-backend/service'

const capturedLoaderOptions: Record<string, unknown>[] = []

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async (options: Record<string, unknown>) => {
    return {
      session: {
        prompt: () => Promise.resolve(),
        subscribe: () => () => undefined,
        abort: () => Promise.resolve(),
        sessionManager: { getSessionFile: () => null }
      },
      options
    }
  },
  DefaultResourceLoader: class {
    constructor(options: Record<string, unknown>) {
      capturedLoaderOptions.push(options)
    }
    async reload(): Promise<void> {
      return Promise.resolve() as Promise<void>
    }
  },
  SessionManager: {
    create: () => ({ getSessionFile: () => null }),
    open: () => ({ getSessionFile: () => null })
  },
  defineTool: (def: unknown) => def,
  parseSessionEntries: () => []
}))

function makeService(rootDir: string) {
  return createPiChatService({
    rootDir,
    admin: { resolveModel: async () => ({ modelRuntime: null, model: null }) } as never,
    imageGenCredentials: {} as never,
    imageGenSettings: {} as never,
    mcpConnections: { list: () => [], get: () => null } as never
  })
}

describe('pi-backend/paths — resolveBuiltinSkillsDir', () => {
  test('appends skills/ under builtin studio dir', async () => {
    const { resolveBuiltinSkillsDir, SKILLS_SUBDIR } = await import('@/app/ai/pi-backend/paths')
    expect(resolveBuiltinSkillsDir('/opt/studio')).toBe(join('/opt/studio', SKILLS_SUBDIR))
    expect(resolveBuiltinSkillsDir('/opt/studio').replaceAll('\\', '/').endsWith('/skills')).toBe(
      true
    )
  })

  test('preserves trailing-segment semantics — empty string in would collapse to "skills"', async () => {
    // 边界：空字符串入参 join 形态退化（不是典型用法，但保证纯函数行为可推）
    const { resolveBuiltinSkillsDir } = await import('@/app/ai/pi-backend/paths')
    expect(resolveBuiltinSkillsDir('')).toBe('skills')
  })

  test('user-layer 与 builtin-layer 均以 skills/ 收尾（双源各挂自根）', async () => {
    // 用户层 = rootDir/workspace/.agents/skills（2026-09-18 重排）；内置层 =
    // <builtinStudioDir>/skills（内置目录名仍叫 studio——dot-directory 不进源码树）
    const { resolveBuiltinSkillsDir, resolveSkillsDir } = await import('@/app/ai/pi-backend/paths')
    const rootDir = '/state/root'
    const userLayer = resolveSkillsDir(rootDir)
    const builtinLayer = resolveBuiltinSkillsDir('/state/root/src/app/ai/pi-backend/studio')
    expect(userLayer.replaceAll('\\', '/').endsWith('/workspace/.agents/skills')).toBe(true)
    expect(builtinLayer.replaceAll('\\', '/').endsWith('/studio/skills')).toBe(true)
  })
})

describe('pi-backend service.ts — additionalSkillPaths pins builtin layer (layer-splitting)', () => {
  let rootDir = ''
  let builtinDir = ''
  let prevEnv: string | undefined

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'pi-svc-bsk-'))
    mkdirSync(join(rootDir, 'pi-agent'), { recursive: true })
    builtinDir = mkdtempSync(join(tmpdir(), 'pi-bsk-builtin-'))
    mkdirSync(join(builtinDir, 'skills'), { recursive: true }) // 内置 skills/ 子目录占位
    prevEnv = process.env.DIANJING_STUDIO_BUILTIN_DIR
    process.env.DIANJING_STUDIO_BUILTIN_DIR = builtinDir
    capturedLoaderOptions.length = 0
  })

  afterEach(() => {
    // 恢复 env — 避免污染同批其他测试（registry / open-studio-folder 都读该 env）
    if (prevEnv === undefined) {
      delete process.env.DIANJING_STUDIO_BUILTIN_DIR
    } else {
      process.env.DIANJING_STUDIO_BUILTIN_DIR = prevEnv
    }
  })

  test('additionalSkillPaths contains both user-layer and builtin-layer paths', async () => {
    const svc = makeService(rootDir)
    await svc.prompt('s-bsk', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })

    const opts = capturedLoaderOptions.at(-1)
    expect(opts).toBeDefined()
    const paths = opts?.additionalSkillPaths as string[] | undefined
    expect(Array.isArray(paths)).toBe(true)
    expect(paths?.length).toBe(2)

    // 用户层：rootDir/workspace/.agents/skills/（2026-09-18 重排）
    expect(paths?.[0].replaceAll('\\', '/')).toBe(
      join(rootDir, 'workspace', '.agents', 'skills').replaceAll('\\', '/')
    )

    // 内置层：<builtinDir>/skills/（env 注入直指 builtinDir，不再走 rootDir 默认拼接）
    expect(paths?.[1].replaceAll('\\', '/')).toBe(join(builtinDir, 'skills').replaceAll('\\', '/'))
  })

  test('without env override: builtin-layer falls back to rootDir/BUILTIN_STUDIO_SUBPATH/skills/', async () => {
    // 模拟「无 env 直跑 main.ts」——此时 service.ts:190 builtinStudioDir 走
    // join(rootDir, BUILTIN_STUDIO_SUBPATH) 兜底（paths.ts:188 fallback）。
    delete process.env.DIANJING_STUDIO_BUILTIN_DIR
    capturedLoaderOptions.length = 0

    const svc = makeService(rootDir)
    await svc.prompt('s-bsk-fb', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })

    const opts = capturedLoaderOptions.at(-1)
    const paths = opts?.additionalSkillPaths as string[] | undefined
    expect(paths?.length).toBe(2)
    // 内置层 = rootDir/src/app/ai/pi-backend/studio/skills/
    expect(paths?.[1].replaceAll('\\', '/')).toBe(
      join(rootDir, 'src', 'app', 'ai', 'pi-backend', 'studio', 'skills').replaceAll('\\', '/')
    )
  })
})
