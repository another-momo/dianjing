/**
 * T100 pi-backend 模型解析收紧 + 两个新端点（单测）：
 *  - resolveModel spec 必填 + 不在目录报错保留（a）
 *  - DELETE /api/pi/providers/{id} 三态（b）：自定义可删 / 内建拒绝 /
 *    凭据同清（models.json + auth.json + models-store.json）
 *  - POST /api/pi/credentials/verify 状态码分档（c）：未配凭据 ok=false /
 *    401 ok=false / 200/400 ok=true / 5xx 与网络异常不确定 / 非 openai 形态不支持
 *
 * 测试拓扑：真 createProviderAdmin（与 production 同源）+ 真 ModelRuntime
 * （models.json 缺失 = 纯内置目录——2026-09-16 种子退役，不再自动写盘）；
 * stub 全局 fetch 控验真状态码，禁打真实网络。
 * 无 vueuse/DOM 依赖，无 dev server 联动。
 *
 * 注：resolveModel 类型已收紧为 spec: ModelSpec；测无 spec 路径需 `as never`。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createProviderAdmin } from '@/app/ai/pi-backend/provider-admin'

let agentDir = ''

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-tighten-'))
})

afterEach(() => {
  if (agentDir) {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

/** 写入一份含自定义 provider 的 models.json（重建 runtime 前先落盘） */
function seedCustomProvider(id: string, models: Array<{ id: string; name?: string }>): void {
  mkdirSync(agentDir, { recursive: true })
  const doc = {
    providers: {
      [id]: {
        baseUrl: 'https://example.com/v1',
        // composeModelProvider.modelFromJson 要求 api（modelFromJson 必填）
        api: 'openai-completions',
        models: models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 8192
        }))
      }
    }
  }
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(doc, null, 2))
}

// ─────────────────────────────────────────────────────────────────────────
// a. resolveModel spec 必填
// ─────────────────────────────────────────────────────────────────────────

