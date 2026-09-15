/**
 * T97 pi-models-panel 合并面板纯逻辑门禁（讨论稿 §4 合并形态）。
 *
 * 覆盖三块抽离规则：
 * 1. resolveDefaultModelId —— openrouter 钉 free / 其他 provider 取首项 / 空目录兜底
 * 2. isCurrentAssignment —— 单指派 check 派生
 * 3. shouldAutoAssignOnSaveKey —— 保存 key 同写指派判定
 * 4. shouldAutoAssignOnModelChange —— 同 provider 内换模型自动写回
 * 5. buildAssignment —— thinkingLevel 序列化约定
 * 6. filterCatalogModels —— 模型列表搜索
 *
 * 全部纯函数测试 —— 无 Vue、无 useLocalStorage、无 fetch、无 window/document
 * （仓内 §6 测试纪律：禁 DOM 测试基建、禁读真实 env）。
 */
import { describe, expect, test } from 'bun:test'

import type { PiDesignAssignment } from '@/app/ai/pi-backend/assignment'
import type { PiCatalogModel, PiCatalogProvider } from '@/app/ai/pi-backend/catalog'
import {
  OPENROUTER_FREE_MODEL_ID,
  OPENROUTER_PROVIDER_ID,
  buildAssignment,
  classifyAuthSource,
  classifyVerifyResult,
  filterCatalogModels,
  filterCatalogProviders,
  groupProvidersByConfigured,
  isCurrentAssignment,
  isCustomProvider,
  resolveDefaultModelId,
  resolveInitialSelectedProvider,
  shouldAutoAssignOnModelChange,
  shouldAutoAssignOnSaveKey
} from '@/app/ai/pi-backend/models-panel-rules'

