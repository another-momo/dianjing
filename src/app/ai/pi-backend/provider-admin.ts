/**
 * T21 pi 后端 provider/凭据管理面（owner 拍板 2026-08-24：一步到位 pi 原生，
 * 不迁移存量、不做多 agent 过度设计；产品形态参考 deepseek-harness：
 * 无 key 可开机、目录可浏览、存 key 即用、秘密不回显）。
 *
 * 职责：
 *  - ModelRuntime 生命周期（authPath/modelsPath 固定于 agentDir，即
 *    .dianjing/pi-agent/；models.json 缺失时写种子——openrouter/free 免费
 *    默认路由，纯配置无秘密）
 *  - catalog 序列化（白名单字段；凭据只回 {configured,type,source} 元数据，
 *    永不回 key 本体）
 *  - 凭据写路径：首选 ModelRuntime.login('api_key', scripted interaction)
 *    （T21 spike 实证：写后 getAuth 立即可用、auth.json 落盘、logout 回空）；
 *    兜底（自定义 provider 无交互 login 时）直写 auth.json（pi 格式）+ runtime.refresh()
 *  - 自定义 provider upsert → models.json 读改写 + runtime 重建
 *
 * key 卫生：本模块不打印 key、不在返回值/错误信息里携带 key。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

// T27：catalog DTO 单源在 ./catalog（type-only，与前端 client.ts 共享契约）
import type { PiCatalog, PiCatalogModel, PiCatalogProvider } from './catalog'

export type { PiCatalog, PiCatalogModel, PiCatalogProvider }

export type ThinkingLevelName = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ModelSpec = {
  providerId: string
  modelId: string
  thinkingLevel?: ThinkingLevelName
}

export type CustomProviderInput = {
  id: string
  name?: string
  /** 类型上可选（外部 JSON 输入，运行期校验必填） */
  baseUrl?: string
  api?: string
  /** 接受纯 id 字符串（设置页一行一个的输入形态）或完整模型描述对象 */
  models: Array<
    | string
    | {
        id: string
        name?: string
        api?: string
        reasoning?: boolean
        input?: string[]
        contextWindow?: number
        maxTokens?: number
        cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
      }
  >
}

/** 种子 models.json：openrouter/free 免费默认路由（T19 起的产品默认，纯配置） */
const SEED_MODELS_JSON = {
  providers: {
    openrouter: {
      apiKey: '$OPENROUTER_API_KEY',
      models: [
        {
          id: 'openrouter/free',
          name: 'OpenRouter Free (meta route)',
          api: 'openai-completions',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 65536,
          maxTokens: 8192
        }
      ]
    }
  }
} as const

const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/

/** T27：models.json 最小结构校验——启动/重建 runtime 前 fail-fast；
 * 错误文案只含路径与字段名，不打印文件内容（文件内有 apiKey 引用） */
function validateModelsDoc(raw: string, modelsPath: string): void {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new Error(
      `models.json 不是合法 JSON（${modelsPath}）——修复或删除后重启（缺失时会自动重建种子）`
    )
  }
  const providers = (doc as { providers?: unknown } | null)?.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error(`models.json 缺少 providers 对象（${modelsPath}）`)
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    const models = (provider as { models?: unknown } | null)?.models
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error(`models.json provider "${providerId}" 缺少非空 models 数组（${modelsPath}）`)
    }
    for (const model of models) {
      const id = (model as { id?: unknown } | null)?.id
      if (typeof id !== 'string' || !id) {
        throw new Error(
          `models.json provider "${providerId}" 含缺 id 的 model 条目（${modelsPath}）`
        )
      }
    }
  }
}

function assertKeyCarriable(apiKey: string): string {
  const key = apiKey.trim()
  if (!key) throw new Error('API key 为空')
  if (/[\r\n]/.test(key) || /\s/.test(key)) {
    throw new Error('API key 含空白字符，无法作为 HTTP 头携带——请检查是否复制完整')
  }
  return key
}

