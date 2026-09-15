/**
 * T20/T21 pi 自定义工具 → 7600 桥 → 活编辑器执行。
 *
 * 链路（注册期 recon 实证，见 docs/archive/rebuild-campaign/tasks/T20-self-check.md §2.1）：
 *  1. pi session 注册 customTools（service.ts），noTools: 'builtin' 只禁内建
 *  2. LLM 调起工具 → execute() 在本进程执行
 *  3. readDiscoveryFile()（automation/bridge/server/discovery）拿 7600 桥的端口与 token
 *  4. POST /rpc {command:'tool', args:{name, args}} → MCP server 经 WS 中继给
 *     浏览器编辑器（WorkspaceView mount 时自动连桥）→ core ALL_TOOLS 执行
 *  5. 返回 {ok, result} / {ok:false, error}，包装为 AgentToolResult
 *
 * T21：工具集从 hello-tool 单件扩为旧 ToolLoop 等价全集——CORE_TOOLS 22 +
 * extended 白名单 4（get_components / list_libraries /
 * insert_library_component / create_shape；前三者与旧 src/app/ai/tools/
 * index.ts:98-104 白名单一致，create_shape 为 T20 hello-tool 保留）。
 * schema 经 paramToTypeBox 从 core ParamDef 迷你 schema 生成（仿 MCP 侧
 * paramToZod 先例已随 MCP 外壳裁撤），core registry 保持
 * 单一事实源。
 *
 * T21 step budget：旧 MAX_AGENT_STEPS=50 语义平移——每 prompt 计 turn 数
 * （service.ts 在 turn_start 事件递增），剩余 ≤5 时往工具结果注 _warning
 * （文案照抄旧 ai-adapter.ts appendStepWarning）。pi 无 maxTurns 硬限
 * （agent-core 全量 grep 零命中，2026-08-24），硬停能力不再。
 *
 * T22 工具目标注入（T22-plan D4）：service 把当次请求的 documentId 经
 * ToolTargetSource 闭包传入，execute 时注入桥 args 外层 document_id——桥
 * resolveAutomationTarget 原生支持（target.ts:81），桥代码零改动；不进
 * 工具 schema（不对模型暴露实现细节，与 MCP 侧 schema 显式带参不同）。
 *
 * T98-路由：service 把当次请求的 windowId 经 ToolTargetSource 闭包传入，
 * postBridgeRPC 顶层放 windowId（不进 args——windowId 是请求体外层信封，
 * 与 documentId 同风格）。多窗时 agent 在 A 窗的调用不会串到 B 窗。
 *
 * T81 P-04：vision 前置拒绝——MODEL.IMAGE 输入模态闭包（service 注入
 * admin.resolveModel 出来的 pi Model.input.includes('image')），
 * MEDIA_OUTPUT_TOOLS 工具执行前 fail-fast（不消耗桥 RPC / 工具凭据）。
 * 错文案不外露到工具 description（与 T66「内部设施不外露」一致）。
 *
 * 仅运行于独立后端进程（bun 直跑，workspace 包导入可用）；token 只经
 * discovery 文件读取（平台目录 0o700 / 文件 0o600），不打印、不落盘他处。
 */

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Type, type TSchema } from 'typebox'

import {
  CORE_TOOLS,
  EXTENDED_TOOLS,
  FORK_TOOLS,
  type ParamDef,
  type ToolDef
} from '@open-pencil/core/tools'

import { readDiscoveryFile } from '@/app/bridge/server/discovery'

import { classifyBridgeFailure, EDITOR_UNREACHABLE_MESSAGE } from './bridge-errors'
import { postBridgeRPC } from './bridge-rpc'
import {
  isMediaToolOutput,
  MEDIA_OUTPUT_TOOLS,
  sanitizeMediaToolOutputForModel
} from './media-output'
import type { SetupDesignContext } from './setup-catalog'