function makeModel(id: string, name = id): PiCatalogModel {
  return {
    id,
    name,
    api: 'openai-completions',
    reasoning: false,
    input: ['text'],
    contextWindow: 65536,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
}

function makeProvider(id: string, modelIds: string[]): PiCatalogProvider {
  return {
    id,
    name: id,
    auth: { configured: false },
    models: modelIds.map((mid) => makeModel(mid))
  }
}

/** T100：测试 fixture——支持自定义 configured + source（catalog auth 字段） */
function makeConfiguredProvider(
  id: string,
  modelIds: string[],
  source: 'stored' | 'environment' = 'stored'
): PiCatalogProvider {
  return {
    ...makeProvider(id, modelIds),
    auth: { configured: true, type: 'api_key', source }
  }
}

describe('resolveDefaultModelId', () => {
  test('openrouter 钉 openrouter/free（即使不是字典序首项）', () => {
    const openrouter = makeProvider(OPENROUTER_PROVIDER_ID, [
      'openrouter/anthropic/claude-3.5-sonnet', // 字典序在前
      'openrouter/free', // 必须选这个
      'openrouter/openai/gpt-4o'
    ])
    expect(resolveDefaultModelId(openrouter)).toBe(OPENROUTER_FREE_MODEL_ID)
  })

  test('openrouter 目录里 free 缺失（主人手编删了）回退首项兜底', () => {
    const openrouter = makeProvider(OPENROUTER_PROVIDER_ID, [
      'openrouter/anthropic/claude-3.5-sonnet',
      'openrouter/openai/gpt-4o'
    ])
    // 不抛、给首项
    expect(resolveDefaultModelId(openrouter)).toBe('openrouter/anthropic/claude-3.5-sonnet')
  })

  test('其他 provider 取 models 数组首项', () => {
    const anthropic = makeProvider('anthropic', ['claude-3.5-sonnet', 'claude-3-opus'])
    expect(resolveDefaultModelId(anthropic)).toBe('claude-3.5-sonnet')
  })

  test('其他 provider models 为空 → 空串（无初值，user 必选）', () => {
    const empty = makeProvider('anthropic', [])
    expect(resolveDefaultModelId(empty)).toBe('')
  })

  test('provider 为 null/undefined → 空串', () => {
    expect(resolveDefaultModelId(null)).toBe('')
    expect(resolveDefaultModelId(undefined)).toBe('')
  })
})

describe('isCurrentAssignment', () => {
  const assignment: PiDesignAssignment = {
    providerId: 'openrouter',
    modelId: 'openrouter/free'
  }

  test('assignment 存在且 provider 匹配 → true', () => {
    expect(isCurrentAssignment('openrouter', assignment)).toBe(true)
  })

  test('assignment 存在但 provider 不匹配 → false', () => {
    expect(isCurrentAssignment('anthropic', assignment)).toBe(false)
  })

  test('assignment 为 null → false', () => {
    expect(isCurrentAssignment('openrouter', null)).toBe(false)
  })

  test('assignment 为 undefined → false', () => {
    expect(isCurrentAssignment('openrouter', undefined)).toBe(false)
  })
})

describe('shouldAutoAssignOnSaveKey', () => {
  test('无现存指派 → true（存 key 即指派）', () => {
    expect(
      shouldAutoAssignOnSaveKey({ existingAssignment: null, targetProviderId: 'openrouter' })
    ).toBe(true)
    expect(
      shouldAutoAssignOnSaveKey({ existingAssignment: undefined, targetProviderId: 'openrouter' })
    ).toBe(true)
  })

  test('已有指派且目标 provider 非当前指派 provider → false（不抢当前指派）', () => {
    const existing: PiDesignAssignment = { providerId: 'openrouter', modelId: 'openrouter/free' }
    expect(
      shouldAutoAssignOnSaveKey({ existingAssignment: existing, targetProviderId: 'anthropic' })
    ).toBe(false)
  })

  test('已有指派且目标 provider 就是当前指派 provider → false（同 provider 内换模型走自动写回）', () => {
    const existing: PiDesignAssignment = { providerId: 'openrouter', modelId: 'openrouter/free' }
    expect(
      shouldAutoAssignOnSaveKey({ existingAssignment: existing, targetProviderId: 'openrouter' })
    ).toBe(false)
  })
})

describe('shouldAutoAssignOnModelChange', () => {
  test('无现存指派 → false（无指派语境不存在"换模型"）', () => {
    expect(
      shouldAutoAssignOnModelChange({
        existingAssignment: null,
        targetProviderId: 'openrouter',
        targetModelId: 'openrouter/free'
      })
    ).toBe(false)
  })

  test('跨 provider 切模型 → false（应走"设为当前"显式动作）', () => {
    const existing: PiDesignAssignment = { providerId: 'openrouter', modelId: 'openrouter/free' }
    expect(
      shouldAutoAssignOnModelChange({
        existingAssignment: existing,
        targetProviderId: 'anthropic',
        targetModelId: 'claude-3.5-sonnet'
      })
    ).toBe(false)
  })

  test('同 provider 同模型 → false（无变化，不写回）', () => {
    const existing: PiDesignAssignment = { providerId: 'openrouter', modelId: 'openrouter/free' }
    expect(
      shouldAutoAssignOnModelChange({
        existingAssignment: existing,
        targetProviderId: 'openrouter',
        targetModelId: 'openrouter/free'
      })
    ).toBe(false)
  })

  test('同 provider 换模型 → true（自动写回 + label 即时更新）', () => {
    const existing: PiDesignAssignment = { providerId: 'openrouter', modelId: 'openrouter/free' }
    expect(
      shouldAutoAssignOnModelChange({
        existingAssignment: existing,
        targetProviderId: 'openrouter',
        targetModelId: 'openrouter/anthropic/claude-3.5-sonnet'
      })
    ).toBe(true)
  })
})

describe('buildAssignment', () => {
  test('providerId + modelId 齐 → 返回指派', () => {
    expect(buildAssignment({ providerId: 'openrouter', modelId: 'openrouter/free' })).toEqual({
      providerId: 'openrouter',
      modelId: 'openrouter/free'
    })
  })

  test('thinkingLevel=off → 不写字段（序列化约定）', () => {
    expect(
      buildAssignment({
        providerId: 'openrouter',
        modelId: 'openrouter/free',
        thinkingLevel: 'off'
      })
    ).toEqual({ providerId: 'openrouter', modelId: 'openrouter/free' })
  })

  test('thinkingLevel=high → 写入字段', () => {
    expect(
      buildAssignment({
        providerId: 'openrouter',
        modelId: 'openrouter/free',
        thinkingLevel: 'high'
      })
    ).toEqual({
      providerId: 'openrouter',
      modelId: 'openrouter/free',
      thinkingLevel: 'high'
    })
  })

  test('缺 providerId 或 modelId → null', () => {
    expect(buildAssignment({ providerId: '', modelId: 'openrouter/free' })).toBeNull()
    expect(buildAssignment({ providerId: 'openrouter', modelId: '' })).toBeNull()
  })
})

describe('filterCatalogModels', () => {
  const models = [
    makeModel('claude-3.5-sonnet', 'Claude 3.5 Sonnet'),
    makeModel('claude-3-opus', 'Claude 3 Opus'),
    makeModel('gpt-4o', 'GPT-4o')
  ]

  test('空 query → 原样返回', () => {
    expect(filterCatalogModels(models, '')).toEqual(models)
    expect(filterCatalogModels(models, '   ')).toEqual(models)
  })

  test('name 子串大小写无关匹配', () => {
    expect(filterCatalogModels(models, 'CLAUDE')).toHaveLength(2)
    expect(filterCatalogModels(models, 'claude')).toHaveLength(2)
  })

  test('id 子串大小写无关匹配', () => {
    expect(filterCatalogModels(models, 'gpt')).toHaveLength(1)
    expect(filterCatalogModels(models, 'GPT')).toHaveLength(1)
  })

  test('不匹配 → 空数组', () => {
    expect(filterCatalogModels(models, 'gemini')).toEqual([])
  })
})

// T100：A 组——provider 列表搜索 + 已配置置顶分组
describe('filterCatalogProviders', () => {
  const providers = [
    { ...makeProvider('anthropic', ['claude-3.5-sonnet']), name: 'Anthropic' },
    { ...makeProvider('openai', ['gpt-4o']), name: 'OpenAI' },
    { ...makeProvider('google', ['gemini-pro']), name: 'Google' }
  ]

  test('空 query → 原样返回（顺序保持）', () => {
    expect(filterCatalogProviders(providers, '')).toEqual(providers)
    expect(filterCatalogProviders(providers, '   ')).toEqual(providers)
  })

  test('name 子串大小写无关匹配', () => {
    expect(filterCatalogProviders(providers, 'ANTHRO')).toHaveLength(1)
    expect(filterCatalogProviders(providers, 'open')).toHaveLength(1)
  })

  test('id 子串大小写无关匹配', () => {
    expect(filterCatalogProviders(providers, 'go')).toHaveLength(1)
  })

  test('不匹配 → 空数组', () => {
    expect(filterCatalogProviders(providers, 'missing')).toEqual([])
  })
})

describe('groupProvidersByConfigured', () => {
  test('空数组 → 空分组', () => {
    expect(groupProvidersByConfigured([])).toEqual([])
  })

  test('全已配置 → 单组（"configured"）', () => {
    const providers = [
      makeConfiguredProvider('anthropic', ['claude']),
      makeConfiguredProvider('openai', ['gpt-4o'], 'environment')
    ]
    const groups = groupProvidersByConfigured(providers)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.id).toBe('configured')
    expect(groups[0]?.providers).toHaveLength(2)
  })

  test('全未配置 → 单组（"all"）', () => {
    const providers = [makeProvider('anthropic', ['claude']), makeProvider('openai', ['gpt-4o'])]
    const groups = groupProvidersByConfigured(providers)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.id).toBe('all')
    expect(groups[0]?.providers).toHaveLength(2)
  })

  test('混合 → configured 在前 + all 在后；组内维持原顺序', () => {
    const a = makeProvider('anthropic', [])
    const b = makeConfiguredProvider('openai', ['gpt-4o'])
    const c = makeProvider('openrouter', ['openrouter/free'])
    const d = makeConfiguredProvider('custom-1', ['m1'])
    const groups = groupProvidersByConfigured([a, b, c, d])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.id).toBe('configured')
    expect(groups[0]?.providers.map((p) => p.id)).toEqual(['openai', 'custom-1'])
    expect(groups[1]?.id).toBe('all')
    expect(groups[1]?.providers.map((p) => p.id)).toEqual(['anthropic', 'openrouter'])
  })

  test('空组不出现（configured 仅 1 时只返 1 组）', () => {
    const groups = groupProvidersByConfigured([
      makeConfiguredProvider('openai', ['gpt-4o']),
      makeProvider('anthropic', [])
    ])
    // 只有 1 个 configured，1 个 all——两组
    expect(groups.map((g) => g.id)).toEqual(['configured', 'all'])
  })
})

