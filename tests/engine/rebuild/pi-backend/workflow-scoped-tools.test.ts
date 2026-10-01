/**
 * workflow 级工具面收放（frontmatter `tools` 白名单）钉扎。
 *
 * 机制：凡被任一 workflow `tools:` 点名的工具 = 条件工具，只在点名它的
 * workflow 激活的回合进会话活动集；其余工具常驻。注册面不动——条件工具全量
 * 注册进会话工具表，每回合由 resolveActiveToolNames 按 mode 收放活动集
 * （service 在 prompt 前调 setActiveToolsByName）。
 *
 * 覆盖：
 *  1. 存在性闸（validate.parseTools）：点名的工具必须在工具面全集（core +
 *     extended + fork）内——打错名 / 空清单 / 非字符串条目 → 整条不注册 +
 *     failures 显式条目；合法则透传进注册条目
 *  2. 内置资产面：两个长图 workflow 的 tools 白名单透传；其余内置 workflow
 *     无 tools 字段
 *  3. 激活集合成（装配面快照）：hero 回合两件全在 / structure 回合只有
 *     compose_backdrop / general 与其他 mode 两件都不在；输出保持基线序
 *  4. host 回合组装把 resolvedWorkflow.tools 透传进 TurnAssembly.tools
 *  5. 钩子覆盖关系与注册序：真 SDK 在干净子进程探针里跑（同目录
 *     workflow-scoped-tools-probe.ts——bun mock.module 全进程共享，钉真 SDK
 *     行为不进套件进程）。钉：setActiveToolsByName 后 SDK 重建 base prompt
 *     接管 state.systemPrompt；下一回合装配钩子（extensionFactories 排第一，
 *     emit 按注册序串行链式覆盖）整段替换赢回——state.systemPrompt 含
 *     `# studio base` / `# workflow: <id>` 头行，不含 SDK 重建段标记；
 *     readonly 档白名单（内建只读四件 + 全部 customTools 名）下切换同样放行
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createActiveDesignHost,
  resolveActiveToolNames
} from '@/app/ai/pi-backend/active-design-host'
import { loadStudioFromDirs } from '@/app/ai/pi-backend/studio'
import { createOpenPencilTools } from '@/app/ai/pi-backend/tools'

const BUILTIN_DIR = join(import.meta.dir, '../../../../src/app/ai/pi-backend/studio')
const PROBE_SCRIPT = join(import.meta.dir, 'workflow-scoped-tools-probe.ts')

const HERO_TOOLS = ['compose_backdrop', 'prepare_hero_scaffold']
const STRUCTURE_TOOLS = ['compose_backdrop']

let builtinDir = ''
let userDir = ''

beforeEach(() => {
  builtinDir = mkdtempSync(join(tmpdir(), 'studio-builtin-'))
  userDir = mkdtempSync(join(tmpdir(), 'studio-user-'))
})

afterEach(() => {
  rmSync(builtinDir, { recursive: true, force: true })
  rmSync(userDir, { recursive: true, force: true })
})

function put(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

const BASE_MD = `---
id: base
label: 工作守则
---

## 红线

事实零虚构。
`

function workflowMd(id: string, toolsLine: string): string {
  return `---
id: ${id}
label: 长图设计
${toolsLine}
---

## 阶段定义

阶段 0-4。
`
}

describe('存在性闸（parseTools）', () => {
  test('tools 合法 → 注册并原样透传', () => {
    put(builtinDir, 'base.md', BASE_MD)
    put(
      builtinDir,
      join('workflows', 'longform', 'workflow.md'),
      workflowMd('longform', 'tools: [compose_backdrop, render]')
    )
    const r = loadStudioFromDirs(builtinDir, userDir)
    expect(r.failures).toEqual([])
    expect(r.workflows.get('longform')?.tools).toEqual(['compose_backdrop', 'render'])
  })

  test('tools 打错名 → 整条不注册 + failures 显式条目', () => {
    put(builtinDir, 'base.md', BASE_MD)
    put(
      builtinDir,
      join('workflows', 'longform', 'workflow.md'),
      workflowMd('longform', 'tools: [compose_backdorp]')
    )
    const r = loadStudioFromDirs(builtinDir, userDir)
    expect(r.workflows.has('longform')).toBe(false)
    expect(r.failures.length).toBe(1)
    expect(r.failures[0].kind).toBe('workflow')
    expect(r.failures[0].reason).toContain('compose_backdorp')
    expect(r.failures[0].reason).toContain('不在工具面内')
  })

  test('tools 空清单 / 非字符串条目 → 同闸拦截', () => {
    put(builtinDir, 'base.md', BASE_MD)
    put(
      builtinDir,
      join('workflows', 'wf-empty', 'workflow.md'),
      workflowMd('wf-empty', 'tools: []')
    )
    put(
      builtinDir,
      join('workflows', 'wf-nonstr', 'workflow.md'),
      workflowMd('wf-nonstr', 'tools: [42]')
    )
    const r = loadStudioFromDirs(builtinDir, userDir)
    expect(r.workflows.size).toBe(0)
    expect(r.failures.length).toBe(2)
    expect(r.failures.map((f) => f.reason).join('\n')).toContain('`tools` 不是非空清单')
    expect(r.failures.map((f) => f.reason).join('\n')).toContain('非字符串')
  })

  test('点名 AI 不可见件（exposure.ai:false）→ 闸拦，防 SDK 静默忽略伪成功', () => {
    put(builtinDir, 'base.md', BASE_MD)
    // place_image_from_bytes 注册表内但 exposure.ai:false（不进 agent 面）：真实
    // 存在，但点名它会闸绿而会话注册表无此件（setActiveToolsByName 静默忽略）。
    // 判定基 = AI 可见集（滤 eval 档 + exposure.ai:false），故此类点名被拦。
    put(
      builtinDir,
      join('workflows', 'wf-hidden', 'workflow.md'),
      workflowMd('wf-hidden', 'tools: [place_image_from_bytes]')
    )
    const r = loadStudioFromDirs(builtinDir, userDir)
    expect(r.workflows.has('wf-hidden')).toBe(false)
    expect(r.failures.map((f) => f.reason).join('\n')).toContain('不在工具面内')
  })
})

describe('内置资产面与激活集快照', () => {
  test('两个长图 workflow 的 tools 白名单透传；其余内置 workflow 无 tools 字段', () => {
    const r = loadStudioFromDirs(BUILTIN_DIR, userDir)
    expect(r.failures).toEqual([])
    expect(r.workflows.get('longform-hero-kv-first')?.tools).toEqual(HERO_TOOLS)
    expect(r.workflows.get('longform-structure-first')?.tools).toEqual(STRUCTURE_TOOLS)
    for (const [id, workflow] of r.workflows) {
      if (id === 'longform-hero-kv-first' || id === 'longform-structure-first') continue
      expect(workflow.tools).toBeUndefined()
    }
  })

  test('激活集合成：条件工具只在点名它的 workflow 回合在场，输出保持基线序', () => {
    const registry = loadStudioFromDirs(BUILTIN_DIR, userDir)
    const face = createOpenPencilTools().map((tool) => tool.name)
    // 注册面不动：条件工具仍在装配面内（收放只切活动集）
    expect(face).toContain('compose_backdrop')
    expect(face).toContain('prepare_hero_scaffold')

    const hero = resolveActiveToolNames(
      face,
      registry,
      registry.workflows.get('longform-hero-kv-first')?.tools
    )
    expect(hero).toContain('compose_backdrop')
    expect(hero).toContain('prepare_hero_scaffold')
    expect(hero.length).toBe(face.length)

    const structure = resolveActiveToolNames(
      face,
      registry,
      registry.workflows.get('longform-structure-first')?.tools
    )
    expect(structure).toContain('compose_backdrop')
    expect(structure).not.toContain('prepare_hero_scaffold')
    expect(structure.length).toBe(face.length - 1)

    // general / 未绑 workflow 回合：两件条件工具都不在场
    const general = resolveActiveToolNames(face, registry, undefined)
    expect(general).not.toContain('compose_backdrop')
    expect(general).not.toContain('prepare_hero_scaffold')
    expect(general.length).toBe(face.length - 2)

    // 顺序 = 基线序（只过滤不重排）：general 的每个名字按基线序单调出现
    let cursor = 0
    for (const name of general) {
      const at = face.indexOf(name, cursor)
      expect(at).toBeGreaterThanOrEqual(cursor)
      cursor = at + 1
    }
  })
})

describe('host 回合组装透传', () => {
  function makeHost(modeId: string, registry: ReturnType<typeof loadStudioFromDirs>) {
    return createActiveDesignHost({
      registry: () => registry,
      bridge: {
        probeSlot: async () => ({ currentPageId: 'page-1', docUuid: 'doc-1' }),
        probeBrief: async () => []
      },
      pageStateReader: () => ({ modeId, profileId: null, engagedPageId: 'page-1' })
    })
  }

  test('长图 workflow 回合：TurnAssembly.tools 透传白名单，prompt 含 workflow 头行', async () => {
    const registry = loadStudioFromDirs(BUILTIN_DIR, userDir)
    const host = makeHost('longform-hero-kv-first', registry)
    await host.prepareTurn('做图')
    const turn = host.turnAssembly()
    expect(turn?.tools).toEqual(HERO_TOOLS)
    expect(turn?.systemPrompt).toContain('# workflow: longform-hero-kv-first')
  })

  test('general 回合：TurnAssembly.tools 为空', async () => {
    const registry = loadStudioFromDirs(BUILTIN_DIR, userDir)
    const host = makeHost('general', registry)
    await host.prepareTurn('做图')
    expect(host.turnAssembly()?.tools).toEqual([])
  })
})

// ── 钩子覆盖关系与注册序（真 SDK 子进程探针） ──────────────────────────────

interface ProbeEvidence {
  turnTools: string[] | null
  initialActive: string[]
  /** 首次切换（general 回合语义：条件工具离场）后的活动集 */
  generalActive: string[]
  /** 首次切换后、回合前的 state.systemPrompt（SDK 重建产物） */
  afterSwitchPrompt: string
  /** 本回合（hero workflow）prompt 前校准的活动集 */
  turnActive: string[]
  seenByRecorder: string | null
  finalPrompt: string
  finalActive: string[]
  promptError: string | null
  readonlySwitchOk: boolean
  readonlyDetail: { initial: string[]; afterSwitch: string[] }
}

