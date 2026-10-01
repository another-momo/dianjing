/* oxlint-disable open-pencil/no-module-mocking -- pi SDK 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * skills 段拼回钉扎——before_agent_start 钩子整段替换 systemPrompt，SDK
 * buildSystemPrompt 拼出的 <available_skills> 清单段会随之被吞；session 装配层
 * 按 SDK 同口径（formatSkillsForPrompt + 仅 builtinTools 非 off 档）手动拼回
 * 尾段。本文件走真实装配链验证钩子产物：真实 DefaultResourceLoader（真扫
 * SKILL.md fixture）+ 真 formatSkillsForPrompt + 真 studio registry 加载，仅
 * createAgentSession / SessionManager 打桩捕获装配入参。断言为存在性口径
 * （非逐字节）：
 *  - 含 '<available_skills'——SDK 升级改清单段口径或拼回通路断裂 → 测试红；
 *  - 含白名单 skill 名——skillsOverride 白名单滤空 / 装配档位错位 → 测试红；
 *  - 回合组装 prompt（studio base）与 skills 段同时在场、skills 段在尾——
 *    「钩子替换 + 尾段拼回」的组合序钉扎。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DefaultResourceLoader as RealDefaultResourceLoader,
  defineTool as realDefineTool,
  formatSkillsForPrompt as realFormatSkillsForPrompt,
  SettingsManager as RealSettingsManager
} from '@earendil-works/pi-coding-agent'

const capturedSessionOptions: Record<string, unknown>[] = []
const capturedLoaderOptions: Record<string, unknown>[] = []

// 部分打桩：仅 createAgentSession / SessionManager 换桩，其余 SDK 导出透传
// 真实现（DefaultResourceLoader 用真类子类捕获 ctor 入参——extensionFactories
// 装在 loader 侧，钩子产物 = 从捕获入参取出 inline factory 直接触发）。
mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async (options: Record<string, unknown>) => {
    capturedSessionOptions.push(options)
    return {
      session: {
        prompt: () => Promise.resolve(),
        subscribe: () => () => undefined,
        abort: () => Promise.resolve(),
        dispose: () => undefined,
        sessionManager: { getSessionFile: () => null }
      }
    }
  },
  DefaultResourceLoader: class extends RealDefaultResourceLoader {
    constructor(options: ConstructorParameters<typeof RealDefaultResourceLoader>[0]) {
      super(options)
      capturedLoaderOptions.push(options as Record<string, unknown>)
    }
  },
  SessionManager: {
    create: () => ({ getSessionFile: () => null }),
    open: () => ({ getSessionFile: () => null })
  },
  SettingsManager: RealSettingsManager,
  formatSkillsForPrompt: realFormatSkillsForPrompt,
  defineTool: realDefineTool
}))

import type { CapabilitiesStore } from '@/app/ai/pi-backend/capabilities'
import type { ImageGenCredentialStore } from '@/app/ai/pi-backend/image-gen/credentials'
import type { ImageGenSettingsStore } from '@/app/ai/pi-backend/image-gen/settings'
import type { MCPConnectionsStore } from '@/app/ai/pi-backend/mcp-connections/store'
import type { MCPClientPool } from '@/app/ai/pi-backend/mcp/mcp-pool'
import type { PendingDecisionStore } from '@/app/ai/pi-backend/pending-decision'
import type { ProviderAdmin } from '@/app/ai/pi-backend/provider-admin'
import { assembleSession } from '@/app/ai/pi-backend/session/assembly'

const SKILL_NAME = 'pin-check'

function writeFixture(rootDir: string): void {
  // 用户层资产双源：studio base（registry 加载）+ skill（SDK loader 扫描）
  const userStudioDir = join(rootDir, 'workspace', '.agents')
  mkdirSync(userStudioDir, { recursive: true })
  writeFileSync(join(userStudioDir, 'base.md'), '---\nid: base\n---\n\nPIN-BASE-BODY\n', 'utf8')
  const skillDir = join(userStudioDir, 'skills', SKILL_NAME)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: skills 段拼回钉扎 fixture\n---\n\n正文\n`,
    'utf8'
  )
}

function makeContext(rootDir: string) {
  return {
    rootDir,
    agentDir: join(rootDir, 'pi-agent'),
    sessionsDir: join(rootDir, 'pi-sessions'),
    builtinStudioDir: undefined,
    admin: {
      resolveModel: async () => ({ modelRuntime: null, model: null })
    } as unknown as ProviderAdmin,
    capabilitiesStore: {
      get: () => ({ builtinTools: 'full' as const, agentSkills: true, disabledSkills: [] })
    } as unknown as CapabilitiesStore,
    decisionStore: {} as unknown as PendingDecisionStore,
    activeDesignBridge: {
      probeSlot: async () => ({ currentPageId: 'page-view', docUuid: 'doc-pin' }),
      probeBrief: async () => []
    },
    imageGenCredentials: {} as unknown as ImageGenCredentialStore,
    imageGenSettings: {} as unknown as ImageGenSettingsStore,
    mcpConnections: { list: () => [] } as unknown as MCPConnectionsStore,
    mcpPool: {
      sync: async () => undefined,
      getProxyToolDefs: () => []
    } as unknown as MCPClientPool,
    readIndex: () => ({}),
    pageStateReader: () => null
  }
}

describe('session 装配 skills 段拼回钉扎（钩子产物）', () => {
  let rootDir = ''

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'pi-assembly-skills-'))
    mkdirSync(join(rootDir, 'pi-agent'), { recursive: true })
    mkdirSync(join(rootDir, 'pi-sessions'), { recursive: true })
    mkdirSync(join(rootDir, 'workspace'), { recursive: true })
    writeFixture(rootDir)
    capturedSessionOptions.length = 0
    capturedLoaderOptions.length = 0
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  test('before_agent_start 钩子产物含 <available_skills> 清单段与白名单 skill 名，且 skills 段在回合组装 prompt 之后', async () => {
    const ctx = makeContext(rootDir)
    const { host } = await assembleSession(ctx, 'pin-session', {
      providerId: 'pin-provider',
      modelId: 'pin-model'
    })

    // 钩子 factory 装在 loader 侧且注册序首位——从捕获入参取出后手动挂到假 pi
    const factories = (capturedLoaderOptions.at(-1)?.extensionFactories ?? []) as Array<
      (pi: unknown) => void
    >
    const assemblyFactory = factories[0]
    if (!assemblyFactory) throw new Error('装配钩子 factory 未随 loader 入参捕获')
    let handler: ((event: unknown) => unknown) | undefined
    assemblyFactory({
      on: (event: string, fn: unknown) => {
        if (event === 'before_agent_start') handler = fn as (event: unknown) => unknown
      }
    })
    if (!handler) throw new Error('before_agent_start 钩子未注册')

    // 回合组装先行（钩子闭包读 host 缓存袋），再触发钩子拿替换后产物
    await host.prepareTurn('做图')
    const result = handler({ systemPrompt: 'SDK-ORIGINAL-PROMPT' }) as
      | { systemPrompt?: string }
      | undefined
    const finalPrompt = result?.systemPrompt
    if (typeof finalPrompt !== 'string') throw new Error('钩子未返回 systemPrompt 替换值')

    expect(finalPrompt).toContain('PIN-BASE-BODY')
    expect(finalPrompt).toContain('<available_skills')
    expect(finalPrompt).toContain(SKILL_NAME)
    // 组合序：钩子整段替换为回合组装产物，skills 清单段手动拼回尾段
    expect(finalPrompt.indexOf('PIN-BASE-BODY')).toBeLessThan(
      finalPrompt.indexOf('<available_skills')
    )
  })
})
