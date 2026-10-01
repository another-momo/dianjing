/**
 * workflow 工具面收放 × SDK 切换语义——真 SDK 探针（子进程入口）。
 *
 * 存在理由与 helpers.ts 探针同款：bun mock.module 是 hoist + 全进程注册表
 * 语义，套件进程内 specifier 绑定归首个加载者的桩所有——钉真 SDK 行为只能
 * 换干净子进程（父进程 mock 注册表不遗传）。
 *
 * 本探针以真 SDK createAgentSession + 真装配钩子（createTurnAssemblyExtension，
 * 排 extensionFactories 第一，镜像生产装配序）+ 真 host 回合组装 + 真工具面
 * （createOpenPencilTools 全集），实证：
 *  1. setActiveToolsByName 只切活动集——注册面不变，且 SDK 随之重建 base
 *     system prompt 接管 state.systemPrompt（重建标记 = cwd 行）；
 *  2. 下一回合 before_agent_start 链按注册序串行覆盖——装配钩子回传的整段
 *     替换体即最终 state.systemPrompt，SDK 重建段不泄漏；
 *  3. 注册在装配钩子之后的只读记录探针（生产冒烟探针同位）读到的是替换后的
 *     装配产物；
 *  4. readonly 档白名单（内建只读四件 + 全部 customTools 名，镜像生产装配）
 *     下切换同样放行。
 *
 * 模型面是桩（无活模型）：streamSimple 抛哨兵错误在装配钩子应用完之后——
 * state.systemPrompt 已在回合入口落定，错误只终止后续流。
 *
 * 用法：bun workflow-scoped-tools-probe.ts <rootDir>
 * stdout 回传 JSON 证据，断言在父进程测试文件（workflow-scoped-tools.test.ts）。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 探针收尾 dispose：失败只打印不抛（证据已从 stdout 回传，dispose 失败不影响断言） */
function safeDispose(session: { dispose(): void }, label: string): void {
  try {
    session.dispose()
  } catch (err) {
    console.warn(`[probe] ${label} dispose failed`, err)
  }
}

