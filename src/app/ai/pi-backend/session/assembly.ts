/**
 * pi-backend session 装配段（wave4 抽离，零行为变更）——createSession 内
 * ~250 行家务事（customTools 组装 + extensionFactories 装配 + trust-gate/
 * resourceLoader/sessionOpts 构造）迁此。service.ts 留薄壳：调本档 →
 * index 写盘 → collectGarbage → SessionEntry 注册。
 *
 * 切块动机：service.ts 868 行（max-lines 600 warn）增长模式 = createSession
 * 装配段是家务事沉积缝（T60 host/T85/ask guard/key guard/层 1+2 trust gate
 * 全在）。本档做切刀不动螺丝——逐字搬运，含注释，禁顺手"改进"。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
  type Skill
} from '@earendil-works/pi-coding-agent'

import { createActiveDesignHost, type ActiveDesignBridgeIO } from '../active-design-host'
import { type AskPendingStore } from '../ask/pending'
import { createAskPendingGuardExtension } from '../ask/pending-guard'
import { createAskUserQuestionTool } from '../ask/user-question'
import type { CapabilitiesStore } from '../capabilities'
import { createExportImageToFileTool } from '../export-image-to-file'
import type { ImageGenCredentialStore } from '../image-gen/credentials'
import { createImageGenTool } from '../image-gen/generate'
import type { ImageGenSettingsStore } from '../image-gen/settings'
import { createKeyGuardExtension } from '../key-guard'
import { createLoadImageTool } from '../load-image'
import { createLoadReferenceTool } from '../load-reference'
import {
  resolveBuiltinSkillsDir,
  resolveImageGenOutputDir,
  resolveSkillsDir,
  resolveWorkspaceDir
} from '../paths'
import type { ModelSpec, ProviderAdmin } from '../provider-admin'
import { buildSetupCatalog, type SetupDesignContext } from '../setup-catalog'
import { getStudioRegistry } from '../studio'
import { createOpenPencilTools } from '../tools'

/** T85：回合外/无声明时的 load_reference 空允许集（共享常量，避免每调用分配） */
const EMPTY_REFERENCES: ReadonlyMap<string, string> = new Map()

/**
 * 2026-09-16（owner 拍板②）：驱逐判定用 spec 等价——thinkingLevel 缺省与
 * 'off' 同义（前端 buildAssignment 写指派时剔除 'off'，两条写入路径殊途同归
 * 都是不开 thinking；字面差异不值得一轮会话重建）。
 * review 补洞（wave4）：自 service.ts 随迁 session 域——与 assembleSession
 * 同属 session spec 生命周期（装配 + 驱逐判定），service.ts 回落 600 行内。
 */
export function sameModelSpec(a: ModelSpec, b: ModelSpec): boolean {
  const thinking = (spec: ModelSpec) =>
    spec.thinkingLevel && spec.thinkingLevel !== 'off' ? spec.thinkingLevel : undefined
  return a.providerId === b.providerId && a.modelId === b.modelId && thinking(a) === thinking(b)
}

/** createSession 装配上下文宽参——工厂闭包内已 resolve 好的依赖与目录 */
export type AssembleSessionContext = {
  rootDir: string
  /** pi-agent 目录（resolveAgentDir(rootDir)） */
  agentDir: string
  /** pi-sessions 目录（resolveSessionsDir(rootDir)） */
  sessionsDir: string
  /** userStudio 目录（resolveStudioDirs 派生，可为 undefined——内置缺失时） */
  builtinStudioDir: string | undefined
  /** provider 模型与凭据解析入口（无 spec 由其抛可行动错误） */
  admin: ProviderAdmin
  /** 工具 capabilities 单例（agentSkills / builtinTools 三档门控） */
  capabilitiesStore: CapabilitiesStore
  /** ask_user_question 挂起期 pending-form 注册表单例 */
  askPendingStore: AskPendingStore
  /** T60：active_design 桥探针/写槽 IO（无状态单例，session 间共享） */
  activeDesignBridge: ActiveDesignBridgeIO
  /** T54：图片生成凭据（HTTP 生成走外部凭证） */
  imageGenCredentials: ImageGenCredentialStore
  /** T54：图片本地留存偏好（每条 item 实时问） */
  imageGenSettings: ImageGenSettingsStore
  /** index.json 读取（service.ts 闭包内 readIndex——装配段不直接 IO） */
  readIndex: () => Record<string, { file: string }>
}

