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
 *    抛可行动错误（前端引导门是第一道闸，此处兜底）。2026-09-16（owner
 *    拍板②）：池内会话烘焙 spec 与请求 spec 不一致时驱逐重建——切换
 *    对下一个 prompt 生效，历史经 SessionManager.open 重开同一 JSONL
 *    保留（详见 prompt() 注释）
 *  - T60（S3 §9 / PD-19）：active_design 单槽宿主路由——chatMode 双模式链
 *    （T24 注册表烘焙 + 驱逐重建）退役；每回合组装 = base + workflow(落盘
 *    mode body) + profile 全文（active-design-host.ts，before_agent_start
 *    钩子 per-run 返回），身份封套/系统提示经 result.message custom 通道
 *    进 context；新建意图一次性旗标接 setup_design 注入缝；setup_design
 *    成功移槽回调、ask formId 映射、删除悬空清槽皆由 host 承担
 *  - T28：会话 GC（决策单 #2，session/gc.ts）——铸新会话后检查，超量
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

import { type AgentSession } from '@earendil-works/pi-coding-agent'
import type { UIMessage, UIMessageChunk } from 'ai'

import {
  readMaxSessions,
  readSessionMaxAgeDays,
  readStudioBuiltinDir
} from '@/app/orchestration/env'

import {
  confirmNewIntentViaBridge,
  createBridgeSlotIO,
  setActiveDesignViaBridge,
  type ConfirmNewIntentResult,
  type createActiveDesignHost,
  type SetActiveDesignResult
} from './active-design-host'
import type { AuthzNoticeSink } from './authz-guard'
import { type Capabilities, createCapabilitiesStore } from './capabilities'
import { type PiModelSpec, createDesignAssignmentStore } from './design-assignment'
import { readPiHistoryFile } from './history'
import type { ImageGenCredentialStore } from './image-gen/credentials'
import type { ImageGenSettingsStore } from './image-gen/settings'
import { createPiEventMapper } from './mapping'
import { migrateUserdataLayout } from './migrate'
import {
  resolveAgentDir,
  resolveArchiveDir,
  resolveBuiltinSkillsDir,
  resolveSessionsDir,
  resolveStudioDirs
} from './paths'
import {
  type AskAnswerPayload,
  createPendingDecisionStore,
  type DecisionAnswerInput
} from './pending-decision'
import type { ModelSpec, ProviderAdmin } from './provider-admin'
import { assembleSession, sameModelSpec } from './session/assembly'
import { runSessionGc } from './session/gc'
import type { PiSessionSummary } from './session/summary'
import { normalizeSkillCommandText } from './skill-command'
import { getStudioRegistry } from './studio'
import { toStudioManifest, type PiStudioManifest } from './studio/manifest'
import { ensureUserStudioSeed } from './studio/seed'
import { sendUndoGroupSignal } from './undo-group'

export type { PiSessionSummary }

/**
 * prompt 请求的可选装配参数。T60 起 chatMode/pickedProfileId 退役（active_design
 * 单槽取代请求级模式）；请求面残留字段由 server.ts 兼容窗忽略不报错。
 */
export type PiPromptOptions = {
  /** T100：model 必填——前端指派态是必备条件，无 spec 由 resolveModel 抛可行动错误。
   *  2026-09-16（owner 拍板②）：与池内会话烘焙 spec 不一致 → 驱逐重建，
   *  切换对下一个 prompt 生效（同 spec 复用会话，零开销） */
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
  /** 2026-09-16：指派后端化——读 design 模型指派（GET /api/pi/design-assignment） */
  getDesignAssignment(): PiModelSpec | null
  /** 2026-09-16：指派后端化——写 design 模型指派（PUT /api/pi/design-assignment）；
   *  非法值抛 TypeError，server.ts 转 400；null → 删文件 */
  setDesignAssignment(spec: PiModelSpec | null): PiModelSpec | null
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
   * 2026-09-15：abort 同时 reject 该 session 的所有 pending（挂起 promise 解锁；
   * 2026-09-19 起双族 ask/authz 共享 PendingDecisionStore，对 authz 等效 deny） */
  abort(sessionId: string): Promise<void>
  /** 2026-09-15：POST /api/pi/ask-answer 端点真源——resolve pending form
   * (formId 寻址)；'ok' 已答，'not_found' 表中无该 formId（已答/已 abort/未注册） */
  askAnswer(formId: string, payload: AskAnswerPayload): 'ok' | 'not_found'
  /** 2026-09-19 broker P1 件1：POST /api/pi/decision-answer 端点真源——kind 判别
   * 路由到 PendingDecisionStore（错族寻址视同 'not_found'） */
  decisionAnswer(input: DecisionAnswerInput): 'ok' | 'not_found'
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
  /** 2026-09-16（owner 拍板②）：创建时烘焙的 model spec——prompt 时与请求
   *  spec 比对，不一致驱逐重建（切换对下一个 prompt 生效） */
  spec: ModelSpec
  /** 2026-09-19 broker P1 件2：authz data part 直推缝（run 活动期接线 emit、收尾拆线） */
  authzSink: AuthzNoticeSink
}