if (import.meta.main) {
  setTimeout(() => {
    console.error('探针超时')
    process.exit(2)
  }, 55000).unref()

  const rootDir = process.argv[2]
  if (!rootDir) throw new Error('usage: bun workflow-scoped-tools-probe.ts <rootDir>')
  // 收窄进具名常量：makeSession 闭包内 TS 不沿用 import.meta.main 顶部的 guard
  const sessionsRoot = rootDir
  const workspaceDir = join(rootDir, 'workspace')
  const agentDir = join(rootDir, 'pi-agent')
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(agentDir, { recursive: true })

  // 子进程内无 mock——specifier 直取真模块
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
    await import('@earendil-works/pi-coding-agent')
  const { createActiveDesignHost, resolveActiveToolNames } =
    await import('@/app/ai/pi-backend/active-design-host')
  const { createTurnAssemblyExtension } = await import('@/app/ai/pi-backend/session/assembly')
  const { createOpenPencilTools } = await import('@/app/ai/pi-backend/tools')

  const WORKFLOW_ID = 'longform-hero-kv-first'
  const WORKFLOW_TOOLS = ['compose_backdrop', 'prepare_hero_scaffold']

  // 合成 studio 注册表（形状同 StudioRegistry）：base + 一个带 tools 白名单的
  // workflow——避免依赖真实资产目录布局，钉的是机制不是资产内容
  const registry = {
    base: {
      kind: 'base',
      id: 'base',
      body: 'PIN-BASE-BODY：工作守则基座',
      origin: 'builtin',
      path: 'base.md'
    },
    workflows: new Map([
      [
        WORKFLOW_ID,
        {
          kind: 'workflow',
          id: WORKFLOW_ID,
          label: '长图设计（hero 主视觉先行）',
          body: 'PIN-WORKFLOW-BODY：长图流程',
          tools: WORKFLOW_TOOLS,
          origin: 'builtin',
          path: `workflows/${WORKFLOW_ID}/workflow.md`
        }
      ]
    ]),
    profiles: new Map(),
    modes: [],
    failures: [],
    resolvedReferences: new Map()
  } as never

  const host = createActiveDesignHost({
    registry: () => registry,
    bridge: {
      probeSlot: async () => ({ currentPageId: 'page-1', docUuid: 'doc-1' }),
      probeBrief: async () => []
    },
    pageStateReader: () => ({ modeId: WORKFLOW_ID, profileId: null, engagedPageId: 'page-1' })
  })

  // 只读记录探针：注册在装配钩子之后（生产冒烟探针同位），捕获链式覆盖后的
  // event.systemPrompt，不回传
  let seenByRecorder: string | null = null
  const recorder = (pi: { on: (event: string, fn: (event: unknown) => void) => void }) => {
    pi.on('before_agent_start', (event) => {
      seenByRecorder = (event as { systemPrompt: string }).systemPrompt
    })
  }

  const modelRuntime = {
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ apiKey: 'probe' }),
    isUsingOAuth: () => false,
    getAuth: async () => ({ apiKey: 'probe' }),
    streamSimple: () => Promise.reject(new Error('probe-sentinel: 探针无活模型'))
  }
  const model = {
    provider: 'probe',
    id: 'probe-model',
    api: 'probe',
    name: 'probe-model',
    baseUrl: 'http://127.0.0.1',
    reasoning: false,
    input: ['text']
  }

  async function makeSession(subdir: string, readonlyWhitelist: boolean) {
    const sessionsDir = join(sessionsRoot, 'pi-sessions', subdir)
    mkdirSync(sessionsDir, { recursive: true })
    const settingsManager = SettingsManager.create(workspaceDir, agentDir, {
      projectTrusted: false
    })
    settingsManager.applyOverrides({ enableInstallTelemetry: false })
    const assembly = createTurnAssemblyExtension({
      turnAssembly: () => host.turnAssembly(),
      skillsSection: () => '',
      builtinToolsMode: 'full'
    })
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspaceDir,
      agentDir,
      // 生产同位：loader 烘焙 base body 作兜底基底
      systemPrompt: (registry as { base: { body: string } }).base.body,
      settingsManager,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noExtensions: true,
      extensionFactories: [assembly, recorder]
    })
    await resourceLoader.reload()
    const customTools = createOpenPencilTools()
    const sessionOpts: Record<string, unknown> = {
      cwd: workspaceDir,
      agentDir,
      model,
      modelRuntime,
      sessionManager: SessionManager.create(workspaceDir, sessionsDir),
      resourceLoader,
      settingsManager,
      customTools
    }
    if (readonlyWhitelist) {
      // readonly 档生产装配同款：内建只读四件 + 全部 customTools 名
      sessionOpts.tools = ['read', 'grep', 'find', 'ls', ...customTools.map((tool) => tool.name)]
    }
    const { session } = await createAgentSession(sessionOpts as never)
    return session
  }

  // ── 主场景：首切（general 语义，条件工具离场）→ 回合前校准（hero 点名回归）
  //    → prompt 回合（装配钩子赢回 prompt）──
  const session = await makeSession('main', false)
  const initialActive = session.getActiveToolNames()

  // 首切：无 workflow 回合的激活集（条件工具离场）——SDK 重建接管 state prompt
  const generalActive = resolveActiveToolNames(initialActive, registry, [])
  session.setActiveToolsByName(generalActive)
  const afterSwitchActive = session.getActiveToolNames()
  const afterSwitchPrompt = session.systemPrompt

  // 本回合：组装（hero workflow 命中）→ prompt 前校准（条件工具回归）
  await host.prepareTurn('做图')
  const turn = host.turnAssembly()
  const turnActive = resolveActiveToolNames(initialActive, registry, turn?.tools)
  session.setActiveToolsByName(turnActive)
  const turnActiveAfter = session.getActiveToolNames()

  let promptError: string | null = null
  try {
    await session.prompt('做图')
  } catch (error) {
    promptError = error instanceof Error ? error.message : String(error)
  }
  const finalPrompt = session.systemPrompt
  const finalActive = session.getActiveToolNames()
  safeDispose(session, 'main session')

  // ── readonly 档组合冒烟：白名单会话下条件工具收放照常放行 ──
  const roSession = await makeSession('readonly', true)
  const roInitial = roSession.getActiveToolNames()
  const roDesired = resolveActiveToolNames(roInitial, registry, WORKFLOW_TOOLS)
  roSession.setActiveToolsByName(roDesired)
  const roAfter = roSession.getActiveToolNames()
  const roBack = resolveActiveToolNames(roInitial, registry, [])
  roSession.setActiveToolsByName(roBack)
  const roBackAfter = roSession.getActiveToolNames()
  safeDispose(roSession, 'readonly session')
  const readonlySwitchOk =
    roAfter.length === roDesired.length &&
    roAfter.every((name, i) => roDesired[i] === name) &&
    roBackAfter.length === roBack.length &&
    roBackAfter.every((name, i) => roBack[i] === name) &&
    roBackAfter.length === roInitial.length - 2

  process.stdout.write(
    JSON.stringify({
      turnTools: turn?.tools ?? null,
      initialActive,
      generalActive: afterSwitchActive,
      afterSwitchPrompt,
      turnActive: turnActiveAfter,
      seenByRecorder,
      finalPrompt,
      finalActive,
      promptError,
      readonlySwitchOk,
      readonlyDetail: { initial: roInitial, afterSwitch: roAfter }
    })
  )
}
