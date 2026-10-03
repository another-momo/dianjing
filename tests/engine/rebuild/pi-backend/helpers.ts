/**
 * transport 测试共享 fetch 桩：记录请求（url/method/解析后 body）、
 * SSE 挂起响应（sendMessages 拿到 body 即返回，流不消费）、/cancel 分支
 * （204 / cancelFails 时抛错）。
 *
 * 还原纪律：消费文件必须在自身模块顶层 `afterEach(restoreFetch)`——
 * 本模块的模块级 afterEach 只挂在首个 import 者的文件作用域（bun 模块缓存
 * 致第二消费者不再执行模块体），曾在 CI 单进程分片内泄漏 hanging-SSE 桩
 * 全程污染后续文件的一切 fetch（2026-09-17 app shard 40 红实证）。
 *
 * 2026-09-18 CI 修红（run 35372599440，type-shapes 同形判重）：pi-backend
 * 桥桩（BridgeStub/bridgeStub）上移本模块——load-image 与
 * export-image-to-file 两测试文件的本地副本同形。纯桥桩不碰 globalThis，
 * 上述还原纪律不适用于该段（无需消费方 afterEach）。
 */

export interface FetchCall {
  url: string
  method: string | undefined
  body: unknown
}

const realFetch = globalThis.fetch

/** 还原 globalThis.fetch——每个消费文件各自注册 afterEach 调用（见头注）。 */
export function restoreFetch(): void {
  globalThis.fetch = realFetch
}

/** 挂起永不结束的 SSE 响应（sendMessages 拿到 body 即返回，不消费） */
function hangingSSEResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {
        /* 永不 enqueue——模拟进行中的 SSE 流 */
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

export function stubFetch(calls: FetchCall[], cancelFails = false): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url)
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null
    })
    if (url.endsWith('/cancel')) {
      if (cancelFails) throw new Error('network down')
      return new Response(null, { status: 204 })
    }
    return hangingSSEResponse()
  }) as typeof fetch
}

// ── pi-backend 桥桩（load-image / export-image-to-file 测试共用） ──

/** 桥调用记录 + 可注入结果/抛错的桥桩形态 */
export interface BridgeStub {
  calls: Array<{ tool: string; args: Record<string, unknown> }>
  callBridge: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/**
 * 桥桩工厂：记录调用 + 回 defaultResult；overrides.result 换桥结果（如错误
 * 形态）、overrides.throws 换连接级抛错。defaultResult 按被测工具的成功
 * 结果形态逐字给（两消费文件默认值不同，见各自本地包装）。
 */
export function bridgeStub(
  defaultResult: Record<string, unknown>,
  overrides: Partial<{
    result: Record<string, unknown>
    throws: Error
  }> = {}
): BridgeStub {
  const calls: BridgeStub['calls'] = []
  const callBridge = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args })
    if (overrides.throws) throw overrides.throws
    return overrides.result ?? defaultResult
  }
  return { calls, callBridge }
}

// ── 真 SDK skills 探针（子进程入口；import 本模块时惰性不执行）────────────
// 用法：bun helpers.ts <workspaceDir> <agentDir> <skillsDir>
// stdout 回传 JSON：{ names: 扫描到的 skill 名清单, section: formatSkillsForPrompt 产物 }。
// 存在理由：bun 模块注册表按解析路径去重，mock.module 生效后同进程内
// specifier / file URL / 查询串 / createRequire 拿到的都是桩（2026-10-01
// 逐项实证）——钉真 SDK 行为只能换干净子进程（父进程 mock 注册表不遗传）。
// 选项镜像 session/assembly.ts 生产装配（trust 关 + 上下文/模板/扩展全关 +
// 单源 additionalSkillPaths）——漂移由消费测试的断言暴露。
//
// 本文件承载两个子进程探针（bun mock.module 全进程注册表语义，钉真 SDK 行为
// 只能换干净子进程）：
//  1. skills 清单探针：bun helpers.ts <workspaceDir> <agentDir> <skillsDir>
//  2. workflow 工具面收放 × SDK 切换语义探针：bun helpers.ts <rootDir>
//     （1 个 argv 走 workflow 探针；3 个 argv 走 skills 探针）
if (import.meta.main) {
  if (process.argv.length === 3) {
    await runWorkflowToolsProbe(process.argv[2])
  } else {
    await runSkillsProbe()
  }
}