/** T53：schema 外注入缝仅服务此工具（catalog + 新建意图确认旗标） */
const SETUP_DESIGN_TOOL = 'setup_design'

/** T60：setup_design 成功移槽回调缝（事件①宿主移槽；service 装配闭包） */
export type SetupDesignHooks = {
  /** 桥执行成功（结果含 rootId 且无 error）后调用；可异步，失败归调用方自理 */
  onDesignCreated?: (rootId: string) => void | Promise<void>
}

/**
 * extended 白名单。P1-1 扩充：set_text_resize / set_font / set_effects 三件
 * （均已在 core EXTENDED_TOOLS 定义，此前未放行 → AI 无法切换字体——
 * set_font 是唯一支持 font_family 的工具；set_effects 是阴影/模糊唯一入口；
 * set_text_resize 被 longform-hero-kv-first / art-directed workflow 引用）。
 * 2026-09-09 扩充：set_font_range / set_image_fill / set_stroke_align /
 * set_rotation / set_blend / set_locked 六件——studio base.md 路由表已把
 * 这些能力路由到对应工具，未放行则按 prompt 调用必吃 tool-not-found。
 * 2026-09-10 扩充：list_available_fonts——字体「写前发现」入口（专项
 * review 发现三字体工具全未放行，本件先行；list_fonts/get_font_status
 * 与写入侧语义待 owner 另行裁决）。
 */
const EXTENDED_WHITELIST = [
  'get_components',
  'list_libraries',
  'insert_library_component',
  'create_shape',
  'set_text_resize',
  'set_font',
  'set_effects',
  'set_font_range',
  'set_image_fill',
  'set_stroke_align',
  'set_rotation',
  'set_blend',
  'set_locked',
  'list_available_fonts'
] as const

export const MAX_AGENT_STEPS = 50
const STEP_WARNING_THRESHOLD = 5

/** 每 session 的 turn 计数源（service 在 prompt 时清零、turn_start 时递增） */
export type StepBudgetSource = {
  current(): number
}

/** T22：当次请求的桥目标文档（service 每 prompt 更新的可变袋，工具闭包读取） */
export type ToolTargetSource = {
  documentId?: string
  /** T98-路由：发起窗口 id（service 每 prompt 更新的可变袋） */
  windowId?: string
}

type BridgeToolResult = Record<string, unknown>