describe('a. resolveModel spec 必填（T100）', () => {
  test('无 spec → 报「未指派」可行动错误（开放/兜底文案钉死）', async () => {
    const admin = createProviderAdmin({ agentDir })
    // 类型层 spec 必填——测兜底路径需绕过 TS 检查
    await expect(admin.resolveModel(undefined as never)).rejects.toThrow(
      /未指派设计模型.*打开设置.*AI 选择 provider 与模型/
    )
  })

  test('有 spec 但 provider/model 不在目录 → 报「不在目录中」既有错误', async () => {
    const admin = createProviderAdmin({ agentDir })
    await expect(
      admin.resolveModel({ providerId: 'no-such-provider', modelId: 'whatever' })
    ).rejects.toThrow(/不在目录中/)
  })

  test('有效 spec（内置 openrouter/free）→ 返回 model + runtime', async () => {
    const admin = createProviderAdmin({ agentDir })
    const { model, modelRuntime } = await admin.resolveModel({
      providerId: 'openrouter',
      modelId: 'openrouter/free'
    })
    expect(model.provider).toBe('openrouter')
    expect(model.id).toBe('openrouter/free')
    expect(typeof modelRuntime.getProviders).toBe('function')
  })

  test('有效 spec（自定义 provider）→ 返回该 model', async () => {
    seedCustomProvider('my-local', [{ id: 'local-model' }])
    const admin = createProviderAdmin({ agentDir })
    const { model } = await admin.resolveModel({ providerId: 'my-local', modelId: 'local-model' })
    expect(model.provider).toBe('my-local')
    expect(model.id).toBe('local-model')
  })

  test('models.json 缺失 → 不落盘任何文件；openrouter/free 由内置目录供给（2026-09-16 种子退役）', async () => {
    const admin = createProviderAdmin({ agentDir })
    const catalog = await admin.getCatalog()
    expect(existsSync(join(agentDir, 'models.json'))).toBe(false)
    const openrouter = catalog.providers.find((p) => p.id === 'openrouter')
    expect(openrouter?.models.some((m) => m.id === 'openrouter/free')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// b. DELETE /api/pi/providers/{id} 三态
// ─────────────────────────────────────────────────────────────────────────

describe('b. deleteProvider 三态（T100 C1）', () => {
  test('内建 provider（openrouter）→ 抛 400「是内建 provider」', async () => {
    const admin = createProviderAdmin({ agentDir })
    await expect(admin.deleteProvider('openrouter')).rejects.toThrow(/是内建 provider.*不可删除/)
  })

  test('非法 id → 抛 400「provider id 非法」', async () => {
    const admin = createProviderAdmin({ agentDir })
    await expect(admin.deleteProvider('BAD_ID!')).rejects.toThrow(/provider id 非法/)
  })

  test('自定义 provider → 删除 models.json 条目 + 重建 runtime 后 catalog 不再含该 id', async () => {
    seedCustomProvider('my-custom', [{ id: 'custom-model' }])
    const admin = createProviderAdmin({ agentDir })
    // 删前 catalog 含自定义
    const before = await admin.getCatalog()
    expect(before.providers.some((p) => p.id === 'my-custom')).toBe(true)

    await admin.deleteProvider('my-custom')

    // 1. models.json 文件层：条目已删
    const afterDoc = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')) as {
      providers: Record<string, unknown>
    }
    expect('my-custom' in afterDoc.providers).toBe(false)

    // 2. runtime 层：catalog 不再含
    const after = await admin.getCatalog()
    expect(after.providers.some((p) => p.id === 'my-custom')).toBe(false)

    // 3. 内建 provider 仍存在（未被误伤）
    expect(after.providers.some((p) => p.id === 'openrouter')).toBe(true)
  })

  test('models-store.json 缓存条目同清（best-effort 路径）', async () => {
    seedCustomProvider('my-custom', [{ id: 'custom-model' }])
    // 预置 models-store.json 含 my-custom 条目
    writeFileSync(
      join(agentDir, 'models-store.json'),
      JSON.stringify({
        'my-custom': { someCached: 'value' },
        openrouter: { otherCached: 'value' }
      })
    )
    const admin = createProviderAdmin({ agentDir })
    await admin.deleteProvider('my-custom')

    const storeAfter: unknown = JSON.parse(
      readFileSync(join(agentDir, 'models-store.json'), 'utf8')
    )
    if (storeAfter === null || typeof storeAfter !== 'object') {
      throw new Error('models-store.json 应为对象')
    }
    expect('my-custom' in storeAfter).toBe(false)
    // 其他条目未被误伤
    expect('openrouter' in storeAfter).toBe(true)
  })

  test('models-store.json 不存在 → delete 不报错（best-effort 静默跳过）', async () => {
    seedCustomProvider('my-custom', [{ id: 'custom-model' }])
    // 不写 models-store.json
    expect(existsSync(join(agentDir, 'models-store.json'))).toBe(false)
    const admin = createProviderAdmin({ agentDir })
    await expect(admin.deleteProvider('my-custom')).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// c. verifyCredential 状态码分档（stub 全局 fetch 控状态码，禁打真实网络）
// ─────────────────────────────────────────────────────────────────────────

describe('c. verifyCredential 状态码分档（T100 B1）', () => {
  /** 写 openrouter fixture（auth.json + models.json 自定义条目） */
  function writeOpenrouterSeed(key: string): void {
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'auth.json'),
      JSON.stringify({ openrouter: { type: 'api_key', key } }, null, 2)
    )
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          openrouter: {
            apiKey: '$OPENROUTER_API_KEY',
            models: [
              {
                id: 'openrouter/free',
                name: 'OpenRouter Free',
                api: 'openai-completions',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0 },
                contextWindow: 65536,
                maxTokens: 8192
              }
            ]
          }
        }
      })
    )
  }

  /** 全局 fetch 桩置换 + finally 保归还（桩外泄会污染同进程后续用例） */
  async function withFetchStub(
    stub: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
    run: () => Promise<void>
  ): Promise<void> {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (url, init) => stub(url, init)
    try {
      await run()
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  test('未配凭据 → ok=false + 中文错误「尚未为 ... 配置 API key」', async () => {
    const admin = createProviderAdmin({ agentDir })
    const result = await admin.verifyCredential('openrouter')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/尚未为 openrouter 配置 API key/)
  })

  test('非法 id → ok=false + 中文错误「provider id 非法」', async () => {
    const admin = createProviderAdmin({ agentDir })
    const result = await admin.verifyCredential('BAD_ID!')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/provider id 非法/)
  })

  test('200 → ok=true；请求带 Bearer 头 + /chat/completions 端点', async () => {
    writeOpenrouterSeed('sk-or-test')
    const admin = createProviderAdmin({ agentDir })
    // 闭包捕获实参（不用 mock.calls 回取——避免对 optional init 做强转断言）
    let seenURL = ''
    let seenAuth: string | null = null
    const fetchStub = mock((url: string | URL | Request, init?: RequestInit) => {
      seenURL = String(url)
      seenAuth = new Headers(init?.headers).get('authorization')
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('openrouter')
      expect(result.ok).toBe(true)
      expect(result.error).toBeUndefined()
    })
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(seenURL).toContain('/chat/completions')
    expect(seenAuth).toBe('Bearer sk-or-test')
  })

  test('401 → ok=false + 「凭据被拒绝（HTTP 401）」', async () => {
    writeOpenrouterSeed('sk-or-bad')
    const admin = createProviderAdmin({ agentDir })
    const fetchStub = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('openrouter')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/凭据被拒绝（HTTP 401）/)
    })
  })

  test('400 → ok=true（已过鉴权——参数问题与 key 无关）', async () => {
    writeOpenrouterSeed('sk-or-test')
    const admin = createProviderAdmin({ agentDir })
    const fetchStub = mock(() =>
      Promise.resolve(new Response('{"error":"bad request"}', { status: 400 }))
    )
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('openrouter')
      expect(result.ok).toBe(true)
    })
  })

  test('503 → ok=false + 「服务异常」不确定文案', async () => {
    writeOpenrouterSeed('sk-or-test')
    const admin = createProviderAdmin({ agentDir })
    const fetchStub = mock(() => Promise.resolve(new Response('oops', { status: 503 })))
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('openrouter')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/服务异常（HTTP 503）/)
    })
  })

  test('fetch 抛错（网络不通）→ ok=false + 「验证请求失败」', async () => {
    writeOpenrouterSeed('sk-or-test')
    const admin = createProviderAdmin({ agentDir })
    const fetchStub = mock(() => Promise.reject<Response>(new Error('fetch failed')))
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('openrouter')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/验证请求失败/)
    })
  })

  test('非 openai/anthropic 系 api 形态 → ok=false + 「暂不支持在线验证」', async () => {
    // bedrock-converse-stream 等仍无通用验真端点，走 fetch 之前的兜底分支
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'auth.json'),
      JSON.stringify({ 'test-bedrock': { type: 'api_key', key: 'test-bedrock-key' } }, null, 2)
    )
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'test-bedrock': {
            baseUrl: 'https://bedrock.example.com',
            api: 'bedrock-converse-stream',
            models: [
              {
                id: 'bedrock-test',
                name: 'Bedrock Test',
                api: 'bedrock-converse-stream',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0 },
                contextWindow: 32768,
                maxTokens: 8192
              }
            ]
          }
        }
      })
    )
    const admin = createProviderAdmin({ agentDir })
    const result = await admin.verifyCredential('test-bedrock')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/暂不支持在线验证/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// d. verifyCredential anthropic-messages 分支（T101 扩展）
