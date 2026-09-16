/**
 * T20 pi 后端独立 HTTP 服务（owner 拍板 2026-08-23：后端是独立进程，
 * 不是 vite 中间件）。
 *
 * 路由：
 *  - POST /api/pi-chat → SSE（UIMessage stream v1 线格式：`data: <json>\n\n`
 *    帧序列 + `data: [DONE]\n\n` 收尾），处理器自 T19 vite-plugin.ts 迁入
 *  - GET  /health → { status: 'ok' }（vite 插件 spawn 后就绪探针 + 冒烟前置检查）
 *  - T21 provider/凭据管理（pi 原生，provider-admin.ts）：
 *    GET /api/pi/catalog（目录 + auth 状态，脱敏）、POST /api/pi/credentials、
 *    DELETE /api/pi/credentials、POST /api/pi/providers（自定义 provider）
 *    ——无任何回读 key 的端点
 *  - T100：POST /api/pi/credentials/verify {providerId}（B1，最小 chat 验真）
 *  - T100：DELETE /api/pi/providers/{providerId}（C1，仅自定义；内建 400）
 *  - T100：model 必填——无 spec 走 SSE errorText 通道，透传可行动错误
 *
 * 请求体：{ sessionId: string, messages: UIMessage[], model?: ModelSpec,
 * documentId?: string, windowId?: string }
 * （ai SDK Chat 默认全量 messages 上报；本 service 只取末条 user 文本，
 * 历史由后端 SessionManager 持有。model 为前端 design role 解析结果，T21。
 * documentId 为桥目标注入，T22。T98-路由：windowId 经 transport 直传——
 * 桥按发起窗路由 RPC（window-id.ts 设计取舍见其头注）。T60 起
 * chatMode/pickedProfileId 退役——active_design 单槽取代请求级模式；
 * 请求面残留字段忽略不报错（兼容窗，前端生产侧删除归 T61）。）
 *
 * T60：POST /api/pi/active-design {nodeId} → 四条件校验 → 移槽 → 身份三元组
 * {modeId, profileId, briefId}（②面板点选 / ③set_active_design 同意卡共用；
 * 校验驳回 422 {error, message}，桥不可达 502）。
 *
 * T22：GET /api/pi/history?docKey=<族谱前缀>（或 ?sessionId=<完整 id>）→
 * { sessionId, messages }——会话族谱解析 + 历史回填（T22-plan D2/D3）。
 *
 * T45：GET /api/pi/studio/manifest → PiStudioManifest（注册表脱敏投影，
 * 无 markdown 正文）——前端 profile 选择器数据源（T24-plan D6）。
 *
 * T87：GET/PUT /api/pi/capabilities → 当前 builtinTools/agentSkills 状态 +
 * 切换端点（T96 三档位；settings 面板读写；PUT 校验失败 400；token 鉴权
 * 同 /api/pi/credentials）。
 *
 * 仅运行于独立 bun/node 进程（main.ts 入口或 vite 插件 spawn 的子进程），
 * 不经 vite esbuild 打包——@/ 别名经 bun 的 tsconfig paths 解析可用。
 * key 卫生：凭据只进不出（写入经 provider-admin，任何响应/日志不含 key）。
 *
 * T28（决策单 #1）：除 /health 外全部端点要求 Authorization: Bearer <token>
 * （auth.ts，timingSafeEqual 定常比较）；token 由 main.ts 解析传入——vite 插件
 * spawn 时经 env 注入（proxy 自动补头，前端零改动），standalone 自生成落
 * .dianjing/pi-backend-token。无 token 配置时 fail-close 全拒（不应发生）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { handleAskAnswerRequest } from './ask/answer-route'
import { isAuthorized } from './auth'
import { PI_BACKEND_DEFAULT_PORT } from './config'
import { handleDesignAssignmentRequest } from './design-assignment-route'
import {
  PayloadTooLargeError,
  optionalString,
  parseJSONBody,
  parsePostBody,
  readBody,
  sendJSON
} from './http-utils'
import { createImageGenCredentialStore } from './image-gen/credentials'
import { handleImageGenAdminRequest } from './image-gen/routes'
import { createImageGenSettingsStore } from './image-gen/settings'
import {
  defaultOpenFolderOpener,
  handleOpenImageGenFolderRequest,
  handleOpenStudioFolderRequest,
  type OpenFolderOpener
} from './open-studio-folder'
import { resolveAgentDir } from './paths'
import { createProviderAdmin, type ModelSpec } from './provider-admin'
import { createPiChatService } from './service'

export { PI_BACKEND_DEFAULT_PORT }

type PiChatRequestBody = {
  sessionId?: string
  messages?: Array<{
    role: string
    parts?: Array<{ type: string; text?: string }>
  }>
  model?: ModelSpec
  documentId?: string
  /** T98-路由：桥按发起窗口路由 RPC；缺省落最后注册窗（MCP 外部客户端语义兼容） */
  windowId?: string
  /** T60 兼容窗：残留字段忽略不报错（前端停发归 T61） */
  chatMode?: string
  pickedProfileId?: string | null
}