export function createProviderAdmin({ agentDir }: { agentDir: string }) {
  const authPath = join(agentDir, 'auth.json')
  const modelsPath = join(agentDir, 'models.json')
  let runtimePromise: Promise<ModelRuntime> | null = null

  function ensureRuntime(): Promise<ModelRuntime> {
    runtimePromise ??= (async () => {
      mkdirSync(agentDir, { recursive: true })
      if (!existsSync(modelsPath)) {
        writeFileSync(modelsPath, JSON.stringify(SEED_MODELS_JSON, null, 2))
      } else {
        // T27：既有 models.json 先做最小结构校验，坏配置在启动期报清晰错误
        // 而非在 ModelRuntime 深处炸难以定位的解析失败
        validateModelsDoc(readFileSync(modelsPath, 'utf8'), modelsPath)
      }
      return ModelRuntime.create({ authPath, modelsPath })
    })()
    // T27：校验/初始化失败不留死 promise（否则修完 models.json 仍永久 400）——
    // 失败即释放缓存，下次调用重试
    const pending = runtimePromise
    pending.catch(() => {
      if (runtimePromise === pending) runtimePromise = null
    })
    return runtimePromise
  }

  function resetRuntime(): void {
    runtimePromise = null
  }

  async function getCatalog(): Promise<PiCatalog> {
    const runtime = await ensureRuntime()
    // T100 C1：把内建/自定义判定一次性算出来塞进 catalog.kind，前端无需
    // 重复构造 builtinIds 集合（也不该 import SDK node-only 模块进浏览器包）。
    const builtinIds = new Set(builtinProviders().map((p) => p.id))
    const providers: PiCatalogProvider[] = []
    for (const provider of runtime.getProviders()) {
      const check = await runtime.checkAuth(provider.id).catch(() => undefined)
      providers.push({
        id: provider.id,
        name: provider.name,
        kind: builtinIds.has(provider.id) ? 'builtin' : 'custom',
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        auth: check
          ? {
              configured: true,
              type: check.type,
              ...(check.source ? { source: check.source } : {})
            }
          : { configured: false },
        models: provider.getModels().map((m) => ({
          id: m.id,
          name: m.name,
          api: m.api,
          reasoning: m.reasoning,
          input: [...m.input],
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          cost: m.cost
        }))
      })
    }
    return { providers }
  }

  /** pi auth.json 文件格式：Record<providerId, Credential>（仅本模块兜底写路径使用） */
  type AuthJSONCredential = { type: 'api_key' | 'oauth'; key?: string }
  type AuthJSONDoc = Partial<Record<string, AuthJSONCredential>>

  /** 兜底写路径：login 不可用时直写 auth.json（pi 格式 Record<providerId, Credential>） */
  function writeAuthJSON(providerId: string, apiKey: string): void {
    let data: AuthJSONDoc = {}
    try {
      data = JSON.parse(readFileSync(authPath, 'utf8')) as AuthJSONDoc
    } catch {
      data = {}
    }
    data[providerId] = { type: 'api_key', key: apiKey }
    writeFileSync(authPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  async function setCredential(providerId: string, apiKey: string): Promise<void> {
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      throw new Error(`providerId 非法：${providerId}（仅小写字母/数字/连字符）`)
    }
    const key = assertKeyCarriable(apiKey)
    const runtime = await ensureRuntime()
    try {
      await runtime.login(providerId, 'api_key', {
        prompt: () => Promise.resolve(key),
        notify: () => undefined
      })
    } catch (loginError) {
      // 自定义 provider 可能没有交互式 login——直写 auth.json + 刷新快照
      console.error(
        `[pi-backend] login(${providerId}) 不可用，改直写 auth.json：${loginError instanceof Error ? loginError.message : String(loginError)}`
      )
      writeAuthJSON(providerId, key)
      await runtime.refresh()
    }
    const auth = await runtime.getAuth(providerId)
    if (!auth?.auth.apiKey) {
      throw new Error(`凭据写入后仍不可解析（provider: ${providerId}）——请检查 provider 是否存在`)
    }
  }

  async function deleteCredential(providerId: string): Promise<void> {
    const runtime = await ensureRuntime()
    await runtime.logout(providerId)
  }

  async function upsertProvider(input: CustomProviderInput): Promise<void> {
    if (!PROVIDER_ID_PATTERN.test(input.id)) {
      throw new Error(`provider id 非法：${input.id}（仅小写字母/数字/连字符）`)
    }
    if (!input.baseUrl?.trim()) throw new Error('自定义 provider 必须提供 baseUrl')
    if (!Array.isArray(input.models) || input.models.length === 0) {
      throw new Error('自定义 provider 至少声明一个 model')
    }
    await ensureRuntime()
    let doc: { providers: Record<string, unknown> } = { providers: {} }
    try {
      doc = JSON.parse(readFileSync(modelsPath, 'utf8')) as typeof doc
    } catch {
      doc = { providers: {} }
    }
    const providerEntry: {
      name?: string
      baseUrl: string
      api?: string
      models: Array<{
        id: string
        name: string
        api?: string
        reasoning: boolean
        input: string[]
        cost: Record<string, number>
        contextWindow: number
        maxTokens: number
      }>
    } = {
      baseUrl: input.baseUrl.trim(),
      models: input.models.map((raw) => {
        const m = typeof raw === 'string' ? { id: raw } : raw
        const modelEntry: {
          id: string
          name: string
          api?: string
          reasoning: boolean
          input: string[]
          cost: Record<string, number>
          contextWindow: number
          maxTokens: number
        } = {
          id: m.id,
          name: m.name ?? m.id,
          reasoning: m.reasoning ?? false,
          input: m.input ?? ['text'],
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            ...m.cost,
            input: m.cost?.input ?? 0,
            output: m.cost?.output ?? 0
          },
          contextWindow: m.contextWindow ?? 32768,
          maxTokens: m.maxTokens ?? 8192
        }
        const apiValue = m.api ?? input.api
        if (apiValue) modelEntry.api = apiValue
        return modelEntry
      })
    }
    if (input.name) providerEntry.name = input.name
    if (input.api) providerEntry.api = input.api
    doc.providers[input.id] = providerEntry
    writeFileSync(modelsPath, JSON.stringify(doc, null, 2))
    // provider 目录变更需重建 runtime（凭据变更不需要——login 内部同步快照）
    resetRuntime()
    await ensureRuntime()
  }

  /**
   * T100 C1：删除自定义 provider——只删「非 SDK 内建 + models.json 中存在」的条目；
   * 内建 provider（pi SDK 40 家）拒绝 400，避免误删 SDK 自带支持。
   * 同清 auth.json 凭据（logout）+ models.json 条目 + models-store.json 缓存条目
   * （能定位时同清；不能定位不影响正确性，记 warn），重建 runtime。
   */
  async function deleteProvider(providerId: string): Promise<void> {
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      throw new Error(`provider id 非法：${providerId}（仅小写字母/数字/连字符）`)
    }
    // 内建 = pi SDK builtinProviders() 注册的 id（包含 openrouter/anthropic/openai 等 40 家）
    const builtinIds = new Set(builtinProviders().map((p) => p.id))
    if (builtinIds.has(providerId)) {
      throw new Error(
        `${providerId} 是内建 provider，不可删除——只能删除设置中添加的自定义 provider`
      )
    }
    await ensureRuntime()
    let doc: { providers?: Record<string, unknown> } = {}
    try {
      doc = JSON.parse(readFileSync(modelsPath, 'utf8')) as typeof doc
    } catch {
      doc = {}
    }
    const providers = doc.providers ?? {}
    if (!(providerId in providers)) {
      throw new Error(`${providerId} 不在 models.json 中，无需删除（确认 providerId 是否正确）`)
    }
    // 1. 从 models.json 删除该 provider 条目（immutable 去键——lint 禁动态 delete）
    doc.providers = Object.fromEntries(
      Object.entries(providers).filter(([id]) => id !== providerId)
    )
    writeFileSync(modelsPath, JSON.stringify(doc, null, 2))

    // 2. 凭据清理——logout 对未配凭据的 provider 是 no-op，对已配的会清 auth.json 条目
    const runtime = await ensureRuntime()
    try {
      await runtime.logout(providerId)
    } catch (error) {
      // 凭据清理失败不应阻断 provider 删除——但记 warn 以便诊断
      console.warn(
        `[pi-backend] deleteProvider: logout(${providerId}) 失败（已删除 models.json 条目）：` +
          (error instanceof Error ? error.message : String(error))
      )
    }

    // 3. models-store.json 缓存条目清理（best-effort）——定位则同清、否则记 warn。
    //    pi SDK 把动态 provider 远程 catalog 缓存写到这里，按 providerId key。
    //    文件不存在/读失败/格式异常时跳过：缓存只是加速，残留条目不会
    //    影响下次 getCatalog（custom provider 已被删，缓存条目成孤儿）。
    const modelsStorePath = join(agentDir, 'models-store.json')
    try {
      const store: unknown = JSON.parse(readFileSync(modelsStorePath, 'utf8'))
      if (store !== null && typeof store === 'object' && providerId in store) {
        const remaining = Object.fromEntries(
          Object.entries(store).filter(([id]) => id !== providerId)
        )
        writeFileSync(modelsStorePath, JSON.stringify(remaining, null, 2))
      }
    } catch (error) {
      // 缓存清理失败不影响正确性（孤儿条目无害）——warn 留诊断线索
      console.warn(
        `[pi-backend] deleteProvider: models-store.json 缓存清理跳过：` +
          (error instanceof Error ? error.message : String(error))
      )
    }

    // 4. 重建 runtime——provider 目录变更的同一通路（与 upsertProvider 一致）
    resetRuntime()
    await ensureRuntime()
  }

  /**
   * T100 B1 + T101：凭据验证——按 model.api 形态分两路裸发验真端点：
   *   - openai 系（openai-completions / openai-responses）→ POST /chat/completions
   *     Bearer 头，body={model, messages:[…], max_tokens:1}
   *   - anthropic-messages → POST {baseURL}/v1/messages，x-api-key +
   *     anthropic-version:2023-06-01 头（版本串对齐 @anthropic-ai/sdk 客户端
   *     默认值 client.mjs line 465），body 同款最小体（max_tokens:1 +
   *     messages:[{role:user,content:'ping'}]）。/v1 前缀镜像 SDK 真实请求
   *     路径（messages.mjs 硬编码 post('/v1/messages')，builtin baseUrl 不含
   *     /v1）——漏了 /v1 会打到未注册路径 404 <500 误判 ok，验真失灵。
   * 状态码裁口径两路完全同构：
   *   401/403 → key 被拒（确定失败）；其余 <500（200/400/422/429）→ 已过鉴权即
   * key 有效（400/422 是请求参数问题与 key 无关，429 限流但 key 真）；5xx /
   * 网络异常 → 不确定，诚实文案收尾，不误判 key。两路共用 classifyVerifyStatus
   * 翻译状态码→结论（避免两路文案漂移）。
   *
   * 仍无通用验真端点的形态（bedrock-converse-stream / google-generative-ai /
   * google-vertex / mistral-conversations / openai-codex-responses /
   * azure-openai-responses 等）→ 不确定文案「以实际对话为准」。
   *
   * 为什么不走 runtime.completeSimple：SDK openai-completions 实现会吞掉
   * HTTP 错误状态、把 401 响应当空 choices 解析成 content:[] 的"成功"
   * （2026-09-14 L3 实测：假 key completeSimple 返回成功，裸 fetch 同 key
   * 拿到 401）——验真必须自己看状态码。测试侧的 fetch 桩同步替换（原
   * completeSimple 桩永远遵守 throw/成功契约，盖不住 SDK 吞状态）。
   */
  /** 状态码→结论翻译：401/403 拒 / <500 过 / ≥500 不确定（provider-admin 私用） */
  function classifyVerifyStatus(
    providerId: string,
    status: number
  ): { ok: boolean; error?: string } {
    if (status === 401 || status === 403) {
      return {
        ok: false,
        error: `${providerId} 凭据被拒绝（HTTP ${status}）——key 错误、已过期或无权限`
      }
    }
    if (status < 500) return { ok: true }
    return {
      ok: false,
      error: `${providerId} 验证端点服务异常（HTTP ${status}）——稍后再试，或以实际对话为准`
    }
  }

  async function verifyCredential(providerId: string): Promise<{ ok: boolean; error?: string }> {
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      return { ok: false, error: `provider id 非法：${providerId}（仅小写字母/数字/连字符）` }
    }
    const runtime = await ensureRuntime()
    // 先拿解析后的 key——getAuth 含 models.json $VAR 环境变量解析（setCredential 同路径）
    const auth = await runtime.getAuth(providerId).catch(() => undefined)
    const apiKey = auth?.auth.apiKey
    if (!apiKey) {
      return {
        ok: false,
        error: `尚未为 ${providerId} 配置 API key——请先保存凭据后再验证（oauth 等类型暂不支持在线验证）`
      }
    }
    const provider = runtime.getProviders().find((entry) => entry.id === providerId)
    const firstModel = provider?.getModels()[0]
    const baseURL = provider?.baseUrl
    if (!provider || !firstModel || !baseURL) {
      return {
        ok: false,
        error: `${providerId} 缺少 baseUrl 或模型定义，无法在线验证——key 已保存，以实际对话为准`
      }
    }
    // anthropic-messages 与 openai 两系各自走对应端点；其余形态仍兜底
    if (
      firstModel.api !== 'openai-completions' &&
      firstModel.api !== 'openai-responses' &&
      firstModel.api !== 'anthropic-messages'
    ) {
      return {
        ok: false,
        error: `${providerId} 的接口形态（${firstModel.api}）暂不支持在线验证——key 已保存，以实际对话为准`
      }
    }
    try {
      const url = `${baseURL.replace(/\/+$/, '')}/${
        firstModel.api === 'anthropic-messages' ? 'v1/messages' : 'chat/completions'
      }`
      const headers: Record<string, string> =
        firstModel.api === 'anthropic-messages'
          ? {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            }
          : { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
      const body =
        firstModel.api === 'anthropic-messages'
          ? JSON.stringify({
              model: firstModel.id,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }]
            })
          : JSON.stringify({
              model: firstModel.id,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1
            })
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000)
      })
      await response.body?.cancel().catch(() => undefined)
      return classifyVerifyStatus(providerId, response.status)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: `${providerId} 验证请求失败（${reason}）——检查网络连通性后以实际对话为准`
      }
    }
  }

  async function resolveModel(spec: ModelSpec): Promise<{
    modelRuntime: ModelRuntime
    model: NonNullable<ReturnType<ModelRuntime['getModel']>>
  }> {
    const modelRuntime = await ensureRuntime()
    // T100：spec 必填——无 spec 即"未指派"，直接报可行动错误，引导用户去设置面板
    // 指派（前端引导门是第一道闸，此处是兜底路径，前端被绕过时给出可定位的文案）
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- 运行时兜底：调用方可绕过 TS（单测 undefined as never 钉死此路径）
    if (!spec) {
      throw new Error('未指派设计模型——请打开设置→AI 选择 provider 与模型后再试')
    }
    const model = modelRuntime.getModel(spec.providerId, spec.modelId)
    if (!model) {
      throw new Error(
        `模型 ${spec.providerId}/${spec.modelId} 不在目录中——请打开设置检查 provider 配置（GET /api/pi/catalog 可查全量目录）`
      )
    }
    return { modelRuntime, model }
  }

  return {
    getCatalog,
    setCredential,
    deleteCredential,
    upsertProvider,
    deleteProvider,
    verifyCredential,
    resolveModel
  }
}

export type ProviderAdmin = ReturnType<typeof createProviderAdmin>