/** assembleSession 返回值——entry 注册所需件 */
export type AssembledSession = {
  session: AgentSession
  /** T60：active_design 宿主会话态（旗标/formId 映射/每回合组装缓存袋） */
  host: ReturnType<typeof createActiveDesignHost>
  /** T21：step budget 每 session 一份（prompt 时清零、turn_start 递增） */
  budget: { current: number }
  /**
   * T22：documentId 以当次请求为准（session 复用、target 可变），
   * 工具经闭包读取注入桥 args.document_id
   * T98-路由：windowId 同缝——tools.ts 经 target.windowId 注入 postBridgeRPC 顶层
   */
  target: { documentId?: string; windowId?: string }
  /** SessionManager 实例——service.ts 落盘索引时取 getSessionFile() */
  sessionManager: SessionManager
}

export async function assembleSession(
  ctx: AssembleSessionContext,
  sessionId: string,
  modelSpec: ModelSpec
): Promise<AssembledSession> {
  const {
    rootDir,
    agentDir,
    sessionsDir,
    builtinStudioDir,
    admin,
    capabilitiesStore,
    askPendingStore,
    activeDesignBridge,
    imageGenCredentials,
    imageGenSettings,
    readIndex
  } = ctx

  // T100：spec 必填——无 spec 由 resolveModel 直接抛可行动错误，
  // 经 prompt → server.ts catch → SSE errorText 透传给前端（前端引导门未拦时
  // 兜底，措辞已在 provider-admin.ts 钉死）
  const { modelRuntime, model } = await admin.resolveModel(modelSpec)
  mkdirSync(sessionsDir, { recursive: true })
  // 2026-09-16 key 守卫 B 案：会话 cwd 下沉 rootDir/workspace——凭据文件
  // 不再挂相对解析根下（绝对路径由 key-guard 堵，两案搭配）
  const workspaceDir = resolveWorkspaceDir(rootDir)
  mkdirSync(workspaceDir, { recursive: true })

  const indexedFile = readIndex()[sessionId]?.file
  const sessionManager =
    indexedFile && existsSync(indexedFile)
      ? SessionManager.open(indexedFile, sessionsDir)
      : SessionManager.create(workspaceDir, sessionsDir)

  // T21：step budget 每 session 一份（prompt 时清零、turn_start 递增），
  // 工具经闭包读它决定是否注 _warning（tools.ts）
  const budget = { current: 0 }
  // T22：documentId 以当次请求为准（session 复用、target 可变），
  // 工具经闭包读取注入桥 args.document_id
  // T98-路由：windowId 同缝——tools.ts 经 target.windowId 注入 postBridgeRPC 顶层
  const target: { documentId?: string; windowId?: string } = {}
  // T60：active_design 宿主会话态（注册表每回合读单例；桥 IO 共享无状态单例）
  const host = createActiveDesignHost({
    registry: () => getStudioRegistry(rootDir),
    bridge: activeDesignBridge
  })
  // T53（S3 §2）+ T60：setup_design 注入缝——catalog 请求时投影；新建意图
  // 确认真源 = 当回合信封旗标（active-design-host，run 结束 finally 复位）
  const setupDesign: SetupDesignContext = {
    catalogJSON: () => JSON.stringify(buildSetupCatalog(getStudioRegistry(rootDir))),
    newIntentConfirmed: () => host.newIntentConfirmed()
  }
  const customTools = [
    ...createOpenPencilTools(
      { current: () => budget.current },
      target,
      setupDesign,
      {
        // T60 事件①：setup_design 桥执行成功（结果含新 root id）→ 移槽
        // T98-路由：windowId 与 documentId 同缝穿线——桥按发起窗路由
        onDesignCreated: (rootId) =>
          host.onDesignCreated(rootId, target.documentId, target.windowId)
      },
      // T81 P-04：vision 前置拒绝闭包——pi Model.input('text' | 'image')
      // 的 'image' 在场即代表 vision；createSession 已 resolveModel，闭包
      // 直接读 model.input。无视时延展到"工具跑通也喂不进图像"，先 fail-fast
      // 省桥 RPC + 工具凭据
      () => Array.isArray(model.input) && model.input.includes('image')
    ),
    // T54：generate_image 后端段（生成 HTTP 不经桥、落图经桥；凭证单实例
    // 由 server.ts 注入，与设置路由同视图）。图片本地留存：每条 item 实时
    // 问 settings.get().retainLocal，dir() 拼 resolveImageGenOutputDir(rootDir)——
    // 用户可在 AI 运行期间切换开关，下一条 item 即跟随
    createImageGenTool({
      credentials: imageGenCredentials,
      target,
      retention: {
        enabled: () => imageGenSettings.get().retainLocal,
        dir: () => resolveImageGenOutputDir(rootDir)
      }
    }),
    // 2026-09-15：ask_user_question 挂起期本地工具（不经桥——表单卡片由前端
    // 读 tool part 渲染）→ register store → 挂起到 /api/pi/ask-answer 端点
    // resolve；answer/skip 作为本工具结果在同一 turn 返回。
    // onPendingRegistered 通知 host 记录 formId→当时槽位（active-design-host
    // observeToolExecution 不再触发，新流走工具结果 details.status='answered'
    // 移槽——见 host recordAskForm）。
    createAskUserQuestionTool({
      store: askPendingStore,
      sessionId,
      onPendingRegistered: (formId) => host.recordAskForm(formId)
    }),
    // T85：load_reference 后端本地工具（资产 references 按需读取；允许集 =
    // 本回合 active 资产声明并集——assembleTurn 计算、host 持有于 turn 缓存袋、
    // finalizeTurn 随 turn=null 复位；回合外空集，任何 path 皆拒）
    // P2-3（2026-09-07）：read_reference → load_reference 重命名
    createLoadReferenceTool({
      allowedPaths: () => host.turnAssembly()?.allowedReferences ?? EMPTY_REFERENCES
    }),
    // 2026-09-18 本地图片工具链（仓外 docs/202609151700-load-image-tool-research.md）：
    // load_image = 读本地图片上画布（路径三态裁决 + 嗅探 + 桥调
    // place_image_from_bytes）；export_image_to_file = 画布节点写盘唯一入口
    // （桥调 core export_image 拿 base64 → 三态裁决 → fs.writeFile）
    createLoadImageTool({ rootDir, target }),
    createExportImageToFileTool({ rootDir, target })
  ]

  // T60：每回合组装 = active-design-host prepareTurn 产出的
  // { systemPrompt, contextLines }；本钩子只做搬运（systemPrompt per-run 替换，
  // contextLines 经 result.message custom 通道进 context——convertToLlm 转
  // user role 进模型上下文，不进 UI 流/历史回填）。runner 链式语义：run 后
  // 回基底（agent-session.js emitBeforeAgentStart / else 分支复位）。
  const assembly: InlineExtension = (pi) => {
    pi.on('before_agent_start', () => {
      const turn = host.turnAssembly()
      if (!turn) return undefined
      return {
        systemPrompt: turn.systemPrompt,
        ...(turn.contextLines.length > 0
          ? {
              message: {
                customType: 'active-design-context',
                content: turn.contextLines.join('\n'),
                display: false
              }
            }
          : {})
      }
    })
  }
  const extensionFactories: InlineExtension[] = [assembly]
  // 2026-09-15：ask_user_question 挂起期 tool_call guard——pending 期间拦截
  // 非 ask 工具调用，强制模型停手等本工具结果返回（避免模型在前端作答
  // 到达前继续推工具调用，破坏挂起语义）；pending 时 ask_user_question
  // 自身不 block（其 execute 内部 alreadyPending 错误结果更具体）
  extensionFactories.push(createAskPendingGuardExtension(askPendingStore, sessionId))
  // 2026-09-16 key 守卫 A 案：tool_call 拦内建文件工具对凭据四件（auth.json /
  // image-gen.json / key-env / pi-backend-token）的读/写/搜——详见
  // key-guard.ts 头注与仓外预研稿 docs/202609151649-pi-agent-key-file-guard-research.md
  extensionFactories.push(createKeyGuardExtension({ rootDir, cwd: workspaceDir }))
  // 冒烟探针（免 key 装配验证）：登记在装配之后，event.systemPrompt 已是
  // 链式最终值；仅 PI_PROMPT_PROBE_DIR 显式设置时生效
  const probeDir = process.env.PI_PROMPT_PROBE_DIR
  if (probeDir) {
    extensionFactories.push((pi) => {
      pi.on('before_agent_start', (event) => {
        mkdirSync(probeDir, { recursive: true })
        writeFileSync(join(probeDir, 'last-system-prompt.md'), event.systemPrompt)
      })
    })
  }

  // T20：'all' 会连 custom 工具一起禁；'builtin' 只禁内建（read/bash/edit/write）
  // 保留我们的设计工具（sdk.d.ts 语义实证，见 T20-self-check §2.1-1）
  // T96：capabilities.builtinTools 三档位门控（与 agentSkills 解耦）——
  // off 显式禁内建（与 T87 前基线一致）；readonly 用 tools 白名单限内建
  // 只读四件（read/grep/find/ls，SDK createReadOnlyTools 同集，预研
  // §2.1/§2.3）——**白名单必须带上全部 customTools 名**：SDK 语义是
  // 「tools 给了就只激活名单内工具」（sdk.js allowedToolNames 过滤
  // customTools，owner 实测 readonly 档设计工具全丢实证）；full 省略
  // 字段 → SDK 默认允许全部内建工具（read/bash/edit/write）。
  const builtinToolsMode = capabilitiesStore.get().builtinTools
  // 2026-09-16 pi agent 行为控管层 1：自构 SettingsManager 双注——
  // SDK 默认 projectTrusted=true（settings-manager.js:150 `?? true`），
  // 等于 cwd/.pi 全域（settings/extensions/skills/prompts/APPEND_SYSTEM/SYSTEM
  // + 祖先 .agents/skills）无条件可写可加载，对产品形态 = RCE / 持久注入 /
  // 窃 key 攻击面。Options.projectTrusted:false 在 settings-manager.js:150
  // 显式落 this.projectTrusted=false，经 reload() 全局关 project 域扫描
  // （含 SYSTEM.md 与 APPEND_SYSTEM.md 项目拷贝、cwd/.pi 子树）。
  // 同一实例喂 DefaultResourceLoader (resource-loader.js:157) 与
  // createAgentSession (sdk.js:73) 实现双注——loader 内部 reload 切 trust
  // 走 loadProjectTrustExtensions→reload 链路，sdk 侧 getDefaultProvider
  // 等读 trust 后态。applyOverrides 显式关 enableInstallTelemetry
  // （默认 true，包安装外呼——我们不装包，今日惰性）。
  // noExtensions:true 关 file extensions（inline factories 走
  // loadExtensionFactories 独立通道 preTrust 缺省分支，与信任态无关不伤——
  // ask/key 两 guard 经此缝常驻）。
  // T89 + 2026-09-16 层 2 skills 单源收口：skillsOverride 按 baseDir
  // 白名单过滤，剔 SDK 默认塞进的 pi-agent/skills 与 ~/.agents/skills
  // （他 agent 混入设计会话渗漏），落实 T89 `.dianjing/skills` 单源决策。
  const trustedSettingsManager = SettingsManager.create(workspaceDir, agentDir, {
    projectTrusted: false
  })
  trustedSettingsManager.applyOverrides({ enableInstallTelemetry: false })
  // T89 单源白名单：用户层（resolveSkillsDir = rootDir/skills）与内置层
  // （builtinStudioDir/skills）双源
  const allowedSkillBaseDirs = new Set<string>()
  const userSkillsDir = resolveSkillsDir(rootDir)
  allowedSkillBaseDirs.add(userSkillsDir)
  if (builtinStudioDir) {
    allowedSkillBaseDirs.add(resolveBuiltinSkillsDir(builtinStudioDir))
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir,
    // T21：静态 system prompt 经 resourceLoader 烘焙（T60：烘焙 studio base
    // body 作兜底基底——per-run 钩子恒返回完整组装，基底只在无 prepareTurn
    // 的异常路径露面）+ 关闭 pi 侧上下文文件/prompt 模板加载——否则 repo
    // 的 AGENTS.md 等会混入设计会话（旧 ToolLoop 只有静态 prompt，对齐）
    // T87：noSkills 由 capabilities.agentSkills 决定——开启时加载
    // .dianjing/skills 下的 SKILL.md，进入 <available_skills> prompt 列表或被
    // /skill:name 显式调用（disable-model-invocation 的不进 prompt，可被显式调）。
    // T91b 修复：SDK 默认只扫 cwd/.pi/skills 与 agentDir/skills——T89 单源
    // `.dianjing/skills` 不被 SDK 感知，/skill:name 展开透传原文（CI 冒烟④
    // 失败实证）。用 additionalSkillPaths 显式把单源目录喂给 SDK，
    // 保持 T89 单源决策同时让 SDK 实际加载到。
    systemPrompt: getStudioRegistry(rootDir).base?.body ?? '',
    settingsManager: trustedSettingsManager,
    noContextFiles: true,
    noSkills: !capabilitiesStore.get().agentSkills,
    noPromptTemplates: true,
    noExtensions: true,
    additionalSkillPaths: [
      resolveSkillsDir(rootDir),
      // 内置层：studio 内置资产下的 skills/（layer-splitting 等内置 skill）——与用户层同构；
      // builtinStudioDir 来自同闭包上方 resolveStudioDirs(rootDir, readStudioBuiltinDir())。
      ...(builtinStudioDir ? [resolveBuiltinSkillsDir(builtinStudioDir)] : [])
    ],
    skillsOverride: (result) => ({
      ...result,
      // skill.baseDir 语义 = SKILL.md 所在目录（<skills源目录>/<skill名>），
      // 白名单装的是源目录本身——比对须取 dirname 上溯一层（2026-09-16 CI
      // t87 端到端④实证：直比 baseDir 全员滤空，/skill: 展开失效）
      skills: result.skills.filter((skill: Skill) =>
        allowedSkillBaseDirs.has(dirname(skill.baseDir))
      )
    }),
    extensionFactories
  })
  // createAgentSession 只在自构 loader 时才 reload（sdk.js `if (!resourceLoader)`
  // 分支）——外部传入必须自己调，否则 extensionsResult 停留初始空集，
  // inline extension 永不登记（T24 冒烟实证：probe 不落盘、注入不发生）
  await resourceLoader.reload()
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: workspaceDir,
    agentDir,
    model,
    modelRuntime,
    sessionManager,
    resourceLoader,
    // 2026-09-16 层 1 双注缝 ②：同 settingsManager 实例喂 createAgentSession
    // （sdk.js:73 options.settingsManager）——保证 sdk 内部 getDefaultProvider
    // 等读到的 trust 态与 loader 一致
    settingsManager: trustedSettingsManager,
    customTools
  }
  if (builtinToolsMode === 'off') sessionOpts.noTools = 'builtin'
  if (builtinToolsMode === 'readonly') {
    sessionOpts.tools = ['read', 'grep', 'find', 'ls', ...customTools.map((tool) => tool.name)]
  }
  if (modelSpec.thinkingLevel) sessionOpts.thinkingLevel = modelSpec.thinkingLevel
  const { session } = await createAgentSession(sessionOpts)

  return { session, host, budget, target, sessionManager }
}
