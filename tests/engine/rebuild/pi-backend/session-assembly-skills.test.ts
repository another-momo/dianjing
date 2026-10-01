/**
 * skills 段拼回钉扎——before_agent_start 钩子整段替换 systemPrompt，SDK
 * buildSystemPrompt 拼出的 <available_skills> 清单段会随之被吞；装配层
 * 按 SDK 同口径（formatSkillsForPrompt + 仅 builtinTools 非 off 档）手动
 * 拼回尾段（钩子单源 = assembly.ts createTurnAssemblyExtension）。
 *
 * 确定性设计（2026-10-01 CI 红修复）：不走 assembleSession 整链也不在
 * 本进程加载真 SDK——bun mock.module 是 hoist + 全进程注册表且按解析
 * 路径去重，套件模式下 assembly.ts 与本测试的 SDK specifier 绑定都归
 * 首个加载者的桩所有，file URL / 查询串 / createRequire 均绕不过
 * （2026-10-01 逐项实证）。故真 SDK 段（真扫 SKILL.md fixture + 真
 * formatSkillsForPrompt）移入干净子进程执行（helpers.ts 末尾探针段，
 * import.meta.main 入口），本进程零 mock：真 studio registry 经真
 * createActiveDesignHost 组装回合，钩子工厂直取直调。断言为存在性口径
 * （非逐字节）：
 *  - 含 '<available_skills'——SDK 升级改清单段口径或拼回通路断裂 → 红；
 *  - 含 fixture skill 名——additionalSkillPaths 单源扫描断裂 → 红；
 *  - 回合组装 prompt（studio base）与 skills 段同时在场、skills 段在尾——
 *    「钩子替换 + 尾段拼回」的组合序钉扎；
 *  - 'off' 档不拼 skills 段；无回合组装（未 prepareTurn）钩子不替换。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createActiveDesignHost } from '@/app/ai/pi-backend/active-design-host'
import { resolveSkillsDir, resolveWorkspaceDir } from '@/app/ai/pi-backend/paths'
import { createTurnAssemblyExtension } from '@/app/ai/pi-backend/session/assembly'
import { getStudioRegistry } from '@/app/ai/pi-backend/studio'

const SKILL_NAME = 'pin-check'
const PROBE_SCRIPT = join(import.meta.dir, 'helpers.ts')

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

/** 钩子触发缝：把 extension 挂到假 pi 上，捕获 before_agent_start handler */
function captureHook(
  ext: ReturnType<typeof createTurnAssemblyExtension>
): (event: unknown) => unknown {
  let handler: ((event: unknown) => unknown) | undefined
  ext({
    on: (event: string, fn: unknown) => {
      if (event === 'before_agent_start') handler = fn as (event: unknown) => unknown
    }
  } as never)
  if (!handler) throw new Error('before_agent_start 钩子未注册')
  return handler
}

describe('session 装配 skills 段拼回钉扎（钩子产物）', () => {
  let rootDir = ''
  let workspaceDir = ''

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'pi-assembly-skills-'))
    workspaceDir = resolveWorkspaceDir(rootDir)
    mkdirSync(join(rootDir, 'pi-agent'), { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })
    writeFixture(rootDir)
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  /**
   * 干净子进程跑真 SDK 探针：真 DefaultResourceLoader 真扫 fixture +
   * 真 formatSkillsForPrompt 产物。父进程 mock 注册表不遗传，返回
   * { names, section } 供本进程钩子注入。
   */
  function runRealSkillsProbe(): { names: string[]; section: string } {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        PROBE_SCRIPT,
        workspaceDir,
        join(rootDir, 'pi-agent'),
        resolveSkillsDir(rootDir)
      ],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe'
    })
    if (result.exitCode !== 0) {
      throw new Error(`真 SDK 探针子进程失败：${result.stderr.toString()}`)
    }
    return JSON.parse(result.stdout.toString()) as { names: string[]; section: string }
  }

  /** 真 host：真 studio registry 组装回合；桥探针喂固定页身份 */
  function makeHost() {
    return createActiveDesignHost({
      registry: () => getStudioRegistry(rootDir),
      bridge: {
        probeSlot: async () => ({ currentPageId: 'page-view', docUuid: 'doc-pin' }),
        probeBrief: async () => []
      } as never,
      pageStateReader: () => null
    })
  }

  test('钩子产物含 <available_skills> 清单段与 fixture skill 名，且 skills 段在回合组装 prompt 之后', async () => {
    const probe = runRealSkillsProbe()
    // 真扫描层先钉：fixture skill 确在 SDK 扫描结果中（单源扫描通路）
    expect(probe.names).toContain(SKILL_NAME)
    const host = makeHost()
    const handler = captureHook(
      createTurnAssemblyExtension({
        turnAssembly: () => host.turnAssembly(),
        skillsSection: () => probe.section,
        builtinToolsMode: 'full'
      })
    )

    // 回合组装先行（钩子闭包读 host 缓存袋），再触发钩子拿替换后产物
    await host.prepareTurn('做图')
    const result = handler({ systemPrompt: 'SDK-ORIGINAL-PROMPT' }) as
      | { systemPrompt?: string; message?: { customType?: string } }
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
    // contextLines 经 message custom 通道随行（页身份行进 context 不进 UI 流）
    expect(result?.message?.customType).toBe('active-design-context')
  })

  test("builtinTools 'off' 档不拼 skills 段（与 SDK 自定义 prompt 分支 hasRead 判定同口径）", async () => {
    const probe = runRealSkillsProbe()
    const host = makeHost()
    const handler = captureHook(
      createTurnAssemblyExtension({
        turnAssembly: () => host.turnAssembly(),
        skillsSection: () => probe.section,
        builtinToolsMode: 'off'
      })
    )

    await host.prepareTurn('做图')
    const result = handler({ systemPrompt: 'SDK-ORIGINAL-PROMPT' }) as
      | { systemPrompt?: string }
      | undefined
    expect(result?.systemPrompt).toContain('PIN-BASE-BODY')
    expect(result?.systemPrompt).not.toContain('<available_skills')
  })

  test('无回合组装（未 prepareTurn）钩子不替换 systemPrompt', async () => {
    const probe = runRealSkillsProbe()
    const host = makeHost()
    const handler = captureHook(
      createTurnAssemblyExtension({
        turnAssembly: () => host.turnAssembly(),
        skillsSection: () => probe.section,
        builtinToolsMode: 'full'
      })
    )

    const result = handler({ systemPrompt: 'SDK-ORIGINAL-PROMPT' })
    expect(result).toBeUndefined()
  })
})
