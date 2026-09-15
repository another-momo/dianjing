/**
 * T19 pi 后端 service：pi SDK 库形态薄封装（D21：不经 harness，直用
 * @earendil-works/pi-coding-agent 库 API）。
 *
 * 职责：
 *  - tab 级 session 池：sessionId → AgentSession，提示按 session 串行
 *  - SessionManager JSONL 持久化（.dianjing/pi-sessions/，gitignored）
 *    + index.json（sessionId → 文件路径）支持 dev server 重启后恢复
 *  - AgentSessionEvent → UIMessageChunk（mapping.ts）经 emit 直推 SSE
 *  - T20：customTools 注册（tools.ts，hello-tool create_shape 经 7600 桥执行），
 *    noTools: 'builtin' 禁内建保留自定义
 *  - T21：模型/凭据装配移交 provider-admin.ts（pi 原生 ModelRuntime +
 *    auth.json，无 key 可起服务）；prompt 必带 model 档位（前端 design role
 *    解析结果），T100 起 spec 必填——无 spec 由 provider-admin.resolveModel
 *    抛可行动错误（前端引导门是第一道闸，此处兜底）
 *  - T60（S3 §9 / PD-19）：active_design 单槽宿主路由——chatMode 双模式链
 *    （T24 注册表烘焙 + 驱逐重建）退役；每回合组装 = base + workflow(落盘
 *    mode body) + profile 全文（active-design-host.ts，before_agent_start
 *    钩子 per-run 返回），身份封套/系统提示经 result.message custom 通道
 *    进 context；新建意图一次性旗标接 setup_design 注入缝；setup_design
 *    成功移槽回调、ask formId 映射、删除悬空清槽皆由 host 承担
 *  - T28：会话 GC（决策单 #2，session-gc.ts）——铸新会话后检查，超量
 *    （DIANJING_MAX_SESSIONS，默认 200）/超龄（DIANJING_SESSION_MAX_AGE_DAYS，
 *    默认 30）会话**移动**到 pi-sessions-archive/（保持文件名，index 除条），
 *    归档不删除；GC 失败只 warn 不阻断
 *  - T59：undo burst coalesce——每个 prompt run（= 一个 AI 回合）首尾向
 *    7600 桥发 undo_group begin/end 边界信号（undo-group.ts，失败不阻断），
 *    桥侧按设计区合并撤销单元
 *  - T85：load_reference 本地工具装配（customTools 同缝）——允许集读
 *    host.turnAssembly().allowedReferences，回合外恒空集
 *
 * 仅运行于独立后端进程（T20 起：main.ts 入口 / vite 插件 spawn 的子进程，
 * 不经 vite esbuild 打包）；只允许相对导入与 node/依赖包导入。
 * key 卫生：不读、不打印、不落盘任何 API key（凭据全部由 provider-admin
 * 经 pi ModelRuntime 管理）。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type InlineExtension
} from '@earendil-works/pi-coding-agent'
import type { UIMessage, UIMessageChunk } from 'ai'

import {
  readMaxSessions,
  readSessionMaxAgeDays,
  readStudioBuiltinDir
} from '@/app/orchestration/env'

import {
  confirmNewIntentViaBridge,
  createActiveDesignHost,
  createBridgeSlotIO,
  setActiveDesignViaBridge,
  type ConfirmNewIntentResult,
  type SetActiveDesignResult
} from './active-design-host'
import { type AskAnswerPayload, createAskPendingStore } from './ask-pending'
import { createAskUserQuestionTool } from './ask-user-question'
import { type Capabilities, createCapabilitiesStore } from './capabilities'
import { readPiHistoryFile } from './history'
import type { ImageGenCredentialStore } from './image-gen/credentials'
import { createImageGenTool } from './image-gen/generate'
import type { ImageGenSettingsStore } from './image-gen/settings'
import { createLoadReferenceTool } from './load-reference'
import { createPiEventMapper } from './mapping'
import {
  resolveAgentDir,
  resolveArchiveDir,
  resolveBuiltinSkillsDir,
  resolveImageGenOutputDir,
  resolveSessionsDir,
  resolveSkillsDir,
  resolveStudioDirs
} from './paths'
import type { ModelSpec, ProviderAdmin } from './provider-admin'
import { runSessionGc } from './session-gc'
import type { PiSessionSummary } from './session-summary'
import { buildSetupCatalog, type SetupDesignContext } from './setup-catalog'
import { normalizeSkillCommandText } from './skill-command'
import { getStudioRegistry } from './studio'
import { toStudioManifest, type PiStudioManifest } from './studio/manifest'
import { ensureUserStudioSeed } from './studio/seed'
import { createOpenPencilTools } from './tools'
import { sendUndoGroupSignal } from './undo-group'

export type { PiSessionSummary }

/**
 * 2026-09-15：ask_user_question 挂起期 tool_call guard——pending 期间拦截非
 * ask 工具调用（block+reason），强制模型停手等本工具结果返回；ask 自身不
 * block（其 execute 内部 alreadyPending 错误结果更具体）。
 * handler 与 extension 分离导出：测试直钉 handler（免 ExtensionAPI 桩件）。
 */
