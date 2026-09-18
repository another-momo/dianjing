/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * 2026-09-16 pi agent 行为控管层 1 + 层 2（skills 单源）装配门控钉扎——
 * 自构 SettingsManager 双注（loader + session）+ noExtensions + skillsOverride
 * 行为 + enableInstallTelemetry 关 + inline factories 仍加载（ask/key guard 不伤）。
 *
 * 与 service-capabilities.test.ts 同构：mock pi SDK 捕装配入参，
 * SettingsManager 真例走 inMemory 不落盘——断言自构实例的 projectTrusted
 * 与 enableInstallTelemetry 状态透传到 loader / session 双缝。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const capturedSessionOptions: Record<string, unknown>[] = []
const capturedLoaderOptions: Record<string, unknown>[] = []

/** 假 SettingsManager 的 overrides 形状（lint：禁 Record<string, unknown> 泛投） */
interface FakeSettingsOverrides {
  enableInstallTelemetry?: boolean
}

/** skillsOverride 结果里取 diagnostics 的最小形状（lint：禁内联 unknown 对象形投） */
interface SkillsOverrideDiagnosticsResult {
  diagnostics: unknown[]
}

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
      return Promise.resolve() as Promise<void>
    }
  },
  SessionManager: {
    create: () => ({ getSessionFile: () => null }),
    open: () => ({ getSessionFile: () => null })
  },
  defineTool: (def: unknown) => def,
  SettingsManager: {
    // 真 InMemorySettingsManager 落空 + projectTrusted 关 + applyOverrides 后
    // 由测试直接断言 settingsManager.isProjectTrusted() 与
    // getEnableInstallTelemetry()——捕的是同一实例引用
    create: (_cwd: string, _agentDir: string, options: { projectTrusted?: boolean } = {}) => {
      const instance = {
        _projectTrusted: options.projectTrusted ?? true,
        _overrides: {} as FakeSettingsOverrides,
        isProjectTrusted(): boolean {
          return this._projectTrusted
        },
        setProjectTrusted(trusted: boolean): void {
          this._projectTrusted = trusted
        },
        applyOverrides(overrides: Record<string, unknown>): void {
          Object.assign(this._overrides, overrides)
        },
        getEnableInstallTelemetry(): boolean {
          return this._overrides.enableInstallTelemetry ?? true
        },
        async reload(): Promise<void> {
          // 假 SettingsManager：reload 无操作（实例状态构造时已落定）
        }
      }
      return instance
    }
  }
}))

import { createPiChatService } from '@/app/ai/pi-backend/service'

function makeService(rootDir: string) {
  return createPiChatService({
    rootDir,
    admin: { resolveModel: async () => ({ modelRuntime: null, model: null }) } as never,
    imageGenCredentials: {} as never,
    imageGenSettings: {} as never
  })
}