// T100：B1——验证结果分类
describe('classifyVerifyResult', () => {
  test('result=null → unknown-error', () => {
    expect(classifyVerifyResult(null)).toBe('unknown-error')
  })

  test('ok=true → ok', () => {
    expect(classifyVerifyResult({ ok: true })).toBe('ok')
  })

  test('ok=false + 非空 error → failed（用后端返回的中文 error 文案）', () => {
    expect(classifyVerifyResult({ ok: false, error: '密钥无效' })).toBe('failed')
  })

  test('ok=false + 空 error → unknown-error（不显示空信息）', () => {
    expect(classifyVerifyResult({ ok: false })).toBe('unknown-error')
    expect(classifyVerifyResult({ ok: false, error: '' })).toBe('unknown-error')
  })
})

// T100：C1——自定义 provider 判定（看 catalog.kind；后端双层防误删仍由 DELETE 路由兜底）
describe('isCustomProvider', () => {
  test('kind=custom → true（显示删除入口）', () => {
    expect(isCustomProvider({ kind: 'custom' })).toBe(true)
  })

  test('kind=builtin → false（隐藏删除入口）', () => {
    expect(isCustomProvider({ kind: 'builtin' })).toBe(false)
  })

  test('kind 缺失（旧 catalog 缓存）→ false（保守视为内建，不显示删除入口）', () => {
    expect(isCustomProvider({})).toBe(false)
  })
})