export function createAskPendingGuardHandler(
  store: { hasPendingForSession(sessionId: string): boolean },
  sessionId: string
): (event: { toolName: string }) => { block: true; reason: string } | undefined {
  return (event) => {
    if (event.toolName === 'ask_user_question') return undefined
    if (store.hasPendingForSession(sessionId)) {
      return {
        block: true,
        reason:
          "A form is awaiting the user's answer; wait for ask_user_question to return before calling further tools."
      }
    }
    return undefined
  }
}

/** guard 的 inline extension 装配形态——service.ts 注入 extensionFactories */
export function createAskPendingGuardExtension(
  store: { hasPendingForSession(sessionId: string): boolean },
  sessionId: string
): InlineExtension {
  const handler = createAskPendingGuardHandler(store, sessionId)
  return (pi) => {
    pi.on('tool_call', handler)
  }
}

/**
 * prompt 请求的可选装配参数。T60 起 chatMode/pickedProfileId 退役（active_design
 * 单槽取代请求级模式）；请求面残留字段由 server.ts 兼容窗忽略不报错。
 */
export type PiPromptOptions = {
  /** T100：model 必填——前端指派态是必备条件，无 spec 由 resolveModel 抛可行动错误 */
  model: ModelSpec
  documentId?: string
  /** T98-路由：桥按发起窗口路由 RPC；缺省落最后注册窗 */
  windowId?: string
}

