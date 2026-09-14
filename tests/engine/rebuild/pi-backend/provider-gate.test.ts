/**
 * pi-model-explicit-config（§3 落地清单 1）—— 引导门态派生纯函数单测。
 *
 * 测试覆盖（按状态机短路顺序）：
 * - loading: catalog=null
 * - needs-setup: catalog 已有但无指派
 * - needs-setup: 指派 provider 不在目录（腐烂指派）
 * - needs-setup: 指派 model 不在 provider 目录（腐烂 model id）
 * - needs-credential: 指派有效但 provider.auth.configured=false
 * - ready: 全部命中
 * - 边界: 凭据 configured 但 catalog 重载中（catalog=null）→ loading 优先
 * - 边界: 空目录 / 指派 modelId 空串
 */

import { describe, expect, test } from 'bun:test'

import type { PiCatalog } from '@/app/ai/pi-backend/catalog'
import { deriveGateState } from '@/app/ai/pi-backend/provider-gate'

const OPENROUTER_FREE: PiCatalog = {
  providers: [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      auth: { configured: true, type: 'api_key', source: 'stored' },
      models: [
        {
          id: 'openrouter/free',
          name: 'OpenRouter Free',
          api: 'openai-completions',
          reasoning: false,
          input: ['text'],
          contextWindow: 8192,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
      ]
    }
  ]
}

describe('deriveGateState', () => {
  test('catalog=null → loading（即使指派已存在也优先返回 loading）', () => {
    expect(
      deriveGateState({
        assignment: { providerId: 'openrouter', modelId: 'openrouter/free' },
        catalog: null
      })
    ).toEqual({ kind: 'loading' })
  })

  test('catalog=undefined → loading', () => {
    expect(deriveGateState({ assignment: null, catalog: undefined })).toEqual({ kind: 'loading' })
  })

  test('catalog 就绪 + assignment=null → needs-setup', () => {
    expect(deriveGateState({ assignment: null, catalog: OPENROUTER_FREE })).toEqual({
      kind: 'needs-setup'
    })
  })

  test('指派 provider 不在目录 → needs-setup（腐烂指派）', () => {
    expect(
      deriveGateState({
        assignment: { providerId: 'nonexistent', modelId: 'foo' },
        catalog: OPENROUTER_FREE
      })
    ).toEqual({ kind: 'needs-setup' })
  })

  test('指派 model 不在 provider 目录 → needs-setup（腐烂 model id）', () => {
    expect(
      deriveGateState({
        assignment: { providerId: 'openrouter', modelId: 'nonexistent-model' },
        catalog: OPENROUTER_FREE
      })
    ).toEqual({ kind: 'needs-setup' })
  })

  test('指派有效但 provider.auth.configured=false → needs-credential（带 providerName）', () => {
    const catalog: PiCatalog = {
      providers: [
        {
          ...OPENROUTER_FREE.providers[0],
          auth: { configured: false, type: 'api_key' }
        }
      ]
    }
    expect(
      deriveGateState({
        assignment: { providerId: 'openrouter', modelId: 'openrouter/free' },
        catalog
      })
    ).toEqual({
      kind: 'needs-credential',
      providerId: 'openrouter',
      providerName: 'OpenRouter'
    })
  })

  test('指派有效 + provider 配置 + model 存在 → ready', () => {
    expect(
      deriveGateState({
        assignment: { providerId: 'openrouter', modelId: 'openrouter/free' },
        catalog: OPENROUTER_FREE
      })
    ).toEqual({ kind: 'ready', providerId: 'openrouter', modelId: 'openrouter/free' })
  })

  test('指派携带 thinkingLevel 字段不影响派生（ready 态透传）', () => {
    expect(
      deriveGateState({
        assignment: { providerId: 'openrouter', modelId: 'openrouter/free', thinkingLevel: 'low' },
        catalog: OPENROUTER_FREE
      })
    ).toEqual({ kind: 'ready', providerId: 'openrouter', modelId: 'openrouter/free' })
  })

  test('边界：空目录 providers=[] + 任意指派 → needs-setup', () => {
    expect(
      deriveGateState({
        assignment: { providerId: 'openrouter', modelId: 'openrouter/free' },
        catalog: { providers: [] }
      })
    ).toEqual({ kind: 'needs-setup' })
  })

  test('边界：provider.models=[] + 指派 modelId 空串 → needs-setup（先撞腐烂 model）', () => {
    const catalog: PiCatalog = {
      providers: [
        {
          ...OPENROUTER_FREE.providers[0],
          models: []
        }
      ]
    }
    expect(
      deriveGateState({
        assignment: { providerId: 'openrouter', modelId: '' },
        catalog
      })
    ).toEqual({ kind: 'needs-setup' })
  })

  test('边界：凭据 configured=true 但 catalog=null（重载期） → loading 优先', () => {
    expect(
      deriveGateState({
        assignment: { providerId: 'openrouter', modelId: 'openrouter/free' },
        catalog: null
      })
    ).toEqual({ kind: 'loading' })
  })
})