function lastUserText(body: PiChatRequestBody): string {
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')
  return (lastUser?.parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
}

async function handlePiChatRequest(
  service: ReturnType<typeof createPiChatService>,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await parsePostBody<PiChatRequestBody>(req, res)
  if (body === null) return

  const sessionId = body.sessionId
  const text = lastUserText(body)
  if (!sessionId || !text.trim()) {
    res.writeHead(400).end('Bad Request: sessionId and non-empty user text required')
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-vercel-ai-ui-message-stream': 'v1'
  })

  // T27：客户端断连（前端 stop 只 abort fetch）时取消后端当次 run，停止烧 token；
  // 正常收尾（res.end 已发）时 writableEnded 为 true，不误伤
  res.on('close', () => {
    if (!res.writableEnded) void service.abort(sessionId)
  })

  const emit = (chunk: unknown) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }

  try {
    // T100：spec 必填——无 spec 抛可行动错误（文案与 provider-admin.resolveModel 同源），
    // 走 SSE errorText 通道；前端引导门是第一道闸，此处兜底
    if (!body.model?.providerId || !body.model.modelId) {
      throw new Error('未指派设计模型——请打开设置→AI 选择 provider 与模型后再试')
    }
    await service.prompt(sessionId, text, emit, {
      model: body.model,
      documentId: body.documentId,
      windowId: body.windowId
    })
  } catch (error) {
    emit({
      type: 'error',
      errorText: error instanceof Error ? error.message : String(error)
    })
  } finally {
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

/**
 * T73：显式取消端点——POST /api/pi-chat/cancel {sessionId}。
 * 背景：唯一取消通道曾是上方 res.on('close')（T27），其触发依赖客户端
 * socket 关闭语义穿透 vite http-proxy 到达上游连接，实证不可靠（T73-plan §1
 * R4 curl 对照：客户端进程死后 25s+ 后端仍持续执行工具）。前端 transport 在
 * abortSignal 触发时同步 POST 本端点（带外通道，不依赖连接生命周期）。
 * 幂等无害：service.abort 对未知/空闲 session 是 no-op（T66 钉扎）；重复
 * cancel（stop 连点、close 兜底叠加）不产生副作用。
 */
async function handlePiChatCancelRequest(
  service: ReturnType<typeof createPiChatService>,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  let body: { sessionId?: unknown }
  try {
    body = JSON.parse(await readBody(req)) as { sessionId?: unknown }
  } catch {
    res.writeHead(400).end('Bad Request: invalid JSON')
    return
  }
  if (typeof body.sessionId !== 'string' || !body.sessionId) {
    res.writeHead(400).end('Bad Request: sessionId required')
    return
  }
  await service.abort(body.sessionId)
  res.writeHead(204).end()
}

/**
 * T60：POST /api/pi/active-design {nodeId}——②面板点选 / ③AI 声明+同意共用
 * 的移槽端点（非聊天消息）。成功 200 身份三元组；四条件驳回 422；桥不可达 502。
 */
// T60：POST /api/pi/active-design {nodeId}——②面板点选 / ③AI 声明+同意共用
// 的移槽端点（非聊天消息）。成功 200 身份三元组；四条件驳回 422；桥不可达 502。
async function handleIntentConfirmRequest(
  service: ReturnType<typeof createPiChatService>,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  // intent 确认端点：modeId + profileId/canvas/documentId/windowId 可选。
  const parsed = await parseJSONBody(req, res)
  if (!parsed.ok) return
  const body = parsed.body as {
    modeId?: unknown
    profileId?: unknown
    canvas?: unknown
    documentId?: unknown
    windowId?: unknown
  }
  if (typeof body.modeId !== 'string' || body.modeId.trim() === '') {
    res.writeHead(400).end('Bad Request: modeId required')
    return
  }
  // T98-路由：windowId/documentId 随确认请求直传——多窗时按发起窗路由桥调用
  const windowId = optionalString(body.windowId)
  const documentId = optionalString(body.documentId)
  const confirmArgs: { modeId: string; profileId?: string; canvas?: string } = {
    modeId: body.modeId
  }
  if (typeof body.profileId === 'string') confirmArgs.profileId = body.profileId
  if (typeof body.canvas === 'string') confirmArgs.canvas = body.canvas
  const result = await service.confirmNewIntent(confirmArgs, documentId, windowId)
  if (result.ok) {
    sendJSON(res, 200, {
      ok: true,
      modeId: result.modeId,
      profileId: result.profileId,
      canvas: result.canvas
    })
    return
  }
  sendJSON(res, result.error === 'bridge_unavailable' ? 502 : 422, {
    error: result.error,
    message: result.message
  })
}

async function handleActiveDesignRequest(
  service: ReturnType<typeof createPiChatService>,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  // 点选端点：nodeId 必填，documentId/windowId 透传 T98 路由。
  const parsed = await parseJSONBody(req, res)
  if (!parsed.ok) return
  const body = parsed.body as {
    nodeId?: unknown
    documentId?: unknown
    windowId?: unknown
  }
  if (typeof body.nodeId !== 'string' || body.nodeId.trim() === '') {
    res.writeHead(400).end('Bad Request: nodeId required')
    return
  }
  // T98-路由：windowId/documentId 随点选请求直传——多窗时按发起窗路由桥调用
  const windowId = typeof body.windowId === 'string' && body.windowId ? body.windowId : undefined
  const documentId =
    typeof body.documentId === 'string' && body.documentId ? body.documentId : undefined
  const result = await service.setActiveDesign(body.nodeId, documentId, windowId)
  if (result.ok) {
    sendJSON(res, 200, {
      modeId: result.modeId,
      profileId: result.profileId,
      briefId: result.briefId,
      name: result.name
    })
    return
  }
  sendJSON(res, result.error === 'bridge_unavailable' ? 502 : 422, {
    error: result.error,
    message: result.message
  })
}

/** 2026-09-15：POST /api/pi/ask-answer 实现见 ./ask-answer-route.ts */

/**
 * T87：GET/PUT /api/pi/capabilities——capabilities 读写。GET 返
 * `{ builtinTools, agentSkills }`（settings 面板初始值）；PUT 校验 agentSkills
 * 布尔 + builtinTools 三档字面量（T96，缺省保留旧值）、落盘、返新态。
 * 校验失败 400；超限 413（沿用 readBody 拦截）。
 */
async function handleCapabilitiesRequest(
  service: ReturnType<typeof createPiChatService>,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method === 'GET') {
    sendJSON(res, 200, service.getCapabilities())
    return
  }
  if (req.method !== 'PUT') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  let body: { agentSkills?: unknown; builtinTools?: unknown }
  try {
    body = JSON.parse(await readBody(req)) as {
      agentSkills?: unknown
      builtinTools?: unknown
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      res.writeHead(413).end('Payload Too Large')
      return
    }
    res.writeHead(400).end('Bad Request: invalid JSON')
    return
  }
  try {
    const next = service.setCapabilities({
      agentSkills: body.agentSkills,
      builtinTools: body.builtinTools
    })
    sendJSON(res, 200, next)
  } catch (error) {
    sendJSON(res, 400, {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * T100 C1：DELETE /api/pi/providers/{providerId}——只删自定义 provider，
 * 内建 providerId 抛 400（provider-admin 兜底）；错误由 handleAdminRequest
 * catch 统一返 400 JSON。独立 handler 控制 handleAdminRequest 复杂度（oxlint 上限）。
 */
async function handleDeleteProviderRequest(
  admin: ReturnType<typeof createProviderAdmin>,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<void> {
  if (req.method !== 'DELETE') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  const providerId = decodeURIComponent(pathname.slice('/api/pi/providers/'.length))
  if (!providerId) {
    res.writeHead(400).end('Bad Request: providerId required')
    return
  }
  await admin.deleteProvider(providerId)
  sendJSON(res, 200, { ok: true })
}

/**
 * T100 B1：POST /api/pi/credentials/verify {providerId}——对该 provider 发
 * 最小 chat 请求（maxTokens=1）验真。返回 {ok:true} 或 {ok:false, error:中文}；
 * 不抛错（异常已被 provider-admin.verifyCredential 内部捕获翻译为 error 字段）。
 */
async function handleVerifyCredentialRequest(
  admin: ReturnType<typeof createProviderAdmin>,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  const body = JSON.parse((await readBody(req)) || '{}') as { providerId?: string }
  if (!body.providerId) {
    sendJSON(res, 400, { error: 'providerId required' })
    return
  }
  const result = await admin.verifyCredential(body.providerId)
  sendJSON(res, 200, result)
}

async function handleAdminRequest(
  admin: ReturnType<typeof createProviderAdmin>,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<void> {
  try {
    if (pathname === '/api/pi/catalog') {
      if (req.method !== 'GET') {
        res.writeHead(405).end('Method Not Allowed')
        return
      }
      sendJSON(res, 200, await admin.getCatalog())
      return
    }
    if (pathname === '/api/pi/credentials') {
      const body = (JSON.parse((await readBody(req)) || '{}') ?? {}) as {
        providerId?: string
        apiKey?: string
      }
      if (req.method === 'POST') {
        if (!body.providerId || !body.apiKey) {
          res.writeHead(400).end('Bad Request: providerId and apiKey required')
          return
        }
        await admin.setCredential(body.providerId, body.apiKey)
        sendJSON(res, 200, { ok: true })
        return
      }
      if (req.method === 'DELETE') {
        if (!body.providerId) {
          res.writeHead(400).end('Bad Request: providerId required')
          return
        }
        await admin.deleteCredential(body.providerId)
        sendJSON(res, 200, { ok: true })
        return
      }
      res.writeHead(405).end('Method Not Allowed')
      return
    }
    if (pathname === '/api/pi/providers') {
      if (req.method !== 'POST') {
        res.writeHead(405).end('Method Not Allowed')
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}') as Parameters<
        ReturnType<typeof createProviderAdmin>['upsertProvider']
      >[0]
      await admin.upsertProvider(body)
      sendJSON(res, 200, { ok: true })
      return
    }
    // T100 C1/B1：两个新端点各收进独立 handler（复杂度控制）
    if (pathname.startsWith('/api/pi/providers/')) {
      await handleDeleteProviderRequest(admin, req, res, pathname)
      return
    }
    if (pathname === '/api/pi/credentials/verify') {
      await handleVerifyCredentialRequest(admin, req, res)
      return
    }
    res.writeHead(404).end('Not Found')
  } catch (error) {
    // T27：超限 413；其余错误文案由 provider-admin 保证不含 key 本体
    if (error instanceof PayloadTooLargeError) {
      res.writeHead(413).end('Payload Too Large')
      return
    }
    sendJSON(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * T27：只读 GET 路由（history/sessions/studio manifest）统一收编——
 * ① fs 读取异常不应打穿进程（500 而非崩溃/悬挂）；② 从 createServer 回调
 * 抽出控制复杂度（oxlint complexity 上限）。返回是否已处理。
 * 必须在 /api/pi/ 管理面前缀之前匹配（调用方保证顺序）。
 */
function handleReadonlyPiRequest(
  service: ReturnType<typeof createPiChatService>,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): boolean {
  const { pathname } = url
  if (
    pathname !== '/api/pi/history' &&
    pathname !== '/api/pi/sessions' &&
    pathname !== '/api/pi/studio/manifest'
  ) {
    return false
  }
  if (req.method !== 'GET') {
    res.writeHead(405).end('Method Not Allowed')
    return true
  }
  try {
    // T22：历史回填（D3）——docKey 前缀解析族内最新会话，或 sessionId 精确读取
    if (pathname === '/api/pi/history') {
      const exact = url.searchParams.get('sessionId')
      const docKey = url.searchParams.get('docKey')
      const sessionId = exact ?? (docKey ? service.resolveLatestSessionId(docKey) : null)
      if (!sessionId) {
        sendJSON(res, 200, { sessionId: null, messages: [] })
        return true
      }
      sendJSON(res, 200, { sessionId, messages: service.readHistory(sessionId) })
      return true
    }
    // T23：会话族谱清单（E1）——docKey 前缀扫描族内全部会话摘要，最新在前
    if (pathname === '/api/pi/sessions') {
      const docKey = url.searchParams.get('docKey')
      sendJSON(res, 200, { sessions: docKey ? service.listSessionFamily(docKey) : [] })
      return true
    }
    // T45：studio manifest——注册表脱敏投影供前端选择器（modes/profiles/failures）
    sendJSON(res, 200, service.getStudioManifest())
  } catch (error) {
    sendJSON(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
  return true
}

export function createPiBackendServer({
  rootDir,
  authToken,
  openFolder = defaultOpenFolderOpener
}: {
  rootDir: string
  /** T28：bearer 鉴权 token（main.ts 解析）；null = 无配置，fail-close 全拒 */
  authToken: string | null
  /** ai-panel-ux-consolidation：测试桩位——生产走 defaultOpenFolderOpener */
  openFolder?: OpenFolderOpener
}): Server {
  const admin = createProviderAdmin({ agentDir: resolveAgentDir(rootDir) })
  // T54：generate_image 凭证面（三键存储 + 状态端点）——单实例同时供管理
  // 路由与 service 内 generate_image 工具消费，避免双实例缓存漂移（保存 key
  // 后工具侧立即可见）
  const agentDir = resolveAgentDir(rootDir)
  const imageGenCredentials = createImageGenCredentialStore({ agentDir })
  // 图片本地留存偏好（retainLocal）——单实例供 settings 路由读 / generate_image
  // 工具每条 item 实时问开关（同凭证面纪律：保存后工具侧立即可见）
  const imageGenSettings = createImageGenSettingsStore({ agentDir })
  const service = createPiChatService({
    rootDir,
    admin,
    imageGenCredentials,
    imageGenSettings
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      sendJSON(res, 200, { status: 'ok' })
      return
    }
    // T28：/health（就绪探针）之外全部端点鉴权——管理面写 key/baseUrl、
    // 只读面泄会话历史，都不能裸奔；未带/带错 token 一律 401（响应不含任何提示内容）
    if (!isAuthorized(req.headers.authorization, authToken)) {
      sendJSON(res, 401, { error: 'unauthorized' })
      return
    }
    if (url.pathname === '/api/pi-chat') {
      void handlePiChatRequest(service, req, res)
      return
    }
    // T73：显式取消端点（exact match，与 /api/pi-chat 无前缀冲突）
    if (url.pathname === '/api/pi-chat/cancel') {
      void handlePiChatCancelRequest(service, req, res)
      return
    }
    // T60：active_design 移槽端点（须在 /api/pi/ 管理面前缀之前匹配）
    if (url.pathname === '/api/pi/active-design') {
      void handleActiveDesignRequest(service, req, res)
      return
    }
    // T91b：newIntent 确认端点（前端 ChatNewIntentCard 触发，写 pluginData 三键）
    if (url.pathname === '/api/pi/intent-confirm') {
      void handleIntentConfirmRequest(service, req, res)
      return
    }
    // 2026-09-15：表单作答/跳过端点（ask_user_question 硬阻断新流；须在
    // /api/pi/ 管理面前缀之前匹配）
    if (url.pathname === '/api/pi/ask-answer') {
      void handleAskAnswerRequest(service, req, res)
      return
    }
    // T87：capabilities 单开关读写端点（须在 /api/pi/ 管理面前缀之前匹配）
    if (url.pathname === '/api/pi/capabilities') {
      void handleCapabilitiesRequest(service, req, res)
      return
    }
    if (url.pathname === '/api/pi/design-assignment') {
      // 与 capabilities 同款两形制——单行 return void 触发 consistent-return
      // （本函数其他分支无返回值，CI type-aware 实证）
      void handleDesignAssignmentRequest(service, req, res)
      return
    }
    // T22/T23/T24 只读路由（须在 /api/pi/ 管理面前缀之前匹配）
    if (handleReadonlyPiRequest(service, req, res, url)) return
    // T54：生图凭证面（须在 /api/pi/ 管理面前缀之前匹配；只进不出）
    if (url.pathname.startsWith('/api/pi/image-gen/')) {
      void handleImageGenAdminRequest(
        { credentials: imageGenCredentials, settings: imageGenSettings, rootDir },
        req,
        res,
        url.pathname
      )
      return
    }
    // ai-panel-ux-consolidation：打开用户拓展目录端点（exact match，独立 handler
    // 兜复杂度；须在 /api/pi/ 管理面前缀之前匹配）
    if (url.pathname === '/api/pi/open-studio-folder') {
      void handleOpenStudioFolderRequest(rootDir, req, res, sendJSON, openFolder)
      return
    }
    // 图片本地留存目录打开端点（exact match；同 open-studio-folder 形态但目录不同）
    if (url.pathname === '/api/pi/open-image-gen-folder') {
      void handleOpenImageGenFolderRequest(rootDir, req, res, sendJSON, openFolder)
      return
    }
    if (url.pathname.startsWith('/api/pi/')) {
      void handleAdminRequest(admin, req, res, url.pathname)
      return
    }
    res.writeHead(404).end('Not Found')
  })
  // SSE 长连接 + 长生成：关闭请求级超时（默认 300s 会斩断长回合）
  server.requestTimeout = 0
  return server
}