export type PiChatService = {
  prompt(
    sessionId: string,
    text: string,
    emit: (chunk: UIMessageChunk) => void,
    options?: PiPromptOptions
  ): Promise<void>
  /** T22：会话族谱前缀 → 族内最新 sessionId（index.json 前缀扫描，无则 null） */
  resolveLatestSessionId(docKeyPrefix: string): string | null
  /** T22：读回指定会话历史（零副作用纯读，history.ts） */
  readHistory(sessionId: string): UIMessage[]
  /** T23：族内全部会话摘要，按创建后缀倒序（最新在前）；零副作用纯读 */
  listSessionFamily(docKeyPrefix: string): PiSessionSummary[]
  /** T45：studio manifest（注册表脱敏投影，无 profile 正文/绝对路径；S2 §8 failures 数据面）；
   *  T87：附加 capabilities/skills 字段（脱敏投影） */
  getStudioManifest(): PiStudioManifest
  /** T87：读 capabilities（settings 面板 GET 用） */
  getCapabilities(): Capabilities
  /** T87：写 capabilities（settings 面板 PUT 用；非法值抛错并被 server.ts 转 400）；
   *  T96：builtinTools 可选——给了就必须是三档字面量，缺省保留旧值 */
  setCapabilities(input: { agentSkills: unknown; builtinTools?: unknown }): Capabilities
  /** T60：active_design 端点（②面板点选 / ③AI 声明+同意）——四条件校验 → 移槽 → 身份三元组
   *  T98-路由：windowId 透传（与 documentId 同缝）——多窗时按发起窗路由 */
  setActiveDesign(
    nodeId: string,
    documentId?: string,
    windowId?: string
  ): Promise<SetActiveDesignResult>
  /** T91b：newIntent 确认端点——前端 ChatNewIntentCard 确认按钮触发，写 pluginData 三键
   *  T98-路由：windowId 透传 */
  confirmNewIntent(
    args: { modeId: string; profileId?: string },
    documentId?: string,
    windowId?: string
  ): Promise<ConfirmNewIntentResult>
  /** T27：取消该 session 进行中的 run（SSE 断连锁停后端烧 token）；无活跃 run 时 no-op
   * 2026-09-15：abort 同时 reject 该 session 的所有 pending ask 表单（挂起 promise 解锁） */
  abort(sessionId: string): Promise<void>
  /** 2026-09-15：POST /api/pi/ask-answer 端点真源——resolve pending form
   * (formId 寻址)；'ok' 已答，'not_found' 表中无该 formId（已答/已 abort/未注册） */
  askAnswer(formId: string, payload: AskAnswerPayload): 'ok' | 'not_found'
}

type SessionEntry = {
  session: AgentSession
  queue: Promise<void>
  /** T21 step budget：当前 prompt 已消耗的 turn 数（turn_start 事件递增） */
  budget: { current: number }
  /** T22 工具目标：当次请求的 documentId（桥 document_id 注入，T22-plan D4） */
  target: { documentId?: string; windowId?: string }
  /** T60：active_design 宿主会话态（旗标/formId 映射/每回合组装缓存袋） */
  host: ReturnType<typeof createActiveDesignHost>
  /**
   * T27：run 进行中标记。T66 起不再作 abort 守卫（时序竞争实证见 abort()
   * 注释）——保留仅供 abort 确认日志区分「命中活跃 run / idle no-op」。
   */
  running: boolean
}

type SessionIndex = Record<string, { file: string }>

/** T85：回合外/无声明时的 load_reference 空允许集（共享常量，避免每调用分配） */
const EMPTY_REFERENCES: ReadonlyMap<string, string> = new Map()