/** skills 清单探针（<workspaceDir> <agentDir> <skillsDir>）。 */
async function runSkillsProbe(): Promise<void> {
  const {
    DefaultResourceLoader,
    formatSkillsForPrompt,
    SettingsManager
    // 子进程内无 mock——specifier 直取真模块
  } = await import('@earendil-works/pi-coding-agent')
  const [workspaceDir, agentDir, skillsDir] = process.argv.slice(2)
  if (!workspaceDir || !agentDir || !skillsDir) {
    throw new Error('usage: bun helpers.ts <workspaceDir> <agentDir> <skillsDir>')
  }
  const settingsManager = SettingsManager.create(workspaceDir, agentDir, {
    projectTrusted: false
  })
  settingsManager.applyOverrides({ enableInstallTelemetry: false })
  const loader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir,
    systemPrompt: '',
    settingsManager,
    noContextFiles: true,
    noSkills: false,
    noPromptTemplates: true,
    noExtensions: true,
    additionalSkillPaths: [skillsDir]
  })
  await loader.reload()
  const skills = loader.getSkills().skills
  process.stdout.write(
    JSON.stringify({
      names: skills.map((skill) => skill.name),
      section: formatSkillsForPrompt(skills)
    })
  )
}

/** 探针收尾 dispose：失败只打印不抛（证据已从 stdout 回传，dispose 失败不影响断言）。 */
function safeDispose(session: { dispose(): void }, label: string): void {
  try {
    session.dispose()
  } catch (err) {
    console.warn(`[probe] ${label} dispose failed`, err)
  }
}

/**
 * workflow 工具面收放 × SDK 切换语义探针（<rootDir>）。
 *
 * 以真 SDK createAgentSession + 真装配钩子（createTurnAssemblyExtension，
 * 排 extensionFactories 第一，镜像生产装配序）+ 真 host 回合组装 + 真工具面
 * （createOpenPencilTools 全集），实证：
 *  1. setActiveToolsByName 只切活动集——注册面不变，且 SDK 随之重建 base
 *     system prompt 接管 state.systemPrompt（重建标记 = cwd 行）；
 *  2. 下一回合 before_agent_start 链按注册序串行覆盖——装配钩子回传的整段
 *     替换体即最终 state.systemPrompt，SDK 重建段不泄漏；
 *  3. 注册在装配钩子之后的只读记录探针（生产冒烟探针同位）读到的是替换后的
 *     装配产物；
 *  4. readonly 档白名单（内建只读四件 + 全部 customTools 名，镜像生产装配）
 *     下切换同样放行；
 *  5. 运行期收放 × 判定基收窄：AI 不可见件（eval 档 / exposure.ai:false）即使被
 *     workflow 白名单点名也不进活动集（resolve 层只摘不加 + SDK 未知名静默忽略
 *     双兜）；general 回合条件工具全离场、装配产物 base only。
 *
 * 模型面是桩（无活模型）：streamSimple 抛哨兵错误在装配钩子应用完之后——
 * state.systemPrompt 已在回合入口落定，错误只终止后续流。
 * stdout 回传 JSON 证据，断言在消费测试文件。
 */
