/**
 * T100 pi-backend 模型解析收紧 + 两个新端点（单测）：
 *  - resolveModel spec 必填 + 不在目录报错保留（a）
 *  - DELETE /api/pi/providers/{id} 三态（b）：自定义可删 / 内建拒绝 /
 *    凭据同清（models.json + auth.json + models-store.json）
 *  - POST /api/pi/credentials/verify 状态码分档（c）：未配凭据 ok=false /
 *    401 ok=false / 200/400 ok=true / 5xx 与网络异常不确定 / 非 openai 形态不支持
 *
 * 测试拓扑：真 createProviderAdmin（与 production 同源）+ 真 ModelRuntime
 * （seed models.json 自动写盘）；stub 全局 fetch 控验真状态码，禁打真实网络。
 * 无 vueuse/DOM 依赖，无 dev server 联动。
 *
 * 注：resolveModel 类型已收紧为 spec: ModelSpec；测无 spec 路径需 `as never`。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createProviderAdmin, type ModelSpec } from '@/app/ai/pi-backend/provider-admin'

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
    await expect(admin.resolveModel(undefined as unknown as ModelSpec)).rejects.toThrow(
      /未指派设计模型.*打开设置.*AI 选择 provider 与模型/
    )
  })

  test('有 spec 但 provider/model 不在目录 → 报「不在目录中」既有错误', async () => {
    const admin = createProviderAdmin({ agentDir })
    await expect(
      admin.resolveModel({ providerId: 'no-such-provider', modelId: 'whatever' })
    ).rejects.toThrow(/不在目录中/)
  })

  test('有效 spec（seed openrouter/free）→ 返回 model + runtime', async () => {
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

    const storeAfter = JSON.parse(
      readFileSync(join(agentDir, 'models-store.json'), 'utf8')
    ) as Record<string, unknown>
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
  /** 写 openrouter seed（auth.json + models.json） */
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
    const fetchStub = mock((url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(new Response('{}', { status: 200 }))
    )
    await withFetchStub(fetchStub, async () => {
      const result = await admin.verifyCredential('openrouter')
      expect(result.ok).toBe(true)
      expect(result.error).toBeUndefined()
    })
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0]
    expect(String(url)).toContain('/chat/completions')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test')
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

  test('非 openai 系 api 形态 → ok=false + 「暂不支持在线验证」', async () => {
    // 自定义 provider（其 models 全来自 models.json，api 覆写才生效——openrouter
    // 内建 getModels()[0] 是远程缓存目录首项，seed api 覆写浮不到第一位）；
    // 该分支在 fetch 之前返回，无需网络桩
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'auth.json'),
      JSON.stringify({ 'test-anthropic': { type: 'api_key', key: 'sk-ant-test' } }, null, 2)
    )
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'test-anthropic': {
            baseUrl: 'https://example.com/v1',
            api: 'anthropic-messages',
            models: [
              {
                id: 'claude-test',
                name: 'Claude Test',
                api: 'anthropic-messages',
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
    const result = await admin.verifyCredential('test-anthropic')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/暂不支持在线验证/)
  })
})