export function createPiChatService({
  rootDir,
  admin,
  imageGenCredentials,
  imageGenSettings
}: {
  rootDir: string
  admin: ProviderAdmin
  imageGenCredentials: ImageGenCredentialStore
  /** 图片本地留存偏好（retainLocal）——settings 路由读、generate_image 实时问开关 */
  imageGenSettings: ImageGenSettingsStore
}): PiChatService {
  const agentDir = resolveAgentDir(rootDir)
  const sessionsDir = resolveSessionsDir(rootDir)
  const indexPath = join(sessionsDir, 'index.json')
  // T28（决策单 #2）：GC 归档目录（不建索引；读取面经 index 解析，天然不扫）
  const archiveDir = resolveArchiveDir(rootDir)
  const maxSessions = readMaxSessions()
  const sessionMaxAgeDays = readSessionMaxAgeDays()

  // P2-11：seed 用户 studio 目录——首跑检测无 `_` 前缀模板则复制内置 _example。
  // 失败仅 warn 不阻断（IO 权限 / 磁盘满等不应挂掉整个后端）。
  // 路径与 registry.ts defaultDirs 同源——保持两者对齐，避免下次 reload
  // 时 builtinDir 解析漂移导致 seed 复制出来的引用错位。
  const { builtinDir: builtinStudioDir, userDir: userStudioDir } = resolveStudioDirs(
    rootDir,
    readStudioBuiltinDir()
  )
  try {
    ensureUserStudioSeed(userStudioDir, builtinStudioDir)
  } catch (error) {
    console.warn(
      '[pi-backend] studio seed 失败（忽略，不阻断主流程）：' +
        (error instanceof Error ? error.message : String(error))
    )
  }

  // T60：studio 注册表每回合读单例（getStudioRegistry 进程级缓存已在；
  // reloadStudio 触发面接上后天然跟随）——不再启动期快照固化。
  // base.md 未落位前 failures 恒含 base 缺失一条（manifest 显式暴露数据面）。
  // T60：active_design 桥探针/写槽 IO（无状态单例，session 间共享）
  const activeDesignBridge = createBridgeSlotIO()
  // T87：capabilities store 单例（与 stateDir/agentDir 同源）；session 装配按
  // builtinTools 切换 noTools/tools、按 agentSkills 切换 noSkills（T96 解耦）；
  // manifest 投影/GET/PUT 共用此实例。builtinSkillsDir 与用户层同构（同闭包
  // 上方 resolveStudioDirs 的产物）——内置 skill 进 chips 清单与宿主展开面，
  // 与 DefaultResourceLoader additionalSkillPaths 双源对齐
  const capabilitiesStore = createCapabilitiesStore({
    agentDir,
    rootDir,
    builtinSkillsDir: builtinStudioDir ? resolveBuiltinSkillsDir(builtinStudioDir) : undefined
  })
  // 2026-09-15：ask_user_question 挂起期 pending-form 注册表单例（跨 session 共享）
  const askPendingStore = createAskPendingStore()

  const sessions = new Map<string, SessionEntry>()

  function readIndex(): SessionIndex {
    try {
      return JSON.parse(readFileSync(indexPath, 'utf8')) as SessionIndex
    } catch (error) {
      // T27：ENOENT（首跑尚无索引）属正常静默；文件在但读/解析失败必须出声
      // （只报路径与错误类型，不打印文件内容）
      if (existsSync(indexPath)) {
        console.warn(
          `[pi-backend] session index 读取失败，按空索引处理（${indexPath}）：` +
            (error instanceof Error ? error.message : String(error))
        )
      }
      return {}
    }
  }

  function writeIndex(index: SessionIndex): void {
    mkdirSync(sessionsDir, { recursive: true })
    // T27：tmp + 同目录 rename 原子替换，防进程崩溃把 index.json 截成半个 JSON
    const tmpPath = `${indexPath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(index, null, 2))
    renameSync(tmpPath, indexPath)
  }

  // T28（决策单 #2）：GC 触发封装——两个触发点：①铸新会话后（createSession，
  // 存量清理）；②runPrompt 收尾（新会话 JSONL 此时必然已落盘——createSession
  // 时点 pi 尚未写盘，阈值计数要含新文件必须等这里）。失败不阻断主流程。
  // 2026-09-15：GC 前后比对 index，被归档的 sessionId 一并 reject 其
  // pending ask 表单（会话文件已归档 = session 不可恢复，挂着
  // 的 promise 必须解锁；不 reject 会内存泄漏到下次重启）
  function collectGarbage(): void {
    try {
      const before = readIndex()
      const result = runSessionGc({
        sessionsDir,
        archiveDir,
        maxSessions,
        maxAgeDays: sessionMaxAgeDays,
        readIndex,
        writeIndex
      })
      // GC 后 index 与 before 对比：消失的 sessionId 即被归档者——reject 其
      // pending ask 表单解锁挂起 promise（不 reject 会内存泄漏到下次重启）；
      // 内存 sessions Map 维持原状（会话驱逐是规格外行为，不动）
      if (result.archived.length > 0) {
        const archivedNames = new Set(result.archived)
        for (const [sessionId, entry] of Object.entries(before)) {
          const name = entry.file.split(/[\\/]/).pop() ?? ''
          if (!archivedNames.has(name)) continue
          askPendingStore.rejectForSession(sessionId, new Error('session_archived'))
        }
      }
    } catch (error) {
      console.warn(
        '[pi-backend] session GC 失败（忽略，不阻断主流程）：' +
          (error instanceof Error ? error.message : String(error))
      )
    }
  }

  async function createSession(sessionId: string, modelSpec: ModelSpec): Promise<SessionEntry> {
    // T100：spec 必填——无 spec 由 resolveModel 直接抛可行动错误，
    // 经 prompt → server.ts catch → SSE errorText 透传给前端（前端引导门未拦时
    // 兜底，措辞已在 provider-admin.ts 钉死）
    const { modelRuntime, model } = await admin.resolveModel(modelSpec)
    mkdirSync(sessionsDir, { recursive: true })

    const indexedFile = readIndex()[sessionId]?.file
    const sessionManager =
      indexedFile && existsSync(indexedFile)
        ? SessionManager.open(indexedFile, sessionsDir)
        : SessionManager.create(rootDir, sessionsDir)

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
      })
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
    const sessionOpts: Parameters<typeof createAgentSession>[0] = {
      cwd: rootDir,
      agentDir,
      model,
      modelRuntime,
      sessionManager,
      // T21：静态 system prompt 经 resourceLoader 烘焙（T60：烘焙 studio base
      // body 作兜底基底——per-run 钩子恒返回完整组装，基底只在无 prepareTurn
      // 的异常路径露面）+ 关闭 pi 侧上下文文件/prompt 模板加载——否则 repo
      // 的 AGENTS.md 等会混入设计会话（旧 ToolLoop 只有静态 prompt，对齐）
      // T87：noSkills 由 capabilities.agentSkills 决定——开启时加载
      // .dianjing/skills 下的 SKILL.md，进入 <available_skills> prompt 列表或被
      // /skill:name 显式调用（disable-model-invocation 的不进 prompt，可被显式调）。
      // T89：扫描目录由 `.pi/skills` + `.dianjing/pi-agent/skills` 双源
      // 收敛为 `.dianjing/skills` 单源。
      // T91b 修复：SDK 默认只扫 cwd/.pi/skills 与 agentDir/skills——T89 单源
      // `.dianjing/skills` 不被 SDK 感知，/skill:name 展开透传原文（CI 冒烟④
      // 失败实证）。用 additionalSkillPaths 显式把单源目录喂给 SDK，
      // 保持 T89 单源决策同时让 SDK 实际加载到。
      resourceLoader: await (async () => {
        const loader = new DefaultResourceLoader({
          cwd: rootDir,
          agentDir,
          systemPrompt: getStudioRegistry(rootDir).base?.body ?? '',
          noContextFiles: true,
          noSkills: !capabilitiesStore.get().agentSkills,
          noPromptTemplates: true,
          additionalSkillPaths: [
            resolveSkillsDir(rootDir),
            // 内置层：studio 内置资产下的 skills/（layer-splitting 等内置 skill）——与用户层同构；
            // builtinStudioDir 来自同闭包上方 resolveStudioDirs(rootDir, readStudioBuiltinDir())。
            ...(builtinStudioDir ? [resolveBuiltinSkillsDir(builtinStudioDir)] : [])
          ],
          extensionFactories
        })
        // createAgentSession 只在自构 loader 时才 reload（sdk.js `if (!resourceLoader)`
        // 分支）——外部传入必须自己调，否则 extensionsResult 停留初始空集，
        // inline extension 永不登记（T24 冒烟实证：probe 不落盘、注入不发生）
        await loader.reload()
        return loader
      })(),
      customTools
    }
    if (builtinToolsMode === 'off') sessionOpts.noTools = 'builtin'
    if (builtinToolsMode === 'readonly') {
      sessionOpts.tools = ['read', 'grep', 'find', 'ls', ...customTools.map((tool) => tool.name)]
    }
    if (modelSpec.thinkingLevel) sessionOpts.thinkingLevel = modelSpec.thinkingLevel
    const { session } = await createAgentSession(sessionOpts)

    const file = sessionManager.getSessionFile()
    if (file) {
      const index = readIndex()
      index[sessionId] = { file }
      writeIndex(index)
    }

    // T28：触发点①铸新会话后（存量清理；新文件此时未落盘，不计入当次阈值）
    collectGarbage()

    const entry: SessionEntry = {
      session,
      queue: Promise.resolve(),
      budget,
      target,
      host,
      running: false
    }
    sessions.set(sessionId, entry)
    return entry
  }

  async function prompt(
    sessionId: string,
    text: string,
    emit: (chunk: UIMessageChunk) => void,
    options: PiPromptOptions
  ): Promise<void> {
    // T27/B1 复核（2026-08-25）：`get ?? await createSession` 之间的并发双创建窗口
    // 在 dev 单用户拓扑下不可达——前端流式/提交中禁发（ChatInput isStreaming +
    // ChatPanel handleSubmit 双重守卫），同 sessionId 的第二个 POST 只能来自
    // 绕过 UI 的手工并发，代价是后者顶掉前者 entry（JSONL 文件各自独立、不串
    // 数据）。不做 promise 缓存去重：引入的复杂度大于 dev 场景收益。
    const entry = sessions.get(sessionId) ?? (await createSession(sessionId, options.model))
    entry.target.documentId = options.documentId
    entry.target.windowId = options.windowId
    // T91o：/skill: 命令归一化（skill-command.ts，原理见其头注）——把首个
    // /skill:<name> 提及整形成 SDK 原生可展开的「开头 + 空格收尾」命令形，
    // 展开动作留给 SDK _expandSkillCommand（块格式/transcript 与 pi CLI
    // 一致）；owner 情况①（名后贴中文透传）②（句中提及透传后模型猎文件）
    // 实证驱动。prepareTurn 的 promptText 即剥完信封的用户原文（位置 0
    // 不变），SDK startsWith 契约稳定命中
    const expandedText = normalizeSkillCommandText(text)
    // 同一 session 的 prompt 串行：pi 在 streaming 中再 prompt 需要 streamingBehavior，
    // dev 单用户场景直接排队即可
    // T27：rejection 接力——先吞掉前次 queue 的 rejection 再挂新 run；否则一次失败
    // 会让 entry.queue 永久处于 rejected，该 session 后续所有 prompt 直接跳过执行
    // （await 旧 rejected 队列立即抛）。当次 run 的 rejection 仍经 await 透传给调用方。
    entry.queue = entry.queue
      .catch(() => undefined)
      .then(() => runPrompt(entry, sessionId, expandedText, emit))
    await entry.queue
  }

  async function runPrompt(
    entry: SessionEntry,
    sessionId: string,
    text: string,
    emit: (chunk: UIMessageChunk) => void
  ): Promise<void> {
    const mapper = createPiEventMapper(`pi-${randomUUID()}`)
    const debug = process.env.PI_BACKEND_DEBUG === '1'
    entry.budget.current = 0
    entry.running = true
    const unsubscribe = entry.session.subscribe((event) => {
      if (event.type === 'turn_start') entry.budget.current++
      // T60 事件④：ask_user_question awaiting 信封 → 记录 formId→当时槽位
      if (event.type === 'tool_execution_end') {
        const details = (event.result as { details?: unknown } | undefined)?.details
        entry.host.observeToolExecution(event.toolName, event.isError, details)
      }
      if (debug) {
        const sub = event.type === 'message_update' ? `/${event.assistantMessageEvent.type}` : ''
        console.error(`[pi-backend:event] ${event.type}${sub}`)
      }
      for (const chunk of mapper(event)) emit(chunk)
    })
    try {
      // T60：回合入口——剥新建意图信封（置一次性旗标）→ ④表单作答移槽 →
      // 槽位读穿（悬空清槽）→ 组装（host.turnAssembly 供 before_agent_start 读）
      // T98-路由：windowId 与 documentId 同缝穿线（host 内部经桥探针/写槽
      // 时也按发起窗路由——多窗时不会把 A 窗的回包串到 B 窗）
      const prepared = await entry.host.prepareTurn(
        text,
        entry.target.documentId,
        entry.target.windowId
      )
      // T59：回合 = 一次 prompt run；begin 先行 await（本地 HTTP 一跳，失败已内生
      // 吞掉）保证桥侧撤销组先于本回合首个工具调用打开，end 在 finally 兜底发送
      // T98-路由：windowId 透传——撤销组 begin/end 同样按发起窗路由
      await sendUndoGroupSignal('begin', entry.target.documentId, entry.target.windowId)
      await entry.session.prompt(prepared.promptText)
    } catch (error) {
      emit({ type: 'error', errorText: error instanceof Error ? error.message : String(error) })
      emit({ type: 'finish', finishReason: 'error' })
    } finally {
      entry.running = false
      unsubscribe()
      // T60 定谳 5：一次性旗标 run 结束强制复位（信封永不跨回合滞留）
      entry.host.finalizeTurn()
      void sendUndoGroupSignal('end', entry.target.documentId, entry.target.windowId)
      // prompt 完成后 session 文件必然已落盘，补记 index（create 时 file 可能尚未生成）
      const file = entry.session.sessionManager.getSessionFile()
      if (file && readIndex()[sessionId]?.file !== file) {
        const index = readIndex()
        index[sessionId] = { file }
        writeIndex(index)
      }
      // T28：触发点②runPrompt 收尾（新文件已落盘，阈值计数含新会话，归一到阈值内）
      collectGarbage()
    }
  }

  function resolveLatestSessionId(docKeyPrefix: string): string | null {
    // T22 D2/D3：族内会话 = index 键以 `<前缀>-` 起头；时间戳后缀定长字典序
    // 可排（yyyyMMddTHHmmssZ），sort 末位即最新
    const prefix = `${docKeyPrefix}-`
    const keys = Object.keys(readIndex())
      .filter((key) => key.startsWith(prefix))
      .sort()
    return keys.at(-1) ?? null
  }

  function readHistory(sessionId: string): UIMessage[] {
    const file = readIndex()[sessionId]?.file
    if (!file || !existsSync(file)) return []
    return readPiHistoryFile(file)
  }

  function summarizeSession(sessionId: string, file: string | undefined): PiSessionSummary {
    if (!file || !existsSync(file)) {
      return { sessionId, title: '', messageCount: 0, updatedAtMs: 0 }
    }
    const messages = readPiHistoryFile(file)
    const firstUserText = messages
      .find((message) => message.role === 'user')
      ?.parts.find((part) => part.type === 'text')
    return {
      sessionId,
      title: firstUserText?.text.slice(0, 40) ?? '',
      messageCount: messages.length,
      updatedAtMs: statSync(file).mtimeMs
    }
  }

  function listSessionFamily(docKeyPrefix: string): PiSessionSummary[] {
    // T23 E1：族 = index 键前缀扫描（同 resolveLatestSessionId），倒序 = 最新在前；
    // 逐文件纯读派生摘要，不写 index 不开会话（T22 recon 15 读取陷阱沿用）
    const prefix = `${docKeyPrefix}-`
    const index = readIndex()
    return Object.keys(index)
      .filter((key) => key.startsWith(prefix))
      .sort()
      .reverse()
      .map((sessionId) => summarizeSession(sessionId, index[sessionId]?.file))
  }

  function getStudioManifest(): PiStudioManifest {
    return toStudioManifest(getStudioRegistry(rootDir), capabilitiesStore)
  }

  function getCapabilities(): Capabilities {
    return capabilitiesStore.get()
  }

  function setCapabilities(input: { agentSkills: unknown; builtinTools?: unknown }): Capabilities {
    return capabilitiesStore.set(input)
  }

  async function setActiveDesign(
    nodeId: string,
    documentId?: string,
    windowId?: string
  ): Promise<SetActiveDesignResult> {
    return setActiveDesignViaBridge(nodeId, documentId, activeDesignBridge, windowId)
  }

  /** T91b：POST /api/pi/intent-confirm——前端 ChatNewIntentCard 确认后触发，写 pluginData 三键 */
  async function confirmNewIntent(
    args: { modeId: string; profileId?: string },
    documentId?: string,
    windowId?: string
  ): Promise<ConfirmNewIntentResult> {
    // T91b：能力面开关与 set_active_design 同语义——agent skills 未开 → 拒绝。
    if (!capabilitiesStore.get().agentSkills) {
      return { ok: false, error: 'invalid_args', message: 'agent skills 不可用' }
    }
    return confirmNewIntentViaBridge(args, documentId, windowId)
  }

  async function abort(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId)
    // T66（T66-plan ④）：守卫去 running 布尔依赖——原 `if (!entry?.running)
    // return` 与 runPrompt finally（entry.running = false）存在时序竞争：前端
    // stop 断连触发 server.ts res.on('close') 时 run 可能已收尾，abort 被整体
    // 跳过（停止按钮假死根因，2026-09-01 链路实证）。
    // 改无条件 abort：pi 对 idle session 的 abort 是无害 no-op（实证：
    // pi-agent-core agent.js `abort() { this.activeRun?.abortController.abort() }`
    // 可选链空转；agent-session.js abort() = abortRetry()（同可选链）+
    // agent.abort() + waitForIdle()（isIdle 即返回））。entry 存在即可打。
    // 已知限制：run 卡在长工具调用（图像生成 HTTP，240s 超时）时 abort 只置
    // 信号、等当前工具收尾（agent-loop.js 工具批 `if (signal?.aborted) break`），
    // 不打断进行中的 HTTP——generate.ts execute 未接 pi abort signal，
    // provider（image-gen/provider.ts）用独立 AbortSignal.timeout。工具层 signal 透传留后续。
    // 2026-09-15：reject 该 session 的所有 pending ask 表单（ask_user_question
    // 挂起 promise 解锁，execute signal abort 自动 reject 等价路径——双保险）；
    // entry 不存在时也要清（断连导致 server.ts 早于 createSession 收到 abort）
    const rejected = askPendingStore.rejectForSession(sessionId, new Error('aborted'))
    if (rejected > 0) {
      console.debug(`[pi-backend] abort(${sessionId}) rejected ${rejected} pending ask form(s)`)
    }
    if (!entry) return
    const hitRunningRun = entry.running
    // T27：pi abort() 语义 = 取消当前操作并等 agent 回 idle
    // （agent-session.d.ts:433）；排队中的后续 run 会照常接着跑。
    // abort 抛错（如 session 已 dispose / agent 未响应）不该冒成 unhandled
    // rejection（server.ts 用 void 丢弃本 promise）——吞掉并出声即可。
    try {
      await entry.session.abort()
      // T66：abort 确认回显——后端日志（触发面 = SSE 断连，连接已死，无既有
      // 回前端通路；不做新 SSE 通道，T66-plan ④ 复杂度红线）
      console.debug(
        `[pi-backend] abort(${sessionId}) 已送达 session（命中进行中 run：${hitRunningRun}）`
      )
    } catch (error) {
      console.warn(
        `[pi-backend] abort(${sessionId}) 失败（忽略）:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  return {
    prompt,
    resolveLatestSessionId,
    readHistory,
    listSessionFamily,
    getStudioManifest,
    getCapabilities,
    setCapabilities,
    setActiveDesign,
    confirmNewIntent,
    abort,
    askAnswer: (formId, payload) => askPendingStore.resolveByFormId(formId, payload)
  }
}