type SessionIndex = Record<string, { file: string }>

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

  // 2026-09-18 userdata 重排存量迁移（migrate.ts，warn-only 不阻断）——必须先于
  // seed：seed 会在新位建目录/写 README，先 seed 会让迁移撞「新目录已存在」分支整体跳过。
  migrateUserdataLayout(rootDir)

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
  // 2026-09-16：design 模型指派后端化——单实例（与 capabilities store 同缝，
  // 共享 agentDir；落盘 <状态根>/pi-agent/design-assignment.json）；GET/PUT 路由共用此实例
  const designAssignmentStore = createDesignAssignmentStore({ agentDir })
  // 2026-09-19 broker P1 件1：ask/authz 双族 pending-decision 注册表单例（跨 session 共享）
  const decisionStore = createPendingDecisionStore()

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
  // pending（2026-09-19 起双族 ask/authz；会话文件已归档 = session 不可
  // 恢复，挂着的 promise 必须解锁；不 reject 会内存泄漏到下次重启）
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
      // pending（双族）解锁挂起 promise（不 reject 会内存泄漏到下次重启）；
      // 内存 sessions Map 维持原状（会话驱逐是规格外行为，不动）
      if (result.archived.length > 0) {
        const archivedNames = new Set(result.archived)
        for (const [sessionId, entry] of Object.entries(before)) {
          const name = entry.file.split(/[\\/]/).pop() ?? ''
          if (!archivedNames.has(name)) continue
          decisionStore.rejectForSession(sessionId, new Error('session_archived'))
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
    const { session, host, budget, target, sessionManager, authzSink } = await assembleSession(
      {
        rootDir,
        agentDir,
        sessionsDir,
        builtinStudioDir,
        admin,
        capabilitiesStore,
        decisionStore,
        activeDesignBridge,
        imageGenCredentials,
        imageGenSettings,
        readIndex
      },
      sessionId,
      modelSpec
    )

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
      running: false,
      spec: modelSpec,
      authzSink
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
    let entry = sessions.get(sessionId)
    // 2026-09-16（owner 拍板②）：指派切换对下一个 prompt 生效——池内会话烘焙
    // spec 与本请求不一致 → 驱逐重建：先等在跑 run 收尾（queue 串行语义，
    // 不打断进行中回合；挂 ask 表单的回合同此——等作答/abort 自然解锁），
    // dispose 释放资源；createSession 经 SessionManager.open 重开同一
    // JSONL——历史连续，模型/thinking 换新。
    if (entry && !sameModelSpec(entry.spec, options.model)) {
      const previous = entry
      await previous.queue.catch(() => undefined)
      try {
        previous.session.dispose()
      } catch (error) {
        console.warn(
          `[pi-backend] 驱逐重建 dispose 失败（忽略，旧会话随进程回收）：` +
            (error instanceof Error ? error.message : String(error))
        )
      }
      sessions.delete(sessionId)
      console.debug(
        `[pi-backend] 指派变更驱逐重建（${sessionId}）：` +
          `${previous.spec.providerId}/${previous.spec.modelId} → ` +
          `${options.model.providerId}/${options.model.modelId}`
      )
      entry = undefined
    }
    entry ??= await createSession(sessionId, options.model)
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
    // 2026-09-19 broker P1 件2：authz 直推缝接线——guard 通知经本 run 的 emit 直推 SSE
    entry.authzSink.emit = emit
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
      entry.authzSink.emit = null
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

  function getDesignAssignment(): PiModelSpec | null {
    return designAssignmentStore.get()
  }

  function setDesignAssignment(spec: PiModelSpec | null): PiModelSpec | null {
    return designAssignmentStore.set(spec)
  }

  async function setActiveDesign(
    nodeId: string,
    documentId?: string,
    windowId?: string
  ): Promise<SetActiveDesignResult> {
    // A3：B3 触发源标定——切槽前先在所有现存 session 的 host 闭包记「同意切换」
    // 触发源旗标（best-effort：端点不绑 sessionId，但目标 session 是当前活跃
    // 的；多 session 时全标，备选回合消费到。无活跃 session 时不标——待落地）。
    for (const entry of sessions.values()) entry.host.onSlotSwitchedViaBridge()
    return setActiveDesignViaBridge(nodeId, documentId, activeDesignBridge, windowId)
  }

  /** T91b：POST /api/pi/intent-confirm——前端 ChatNewIntentCard 确认后触发，写 pluginData 四键（A3：B2 扩 canvas） */
  async function confirmNewIntent(
    args: { modeId: string; profileId?: string; canvas?: string },
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
    // 2026-09-19：reject 覆盖 authz pending（等效 deny，authz-guard catch 转 block）；
    // entry 不存在时也要清（断连导致 server.ts 早于 createSession 收到 abort）
    const rejected = decisionStore.rejectForSession(sessionId, new Error('aborted'))
    if (rejected > 0) {
      console.debug(`[pi-backend] abort(${sessionId}) rejected ${rejected} pending decision(s)`)
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
    getDesignAssignment,
    setDesignAssignment,
    setActiveDesign,
    confirmNewIntent,
    abort,
    askAnswer: (formId, payload) => decisionStore.resolveAsk(formId, payload),
    decisionAnswer: (input) =>
      input.kind === 'ask'
        ? decisionStore.resolveAsk(input.formId, input.payload)
        : decisionStore.resolveAuthz(input.formId, input.payload)
  }
}