async function runWorkflowToolsProbe(rootDir: string): Promise<void> {
  const { mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  setTimeout(() => {
    console.error('探针超时')
    process.exit(2)
  }, 55000).unref()

  if (!rootDir) throw new Error('usage: bun helpers.ts <rootDir>')
  // 收窄进具名常量：makeSession 闭包内 TS 不沿用函数入口 guard
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
  // AI 不可见件点名探针 workflow：白名单全部是注册表内真实存在、但不进 AI 装配面
  // 的工具（place_image_from_bytes = exposure.ai:false；eval = availability:'eval'）。
  // 合成注册表绕过存在性闸（生产闸会拦此类点名），专门钉 resolve 层的判定基收窄。
  const HIDDEN_WORKFLOW_ID = 'wf-ai-invisible'
  const HIDDEN_WORKFLOW_TOOLS = ['place_image_from_bytes', 'eval']

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
      ],
      [
        HIDDEN_WORKFLOW_ID,
        {
          kind: 'workflow',
          id: HIDDEN_WORKFLOW_ID,
          label: 'AI 不可见件点名（合成面，绕过存在性闸）',
          body: 'PIN-HIDDEN-WORKFLOW-BODY：白名单全为不可见件',
          tools: HIDDEN_WORKFLOW_TOOLS,
          origin: 'builtin',
          path: `workflows/${HIDDEN_WORKFLOW_ID}/workflow.md`
        }
      ]
    ]),
    profiles: new Map(),
    modes: [],
    failures: [],
    resolvedReferences: new Map()
  } as never

  // 可变 mode 标量：探针按场景切换（hero → 不可见点名 → general），镜像
  // page-state 标量的回合级语义
  let currentMode = WORKFLOW_ID
  const host = createActiveDesignHost({
    registry: () => registry,
    bridge: {
      probeSlot: async () => ({ currentPageId: 'page-1', docUuid: 'doc-1' }),
      probeBrief: async () => []
    },
    pageStateReader: () => ({ modeId: currentMode, profileId: null, engagedPageId: 'page-1' })
  })

  // 只读记录探针：注册在装配钩子之后（生产冒烟探针同位），捕获链式覆盖后的
  // event.systemPrompt，不回传。逐回合记录（探针现跑多个 prompt 回合）；
  // seenByRecorder 保留首回合（hero）捕获——既有断言口径不变
  let seenByRecorder: string | null = null
  const seenByRecorderRuns: string[] = []
  const recorder = (pi: { on: (event: string, fn: (event: unknown) => void) => void }) => {
    pi.on('before_agent_start', (event) => {
      const seen = (event as { systemPrompt: string }).systemPrompt
      if (seenByRecorder === null) seenByRecorder = seen
      seenByRecorderRuns.push(seen)
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

  // 单回合探针步进（hero / hidden / general 三场景共用）：切 mode → 组装 →
  // resolve → 切活动集 → 读回 → prompt（哨兵拒答预期）→ 读回终态。
  // prePrompt 钩子在 prompt 前穿插动作（hidden 场景的 SDK 兜底直钉用）。
  async function stepTurn(mode: string, prePrompt?: (desired: string[]) => void) {
    currentMode = mode
    await host.prepareTurn('做图')
    const turn = host.turnAssembly()
    const desired = resolveActiveToolNames(initialActive, registry, turn?.tools)
    session.setActiveToolsByName(desired)
    const active = session.getActiveToolNames()
    prePrompt?.(desired)
    let promptError: string | null = null
    try {
      await session.prompt('做图')
    } catch (error) {
      promptError = error instanceof Error ? error.message : String(error)
    }
    return {
      turnTools: turn?.tools ?? null,
      desired,
      active,
      finalActive: session.getActiveToolNames(),
      finalPrompt: session.systemPrompt,
      promptError
    }
  }

  // 首切：无 workflow 回合的激活集（条件工具离场）——SDK 重建接管 state prompt
  const generalActive = resolveActiveToolNames(initialActive, registry, [])
  session.setActiveToolsByName(generalActive)
  const afterSwitchActive = session.getActiveToolNames()
  const afterSwitchPrompt = session.systemPrompt

  // 本回合：组装（hero workflow 命中）→ prompt 前校准（条件工具回归）
  const hero = await stepTurn(WORKFLOW_ID)

  // ── AI 不可见点名回合：白名单全为注册表内真实存在、但不进 AI 装配面的工具
  //    （eval 档 / exposure.ai:false）——判定基收窄：即使被点名也进不了活动集
  //    （基线 = 会话创建时 AI 可见集，过滤语义只摘不加）；其余 workflow 的
  //    条件工具照常离场 ──
  let sdkUnknownNamesIgnored = false
  const hidden = await stepTurn(HIDDEN_WORKFLOW_ID, (desired) => {
    // SDK 注册面兜底直钉：不可见件显式塞进切换清单——SDK 只认注册表已有工具，
    // 未知名静默忽略，读回不见
    session.setActiveToolsByName([...desired, ...HIDDEN_WORKFLOW_TOOLS])
    const activeAfterUnknownInject = session.getActiveToolNames()
    sdkUnknownNamesIgnored =
      !activeAfterUnknownInject.includes('place_image_from_bytes') &&
      !activeAfterUnknownInject.includes('eval')
    session.setActiveToolsByName(desired)
  })

  // ── general 回合：无 workflow——条件工具全离场；装配产物 base only ──
  const general = await stepTurn('general')
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
    JSON.stringify(roAfter) === JSON.stringify(roDesired) &&
    JSON.stringify(roBackAfter) === JSON.stringify(roBack) &&
    roBackAfter.length === roInitial.length - 2

  process.stdout.write(
    JSON.stringify({
      turnTools: hero.turnTools,
      initialActive,
      generalActive: afterSwitchActive,
      afterSwitchPrompt,
      turnActive: hero.active,
      seenByRecorder,
      seenByRecorderRuns,
      finalPrompt: hero.finalPrompt,
      finalActive: hero.finalActive,
      promptError: hero.promptError,
      hiddenTurnTools: hidden.turnTools,
      hiddenActive: hidden.active,
      sdkUnknownNamesIgnored,
      hiddenFinalActive: hidden.finalActive,
      hiddenPromptError: hidden.promptError,
      generalTurnTools: general.turnTools,
      generalTurnActive: generalActive,
      generalFinalActive: general.finalActive,
      generalPromptError: general.promptError,
      generalFinalPrompt: general.finalPrompt,
      readonlySwitchOk,
      readonlyDetail: { initial: roInitial, afterSwitch: roAfter }
    })
  )
}