// ─────────────────────────────────────────────────────────────────────────

describe('d. verifyCredential anthropic-messages 分支（T101）', () => {
  /** 写 anthropic 风格 seed（用内建 anthropic provider——SDK 已注册 auth.apiKey，
   *  auth.json 直写 { anthropic: {...} } 即可被 runtime.getAuth 读到 key） */
  function writeAnthropicSeed(key: string): void {
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key } }, null, 2)
    )
  }

  /** 全局 fetch 桩置换 + finally 保归还（桩外泄会污染同进程后续用例） */
  async function withFetchStub(
    stub: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
    run: () => Promise<void>
  ): Promise<void> {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (url, init) => stub(url, init)
    try {
      await run()
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  test('200 → ok=true；请求带 x-api-key/anthropic-version 头 + /v1/messages 端点 + max_tokens:1', async () => {
    writeAnthropicSeed('sk-ant-test')
    const admin = createProviderAdmin({ agentDir })
    let seenURL = ''
    let seenHeaders: Record<string, string> = {}
    let seenBody = ''
    const fetchStub = mock((url: string | URL | Request, init?: RequestInit) => {
      seenURL = String(url)
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries())
      seenBody = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('anthropic')
      expect(result.ok).toBe(true)
      expect(result.error).toBeUndefined()
    })
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(seenURL).toMatch(/\/v1\/messages$/)
    expect(seenHeaders['x-api-key']).toBe('sk-ant-test')
    expect(seenHeaders['anthropic-version']).toBe('2023-06-01')
    expect(seenHeaders['content-type']).toBe('application/json')
    const parsed = JSON.parse(seenBody) as {
      model: string
      max_tokens: number
      messages: Array<{ role: string; content: string }>
    }
    expect(parsed.model).toBeTruthy()
    expect(parsed.max_tokens).toBe(1)
    expect(parsed.messages).toEqual([{ role: 'user', content: 'ping' }])
  })

  test('401 → ok=false + 「凭据被拒绝（HTTP 401）」', async () => {
    writeAnthropicSeed('sk-ant-bad')
    const admin = createProviderAdmin({ agentDir })
    const fetchStub = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('anthropic')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/凭据被拒绝（HTTP 401）/)
    })
  })

  test('403 → ok=false + 「凭据被拒绝（HTTP 403）」', async () => {
    writeAnthropicSeed('sk-ant-forbidden')
    const admin = createProviderAdmin({ agentDir })
    const fetchStub = mock(() => Promise.resolve(new Response('Forbidden', { status: 403 })))
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('anthropic')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/凭据被拒绝（HTTP 403）/)
    })
  })

  test('429 → ok=true（限流但 key 真）', async () => {
    writeAnthropicSeed('sk-ant-test')
    const admin = createProviderAdmin({ agentDir })
    const fetchStub = mock(() =>
      Promise.resolve(new Response('{"error":"rate limited"}', { status: 429 }))
    )
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('anthropic')
      expect(result.ok).toBe(true)
    })
  })

  test('500 → ok=false + 「服务异常」不确定文案', async () => {
    writeAnthropicSeed('sk-ant-test')
    const admin = createProviderAdmin({ agentDir })
    const fetchStub = mock(() => Promise.resolve(new Response('oops', { status: 500 })))
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('anthropic')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/服务异常（HTTP 500）/)
    })
  })

  test('fetch 抛错（网络不通）→ ok=false + 「验证请求失败」', async () => {
    writeAnthropicSeed('sk-ant-test')
    const admin = createProviderAdmin({ agentDir })
    const fetchStub = mock(() => Promise.reject<Response>(new Error('fetch failed')))
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('anthropic')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/验证请求失败/)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// e. T100 D1 补钉：env shadow probe——stored+env 并存时把被忽略的 env 显式化
// ─────────────────────────────────────────────────────────────────────────

describe('e. getCatalog env shadow probe（T100 D1 补钉）', () => {
  /** 写 openrouter fixture（auth.json 直写 stored key；SDK checkAuth 命中即 source='stored credential'） */
  function writeOpenrouterStoredKey(key: string): void {
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'auth.json'),
      JSON.stringify({ openrouter: { type: 'api_key', key } }, null, 2)
    )
  }

  /** 临时置 env；finally 归还（不污染同进程后续用例） */
  async function withEnv(
    name: string,
    value: string | undefined,
    run: () => Promise<void>
  ): Promise<void> {
    const original = process.env[name]
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
    try {
      await run()
    } finally {
      if (original === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = original
      }
    }
  }

  test('stored + env 并存 → auth.shadowedEnvVars 透出 OPENROUTER_API_KEY', async () => {
    writeOpenrouterStoredKey('sk-or-stored')
    const admin = createProviderAdmin({ agentDir })
    await withEnv('OPENROUTER_API_KEY', 'sk-or-env', async () => {
      const catalog = await admin.getCatalog()
      const openrouter = catalog.providers.find((p) => p.id === 'openrouter')
      expect(openrouter).toBeDefined()
      // stored 赢 → source = 'stored credential'
      expect(openrouter?.auth.source).toBe('stored credential')
      // shadow probe 命中 → shadowedEnvVars 字段带出 env 名
      expect(openrouter?.auth.shadowedEnvVars).toEqual(['OPENROUTER_API_KEY'])
    })
  })

  test('仅 stored（无 env） → auth.shadowedEnvVars 字段不带', async () => {
    writeOpenrouterStoredKey('sk-or-stored')
    const admin = createProviderAdmin({ agentDir })
    await withEnv('OPENROUTER_API_KEY', undefined, async () => {
      const catalog = await admin.getCatalog()
      const openrouter = catalog.providers.find((p) => p.id === 'openrouter')
      expect(openrouter?.auth.source).toBe('stored credential')
      // probe 未命中 → 字段缺省（DTO 条件展开对齐 baseUrl/source 既有写法）
      expect(openrouter?.auth.shadowedEnvVars).toBeUndefined()
    })
  })

  test('仅 env（无 stored） → source 是 env 名本身 + shadowedEnvVars 字段不带', async () => {
    // 不写 auth.json → SDK checkAuth 走 env 分支
    const admin = createProviderAdmin({ agentDir })
    await withEnv('OPENROUTER_API_KEY', 'sk-or-env-only', async () => {
      const catalog = await admin.getCatalog()
      const openrouter = catalog.providers.find((p) => p.id === 'openrouter')
      // env 自身赢 → source = env 变量名本身
      expect(openrouter?.auth.source).toBe('OPENROUTER_API_KEY')
      // probe 仅在 stored 命中才跑；env 赢场景不跑 → 字段缺省
      expect(openrouter?.auth.shadowedEnvVars).toBeUndefined()
    })
  })
})