function runHookProbe(rootDir: string): ProbeEvidence {
  const result = Bun.spawnSync({
    cmd: [process.execPath, PROBE_SCRIPT, rootDir],
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (result.exitCode !== 0) {
    throw new Error(`探针子进程失败：${result.stderr.toString()}`)
  }
  return JSON.parse(result.stdout.toString()) as ProbeEvidence
}

test('切换后下一回合 state.systemPrompt 仍是装配产物（钩子覆盖关系与注册序）', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pi-workflow-tools-hook-'))
  try {
    const e = runHookProbe(rootDir)

    // 注册面：条件工具全量注册进会话（收放不动注册面，只切活动集）
    expect(e.initialActive).toContain('compose_backdrop')
    expect(e.initialActive).toContain('prepare_hero_scaffold')

    // 首切（general 回合语义）：条件工具离场、常驻件保留
    expect(e.generalActive).not.toContain('compose_backdrop')
    expect(e.generalActive).not.toContain('prepare_hero_scaffold')
    expect(e.generalActive).toContain('render')
    expect(e.generalActive.length).toBe(e.initialActive.length - 2)

    // 切换后、回合前：state.systemPrompt 被 SDK 重建接管（cwd 行在场、装配
    // 头行不在场）——证明没有装配钩子时 SDK 产物就是模型可见 prompt
    expect(e.afterSwitchPrompt).toContain('PIN-BASE-BODY')
    expect(e.afterSwitchPrompt).toContain('Current working directory:')
    expect(e.afterSwitchPrompt).not.toContain('# studio base')

    // 本回合（hero workflow）：prompt 前校准回含两件条件工具的活动集
    expect(e.turnTools).toEqual(HERO_TOOLS)
    expect(e.turnActive).toContain('compose_backdrop')
    expect(e.turnActive).toContain('prepare_hero_scaffold')

    // 回合后：装配钩子整段替换赢回——装配头行在场，SDK 重建段不泄漏
    expect(e.promptError === null || (e.promptError ?? '').includes('probe-sentinel')).toBe(true)
    expect(e.finalPrompt).toContain('# studio base')
    expect(e.finalPrompt).toContain('# workflow: longform-hero-kv-first')
    expect(e.finalPrompt).toContain('PIN-WORKFLOW-BODY')
    expect(e.finalPrompt).not.toContain('Available tools:')
    expect(e.finalPrompt).not.toContain('Current working directory:')

    // 注册序：排在装配钩子之后的只读探针读到的是替换后的装配产物（链式覆盖
    // 方向钉死——顺序反转则探针读到 SDK 基底，本断言红）
    expect(e.seenByRecorder).toBe(e.finalPrompt)

    // 活动集跨回合保持（回合重建 prompt 不冲掉工具面切换）
    expect(e.finalActive).toEqual(e.turnActive)

    // readonly 档组合冒烟：白名单（内建只读四件 + 全部 customTools 名）下
    // setActiveToolsByName 照常放行条件工具收放
    expect(e.readonlySwitchOk).toBe(true)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
