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
    const providers: PiCatalogProvider[] = []
    for (const provider of runtime.getProviders()) {
      const check = await runtime.checkAuth(provider.id).catch(() => undefined)
      providers.push({
        id: provider.id,
        name: provider.name,
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

  async function resolveModel(spec?: ModelSpec): Promise<{
    modelRuntime: ModelRuntime
    model: NonNullable<ReturnType<ModelRuntime['getModel']>>
  }> {
    const modelRuntime = await ensureRuntime()
    if (spec) {
      const model = modelRuntime.getModel(spec.providerId, spec.modelId)
      if (!model) {
        throw new Error(
          `模型 ${spec.providerId}/${spec.modelId} 不在目录中——请打开设置检查 provider 配置（GET /api/pi/catalog 可查全量目录）`
        )
      }
      return { modelRuntime, model }
    }
    const fallback = modelRuntime.getModel('openrouter', 'openrouter/free')
    if (fallback) return { modelRuntime, model: fallback }
    const available = await modelRuntime.getAvailable()
    if (available.length === 0) {
      throw new Error('未配置任何可用模型/凭据——请打开设置→模型配置 provider 凭据后再试')
    }
    return { modelRuntime, model: available[0] }
  }

  return { getCatalog, setCredential, deleteCredential, upsertProvider, resolveModel }
}

export type ProviderAdmin = ReturnType<typeof createProviderAdmin>