async function callBridgeTool(
  toolName: string,
  toolArgs: Record<string, unknown>,
  target?: ToolTargetSource,
  allowRetry = true
): Promise<BridgeToolResult> {
  const discovery = await readDiscoveryFile()
  if (!discovery) {
    // T98：连接级失败统一模型可见文案（EDITOR_UNREACHABLE_MESSAGE），
    // 内部细节（discovery/端口/桥）只进后端日志，不外露给模型（T66/T81）
    console.warn('[pi-backend] 桥 discovery 文件不存在或已过期（dev server 未启动？）')
    throw new Error(EDITOR_UNREACHABLE_MESSAGE)
  }

  // T22 D4：documentId 注入桥 args 外层 document_id（桥 resolveAutomationTarget
  // 原生消费；缺省则落当前活动 tab，维持旧语义）
  const documentId = target?.documentId
  const args = documentId ? { ...toolArgs, document_id: documentId } : toolArgs
  // T98-路由：windowId 是请求体外层信封字段，与 documentId 同风格——不进 args，
  // 桥侧按发起窗路由。多窗时不会把 A 窗的调用串到 B 窗。
  const windowId = target?.windowId

  let res: Response
  try {
    res = await postBridgeRPC(discovery, 'tool', { name: toolName, args }, windowId)
  } catch (error) {
    // T27 复核：单次重试并非死重试——重试会重读 discovery 文件（每次调用开头），
    // 覆盖「独立 dev:backend 后端存活期间 vite/7600 桥重启、端口或 token 恰好
    // 在首次 fetch 前漂移」的窗口；两次之间无其他状态变化，第二次失败即放弃
    if (allowRetry) return callBridgeTool(toolName, toolArgs, target, false)
    console.warn(
      `[pi-backend] 桥连接失败：${error instanceof Error ? error.message : String(error)}`
    )
    throw new Error(EDITOR_UNREACHABLE_MESSAGE)
  }

  const body = (await res.json().catch(() => null)) as {
    ok?: boolean
    result?: BridgeToolResult
    error?: string
  } | null

  if (res.status === 401) {
    // T27：同上——401 唯一可恢复场景是桥重启换了 token，重读 discovery 后再试一次
    if (allowRetry) return callBridgeTool(toolName, toolArgs, target, false)
    console.warn('[pi-backend] 桥鉴权 401：discovery token 与运行中实例不匹配（重启 dev server）')
    throw new Error(EDITOR_UNREACHABLE_MESSAGE)
  }
  if (!res.ok || body?.ok !== true) {
    // T98 判别缝：2xx + ok:false = 编辑器在线、工具自身抛错（桥 server.ts 对
    // 浏览器显式应答的工具错误固定回 200；502 保留给编辑器不可达：未连接/
    // RPC 超时/断连）→ 透传清洗后的工具 message；其余一律连接级统一文案。
    // 旧实现把工具解析错也包成「桥执行失败——确认浏览器已打开 app」，误导
    // agent 排查环境且泄露端口/桥措辞。
    const failure = classifyBridgeFailure(res.status, body, toolName)
    if (failure.kind === 'editor-unreachable') {
      console.warn(
        `[pi-backend] 桥调用连接级失败：HTTP ${res.status}（${body?.error ?? '无错误详情'}）`
      )
    }
    throw new Error(failure.message)
  }
  return body.result ?? {}
}

function paramToTypeBox(param: ParamDef): TSchema {
  const description = param.description
  let schema: TSchema
  switch (param.type) {
    case 'string':
      schema = param.enum
        ? Type.Union(
            param.enum.map((v) => Type.Literal(v)),
            { description }
          )
        : Type.String({ description })
      break
    case 'number': {
      const numOpts: { description: string; minimum?: number; maximum?: number } = { description }
      if (param.min !== undefined) numOpts.minimum = param.min
      if (param.max !== undefined) numOpts.maximum = param.max
      schema = Type.Number(numOpts)
      break
    }
    case 'boolean':
      schema = Type.Boolean({ description })
      break
    case 'color':
      schema = Type.String({ description })
      break
    case 'string[]':
      schema = Type.Array(Type.String(), { minItems: 1, description })
      break
  }
  return param.required ? schema : Type.Optional(schema)
}

function maybeAppendStepWarning(
  result: BridgeToolResult,
  budget: StepBudgetSource | undefined
): BridgeToolResult {
  if (!budget) return result
  const remaining = MAX_AGENT_STEPS - budget.current()
  if (remaining > STEP_WARNING_THRESHOLD) return result
  const warning = `⚠ ${remaining} steps remaining out of ${MAX_AGENT_STEPS}. Wrap up: finish critical fixes, skip polish. User can send "continue" for more steps.`
  return { ...result, _warning: warning }
}