describe('classifyAuthSource（T100 D1 补钉：SDK 真实 source 值）', () => {
  test("'stored credential'（SDK stored key 命中字面）→ 'stored'", () => {
    expect(classifyAuthSource('stored credential')).toBe('stored')
  })

  test('环境变量名本身（env 命中时 SDK 返回变量名）→ environment', () => {
    expect(classifyAuthSource('OPENROUTER_API_KEY')).toBe('environment')
    expect(classifyAuthSource('ANTHROPIC_API_KEY')).toBe('environment')
  })

  test("'environment variable'（bedrock 形态字面）→ 'environment'", () => {
    expect(classifyAuthSource('environment variable')).toBe('environment')
  })

  test('undefined / 空串 → null（不渲染标签）', () => {
    expect(classifyAuthSource(undefined)).toBe(null)
    expect(classifyAuthSource('')).toBe(null)
  })

  test('未知形态（oauth 来源串、小写自由值）→ null（保守不渲染）', () => {
    expect(classifyAuthSource('oauth')).toBe(null)
    expect(classifyAuthSource('stored')).toBe(null)
    expect(classifyAuthSource('environment')).toBe(null)
  })
})

// ux-polish④：设计模型卡（合并面板顶部）—— 初始选中 provider 优先级
describe('resolveInitialSelectedProvider', () => {
  test('当前指派存在 → 直接返回（一致性优先）', () => {
    const providers = [makeProvider('openrouter', ['openrouter/free'])]
    expect(
      resolveInitialSelectedProvider({
        assignmentProviderId: 'openrouter',
        providers
      })
    ).toBe('openrouter')
  })

  test('无指派 + 存在已配置 provider → 返回首个已配置', () => {
    const providers = [
      makeProvider('anthropic', ['claude']),
      makeConfiguredProvider('openrouter', ['openrouter/free']),
      makeConfiguredProvider('openai', ['gpt-4o'])
    ]
    expect(
      resolveInitialSelectedProvider({
        assignmentProviderId: null,
        providers
      })
    ).toBe('openrouter')
  })

  test('无指派 + 无已配置 → 返回 catalog 首项（引导位）', () => {
    const providers = [makeProvider('anthropic', ['claude']), makeProvider('openai', ['gpt-4o'])]
    expect(
      resolveInitialSelectedProvider({
        assignmentProviderId: undefined,
        providers
      })
    ).toBe('anthropic')
  })

  test('catalog 为空 → 空串（UI 安全兜底）', () => {
    expect(
      resolveInitialSelectedProvider({
        assignmentProviderId: null,
        providers: []
      })
    ).toBe('')
  })
})