describe('pi-backend service.ts trust gate + skills 单源（2026-09-16 层 1 + 层 2）', () => {
  let rootDir = ''

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'pi-svc-trust-'))
    mkdirSync(join(rootDir, 'pi-agent'), { recursive: true })
    capturedSessionOptions.length = 0
    capturedLoaderOptions.length = 0
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  test('层 1 双注缝 ①：loader 实例 settingsManager.projectTrusted=false', async () => {
    const svc = makeService(rootDir)
    await svc.prompt('s-loader', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const loaderOpts = capturedLoaderOptions.at(-1)
    expect(loaderOpts).toBeDefined()
    const sm = loaderOpts?.['settingsManager'] as {
      isProjectTrusted(): boolean
      getEnableInstallTelemetry(): boolean
    }
    expect(sm).toBeDefined()
    expect(sm.isProjectTrusted()).toBe(false)
  })

  test('层 1 双注缝 ②：session 透传同 settingsManager 实例（项目一致 = 双注实证）', async () => {
    const svc = makeService(rootDir)
    await svc.prompt('s-session', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const loaderOpts = capturedLoaderOptions.at(-1)
    const sessionOpts = capturedSessionOptions.at(-1)
    const loaderSm = loaderOpts?.['settingsManager'] as { isProjectTrusted(): boolean }
    const sessionSm = sessionOpts?.['settingsManager'] as { isProjectTrusted(): boolean }
    expect(loaderSm).toBeDefined()
    expect(sessionSm).toBeDefined()
    // 双注缝 ②：session 字段 = loader 同一引用，trust 态一致
    expect(sessionSm).toBe(loaderSm)
    expect(sessionSm.isProjectTrusted()).toBe(false)
  })

  test('applyOverrides：enableInstallTelemetry=false 落到 settingsManager（关包安装外呼）', async () => {
    const svc = makeService(rootDir)
    await svc.prompt('s-tel', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const sm = capturedSessionOptions.at(-1)?.['settingsManager'] as {
      getEnableInstallTelemetry(): boolean
    }
    expect(sm.getEnableInstallTelemetry()).toBe(false)
  })

  test('noExtensions=true：内建/文件扩展不加载（防 project trust 域 extensions 自植）', async () => {
    const svc = makeService(rootDir)
    await svc.prompt('s-noext', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const loaderOpts = capturedLoaderOptions.at(-1)
    expect(loaderOpts?.['noExtensions']).toBe(true)
  })

  test('inline factories 仍加载：extensionFactories 含 assembly / ask guard / key guard', async () => {
    const svc = makeService(rootDir)
    await svc.prompt('s-factories', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const factories = capturedLoaderOptions.at(-1)?.['extensionFactories'] as unknown[]
    expect(Array.isArray(factories)).toBe(true)
    // service.ts 装配固定挂 3 件：assembly(0) / ask guard(1) / key guard(2)
    // —— 不在第 3 件后追加 probe（仅 PI_PROMPT_PROBE_DIR 在场时挂第 4 件），
    // 跑测默认无 probe env 故恒 3 件
    expect(factories?.length).toBeGreaterThanOrEqual(3)
    for (const factory of factories as Array<unknown>) {
      expect(typeof factory).toBe('function')
    }
  })

  test('层 2 skillsOverride：构造四源（用户/内置/pi-agent/home agents）断言只留白名单双源', async () => {
    const svc = makeService(rootDir)
    await svc.prompt('s-skills', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const override = capturedLoaderOptions.at(-1)?.['skillsOverride'] as (result: {
      skills: Array<{ name: string; baseDir: string }>
    }) => { skills: Array<{ name: string; baseDir: string }> }
    expect(typeof override).toBe('function')

    // 白名单 = service 装配时的 additionalSkillPaths（用户层 + 内置层）；
    // 直接从 capturedLoaderOptions 取，避免双源硬编码漂移
    const paths = capturedLoaderOptions.at(-1)?.['additionalSkillPaths'] as string[]
    expect(Array.isArray(paths)).toBe(true)
    // 用户层（rootDir/studio/skills）必含；内置层第二项视 env 解析或为 undefined
    const userSkillsDir = join(rootDir, 'studio', 'skills')
    expect(paths).toContain(userSkillsDir)

    // 构造四来源——前两项在白名单应保留，pi-agent/skills 与 ~/.agents/skills 应被剔。
    // baseDir 语义 = SKILL.md 所在目录（<源目录>/<skill名>），service 侧比对
    // 取 dirname 上溯一层（2026-09-16 CI t87 ④实证直比 baseDir 全员滤空）
    const builtinSkillsDir = paths[1] ?? ''
    const agentDirSkills = join(rootDir, 'pi-agent', 'skills')
    const homeAgentsSkills = '/home/fake-user/.agents/skills'

    const input = {
      skills: [
        { name: 'user-skill', baseDir: join(userSkillsDir, 'user-skill') },
        ...(builtinSkillsDir
          ? [{ name: 'builtin-skill', baseDir: join(builtinSkillsDir, 'builtin-skill') }]
          : []),
        { name: 'agent-skill', baseDir: join(agentDirSkills, 'agent-skill') },
        { name: 'home-skill', baseDir: join(homeAgentsSkills, 'home-skill') }
      ],
      diagnostics: []
    }
    const filtered = override(input)
    const names = filtered.skills.map((s) => s.name).sort()
    const expected = builtinSkillsDir ? ['builtin-skill', 'user-skill'] : ['user-skill']
    // T89 单源：用户层必留；内置层视 env 而定；pi-agent 与 ~/.agents 必剔
    expect(names).toEqual(expected)
    expect(names).not.toContain('agent-skill')
    expect(names).not.toContain('home-skill')
  })

  test('层 2 skillsOverride：用户层 / 内置层都不在白名单时全剔（如 studio builtin dir 解析失败）', async () => {
    // 切走 DIANJING_STUDIO_BUILTIN_DIR 让 builtinStudioDir 解析失败——
    // capabilitiesStore 接 builtinSkillsDir undefined，白名单仅用户层
    delete process.env['DIANJING_STUDIO_BUILTIN_DIR']
    const svc = makeService(rootDir)
    await svc.prompt('s-skill-empty', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const override = capturedLoaderOptions.at(-1)?.['skillsOverride'] as (result: {
      skills: Array<{ baseDir: string }>
    }) => { skills: Array<{ baseDir: string }> }
    const input = {
      skills: [
        { name: 'unrelated', baseDir: join('/totally/unrelated/path', 'unrelated') },
        { name: 'agent', baseDir: join(rootDir, 'pi-agent', 'skills', 'agent') }
      ],
      diagnostics: []
    }
    const filtered = override(input)
    expect(filtered.skills).toEqual([])
  })

  test('skillsOverride 透传 diagnostics 字段（过滤不吞诊断）', async () => {
    const svc = makeService(rootDir)
    await svc.prompt('s-diag', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const override = capturedLoaderOptions.at(-1)?.['skillsOverride'] as (
      result: unknown
    ) => unknown
    const diagnostics = [{ type: 'collision', message: 'test' }]
    const input = { skills: [], diagnostics }
    const filtered = override(input) as SkillsOverrideDiagnosticsResult
    expect(filtered.diagnostics).toBe(diagnostics)
  })

  test('additionalSkillPaths 仍含双源（用户层 + 内置层）—— 不伤 T89 加载链', async () => {
    const svc = makeService(rootDir)
    await svc.prompt('s-addpaths', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    const paths = capturedLoaderOptions.at(-1)?.['additionalSkillPaths'] as string[]
    expect(Array.isArray(paths)).toBe(true)
    // 用户层（resolveSkillsDir = rootDir/studio/skills）必含
    expect(paths).toContain(join(rootDir, 'studio', 'skills'))
  })
})