function toolLabel(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function defineBridgeTool(
  def: ToolDef,
  budget: StepBudgetSource | undefined,
  target?: ToolTargetSource,
  setupDesign?: SetupDesignContext,
  setupDesignHooks?: SetupDesignHooks,
  modelSupportsVision?: () => boolean
) {
  const shape: Record<string, TSchema> = {}
  for (const [key, param] of Object.entries(def.params)) {
    shape[key] = paramToTypeBox(param)
  }
  return defineTool({
    name: def.name,
    label: toolLabel(def.name),
    description: def.description,
    parameters: Type.Object(shape),
    async execute(_toolCallId, params): Promise<AgentToolResult<BridgeToolResult>> {
      // T81 P-04（决策 B）：前置拒绝——登记媒体工具（look 等）的产物会原路回
      // 灌给模型作为图像内容；若当前模型不含 `image` 模态，工具跑通也是浪费
      // 凭据/时间，且 pi 没有"按工具结果裁模态"概念（imageContent 强喂）——
      // 在执行前 fail-fast。错文案不暴露到工具 description（与 T66 一致：
      // 内部设施不外露给模型 schema），错误只回到当前轮 history 与前端。
      if (MEDIA_OUTPUT_TOOLS.has(def.name) && modelSupportsVision && !modelSupportsVision()) {
        throw new Error(
          `This model does not support image input. The ${def.name} tool requires vision capability.`
        )
      }
      // T53（S3 §2）：catalog 投影 + 新建意图确认旗标随桥 args 外层注入
      // （T22 document_id 同缝）——不进 schema；core 侧解析容错（注入缺失/
      // 畸形 → catalog-less 语义 + 未确认拒绝）
      const extra: Record<string, unknown> = {}
      if (def.name === SETUP_DESIGN_TOOL && setupDesign) {
        const catalog = setupDesign.catalogJSON()
        if (catalog !== undefined) extra.__catalog = catalog
        if (setupDesign.newIntentConfirmed()) extra.__confirmedNewIntent = 'true'
      }
      const result = maybeAppendStepWarning(
        await callBridgeTool(def.name, { ...params, ...extra }, target),
        budget
      )
      // T60 事件①：setup_design 成功（结果含新 root id 且无 error）→ 宿主移槽
      // 回调；失败只 warn（设计已创建成功，移槽落空下回合探针读穿仍准）
      if (def.name === SETUP_DESIGN_TOOL && setupDesignHooks?.onDesignCreated) {
        if (typeof result.rootId === 'string' && !('error' in result)) {
          try {
            await setupDesignHooks.onDesignCreated(result.rootId)
          } catch (error) {
            console.warn(
              '[pi-backend] setup_design 成功后的 active_design 移槽回调失败（忽略）：' +
                (error instanceof Error ? error.message : String(error))
            )
          }
        }
      }
      // T55（S3 §5 通道 A）：登记媒体工具的结果把 base64 图像提升为 pi
      // ImageContent——模型收到的是真图像模态而非 JSON 内嵌字符串；
      // 文本副本保留 note/node/exportInfo 元数据。T92：文本副本完全 omit
      // base64（模型已从 image part 拿到真图，"[inlined as file part, N chars]"
      // 占位符对模型是纯噪音；占位符仅 UI 通道 sanitizeMediaToolOutput 保留）
      if (MEDIA_OUTPUT_TOOLS.has(def.name) && isMediaToolOutput(result)) {
        return {
          content: [
            { type: 'image', data: result.base64, mimeType: result.mimeType },
            { type: 'text', text: JSON.stringify(sanitizeMediaToolOutputForModel(result)) }
          ],
          details: result
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result
      }
    }
  })
}

export function createOpenPencilTools(
  budget?: StepBudgetSource,
  target?: ToolTargetSource,
  setupDesign?: SetupDesignContext,
  setupDesignHooks?: SetupDesignHooks,
  modelSupportsVision?: () => boolean
) {
  const toolSet = [
    ...CORE_TOOLS,
    ...EXTENDED_TOOLS.filter((def) => (EXTENDED_WHITELIST as readonly string[]).includes(def.name)),
    // T52-T57（S4 W2）：fork 工具暴露——brief 三件套 / setup_design / look /
    // prepare_hero_scaffold 等；T72：internal 段（image_gen_begin/commit）过滤——
    // 它们是 generate_image 编排器的桥端点，agent 直调会绕过凭证检查与编排逻辑
    // （generate_image 本体由 service 后端段另行装配，不在此面）。
    ...FORK_TOOLS.filter((def) => !def.internal)
  ]
  return toolSet.map((def) =>
    defineBridgeTool(def, budget, target, setupDesign, setupDesignHooks, modelSupportsVision)
  )
}
