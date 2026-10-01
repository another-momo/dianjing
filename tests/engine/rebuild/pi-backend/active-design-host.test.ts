/**
 * 每回合组装宿主契约测试——pi-backend 侧（state-layering wave-2 批 4 摘除半
 * + 批 5b 后形态）。
 *
 * 机制基线（2026-09-27 摘除后）：单槽 / intent 四键 / 身份差分通知族 /
 * set_active_design 已整体退役——本文件只钉活下来的面：
 *  - resolveTurnAssets：规制输入单源 = page-state 标量（general 特例 /
 *    workflow 缺失 / profile.modes 运行时过滤）
 *  - assembleTurn：段序 base→workflow→profile 固定 + 页身份行恒在 +
 *    `[你正在看第X页]` 差分行（视图页 ≠ 落点页才注）+ references 索引节
 *  - prepareTurn 端到端：probeSlot（不钉页活页读）→ page-state 读取 →
 *    probeBrief（携带冻结 page_id 按页发现落点页需求单）→ 组装；
 *    桥不可达降级；docUuid 空 = page-state 跳过
 *  - finalizeTurn：回合态清零
 *
 * 验收映射（桥 IO 全注入假件，不触真桥）。
 */

import { describe, expect, test } from 'bun:test'

import { ACTIVE_DESIGN_TEXTS } from '@open-pencil/core/tools/fork/marketing/texts'

import {
  assembleTurn,
  createActiveDesignHost,
  resolveTurnAssets,
  type ActiveDesignBridgeIO,
  type SlotProbeData
} from '@/app/ai/pi-backend/active-design-host'
import type {
  StudioAssetReference,
  StudioRegistry,
  StudioWorkflow
} from '@/app/ai/pi-backend/studio/types'

// ── fixture ──────────────────────────────────────────────────────────────────

function makeWorkflow(
  id: string,
  body: string,
  references?: StudioAssetReference[]
): StudioWorkflow {
  return {
    kind: 'workflow',
    id,
    label: id,
    ...(references ? { references } : {}),
    body,
    origin: 'builtin',
    path: `${id}.md`
  }
}

function makeRegistry(): StudioRegistry {
  return {
    base: {
      kind: 'base',
      id: 'base',
      body: 'BASE',
      origin: 'builtin',
      path: 'base.md'
    },
    workflows: new Map([
      ['general', makeWorkflow('general', 'GENERAL-WORKFLOW')],
      ['longform', makeWorkflow('longform', 'LONGFORM-WORKFLOW')]
    ]),
    profiles: new Map([
      [
        'watercolor',
        {
          kind: 'profile' as const,
          id: 'watercolor',
          label: '水彩',
          modes: ['longform'],
          deprecated: false,
          body: 'PROFILE-BODY',
          origin: 'builtin' as const,
          path: 'watercolor.md'
        }
      ]
    ]),
    modes: [{ id: 'general', label: '通用设计', source: 'general' }],
    failures: [],
    resolvedReferences: new Map()
  }
}

/**
 * page-state 标量读取器（注入式 stub）——按 docUuid 返
 * {modeId, profileId, engagedPageId}；未注入 → 返 null（与 page-state 缺失 /
 * 腐烂语义一致，host 按空规格制组装）。
 */
type PageStateReaderStub = (
  docUuid: string
) => { modeId: string | null; profileId: string | null; engagedPageId: string | null } | null
function makePageStateReader(): {
  reader: PageStateReaderStub
  set(
    docUuid: string,
    state: { modeId: string | null; profileId: string | null; engagedPageId: string | null }
  ): void
} {
  const map = new Map<
    string,
    { modeId: string | null; profileId: string | null; engagedPageId: string | null }
  >()
  const reader: PageStateReaderStub = (docUuid) => map.get(docUuid) ?? null
  return {
    reader,
    set(docUuid, state) {
      map.set(docUuid, state)
    }
  }
}

type FakeBridge = ActiveDesignBridgeIO & {
  briefCalls: string[]
  /** 视图探针返值；null = 桥不可达 */
  setProbe(probe: SlotProbeData | null): void
  /** 落点页需求单扫描返值（按 pageId 记录调用；null = 扫描失败） */
  setBriefs(pageId: string, briefIds: string[] | null): void
}

/** 假桥：内存视图探针 + 落点页需求单表 */
function makeFakeBridge(init?: { probe?: SlotProbeData }): FakeBridge {
  let probe: SlotProbeData | null = init?.probe ?? { currentPageId: 'page-1', docUuid: 'doc-fake' }
  const briefsByPage = new Map<string, string[] | null>()
  const briefCalls: string[] = []
  return {
    briefCalls,
    setProbe(next) {
      probe = next
    },
    setBriefs(pageId, briefIds) {
      briefsByPage.set(pageId, briefIds)
    },
    probeSlot: () => Promise.resolve(probe),
    probeBrief: (pageId) => {
      briefCalls.push(pageId)
      return Promise.resolve(briefsByPage.get(pageId) ?? [])
    }
  }
}

function makeHost(
  bridge: ActiveDesignBridgeIO,
  registry = makeRegistry(),
  pageStateReader: PageStateReaderStub = () => null
) {
  return createActiveDesignHost({ registry: () => registry, bridge, pageStateReader })
}

// ── resolveTurnAssets（规制解析单源 = page-state 标量）────────────────────────

describe('resolveTurnAssets（page-state 标量单源）', () => {
  test('page-state 缺失 → 空（base only）', () => {
    expect(resolveTurnAssets(makeRegistry(), null)).toEqual({})
    expect(resolveTurnAssets(makeRegistry(), { modeId: null, profileId: null })).toEqual({})
  })

  test('general：跳过 workflow 查表（base only）+ profile 按 modes 过滤', () => {
    // watercolor.modes=['longform'] 不含 general → 不注 profile
    expect(
      resolveTurnAssets(makeRegistry(), { modeId: 'general', profileId: 'watercolor' })
    ).toEqual({})
    // modes 空数组 = 所有 mode 可用 → 注 profile
    const registry = makeRegistry()
    const profile = registry.profiles.get('watercolor')
    if (profile) profile.modes = []
    expect(resolveTurnAssets(registry, { modeId: 'general', profileId: 'watercolor' })).toEqual({
      resolvedProfile: profile
    })
  })

  test('专项 mode：workflow + profile（modes 命中）解析', () => {
    const assets = resolveTurnAssets(makeRegistry(), {
      modeId: 'longform',
      profileId: 'watercolor'
    })
    expect(assets.resolvedWorkflow?.id).toBe('longform')
    expect(assets.resolvedProfile?.id).toBe('watercolor')
    expect(assets.workflowMissingModeId).toBeUndefined()
  })

  test('modeId 命中但 workflow 缺失 → workflowMissingModeId 置位 + 不注 profile', () => {
    const assets = resolveTurnAssets(makeRegistry(), {
      modeId: 'ghost-mode',
      profileId: 'watercolor'
    })
    expect(assets).toEqual({ workflowMissingModeId: 'ghost-mode' })
  })

  test('profileId 未命中注册表 → 跳过（workflow 照注）', () => {
    const assets = resolveTurnAssets(makeRegistry(), { modeId: 'longform', profileId: 'ghost' })
    expect(assets.resolvedWorkflow?.id).toBe('longform')
    expect(assets.resolvedProfile).toBeUndefined()
  })
})

// ── assembleTurn（段序 + 页身份行 + 差分行 + 索引节）─────────────────────────

describe('assembleTurn（组装契约）', () => {
  test('空规格制 = base only + 页身份行全「无」占位', () => {
    const turn = assembleTurn(
      makeRegistry(),
      {},
      {
        engagedPageId: null,
        modeId: null,
        profileId: null,
        briefId: null,
        viewPageId: null
      }
    )
    expect(turn.systemPrompt).toBe('# studio base\nBASE')
    expect(turn.contextLines).toEqual(['[施工页 page=无 模式=无/无 brief=无]'])
  })

  test('page-state 命中：段序 base → workflow → profile 固定 + 页身份行带事实', () => {
    const turn = assembleTurn(
      makeRegistry(),
      resolveTurnAssets(makeRegistry(), { modeId: 'longform', profileId: 'watercolor' }),
      {
        engagedPageId: 'page-A',
        modeId: 'longform',
        profileId: 'watercolor',
        briefId: 'b1',
        viewPageId: 'page-A'
      }
    )
    expect(turn.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    expect(turn.contextLines).toEqual(['[施工页 page=page-A 模式=longform/watercolor brief=b1]'])
  })

  test('视图页 ≠ 落点页 → 注 [你正在看第X页] 差分行（位于页身份行之后）', () => {
    const turn = assembleTurn(
      makeRegistry(),
      {},
      {
        engagedPageId: 'page-A',
        modeId: null,
        profileId: null,
        briefId: null,
        viewPageId: 'page-B'
      }
    )
    const lines = turn.contextLines
    expect(lines[0]).toBe('[施工页 page=page-A 模式=无/无 brief=无]')
    expect(lines[1]).toBe('[你正在看第page-B页]')
  })

  test('视图页 = 落点页 / 任一为空 → 不注差分行', () => {
    const pageContext = {
      modeId: null,
      profileId: null,
      briefId: null
    } as const
    const same = assembleTurn(
      makeRegistry(),
      {},
      {
        ...pageContext,
        engagedPageId: 'page-A',
        viewPageId: 'page-A'
      }
    )
    expect(same.contextLines).toHaveLength(1)
    const noView = assembleTurn(
      makeRegistry(),
      {},
      {
        ...pageContext,
        engagedPageId: 'page-A',
        viewPageId: null
      }
    )
    expect(noView.contextLines).toHaveLength(1)
    const noEngaged = assembleTurn(
      makeRegistry(),
      {},
      {
        ...pageContext,
        engagedPageId: null,
        viewPageId: 'page-B'
      }
    )
    expect(noEngaged.contextLines).toHaveLength(1)
  })

  test('workflowMissing 提示行位于页身份行之后', () => {
    const turn = assembleTurn(
      makeRegistry(),
      { workflowMissingModeId: 'ghost-mode' },
      {
        engagedPageId: 'page-A',
        modeId: 'ghost-mode',
        profileId: null,
        briefId: null,
        viewPageId: null
      }
    )
    expect(turn.systemPrompt).toBe('# studio base\nBASE')
    expect(turn.contextLines).toEqual([
      '[施工页 page=page-A 模式=ghost-mode/无 brief=无]',
      ACTIVE_DESIGN_TEXTS.workflowMissing('ghost-mode')
    ])
  })

  test('references 索引节：workflow/profile 资产并集非空时追加 + 允许集限定 key', () => {
    const registry = makeRegistry()
    registry.workflows.set(
      'longform',
      makeWorkflow('longform', 'LONGFORM-WORKFLOW', [
        { path: 'references/imagery.md', description: '图像决策纪律' }
      ])
    )
    registry.resolvedReferences = new Map([
      [
        'workflow:longform',
        new Map([['references/imagery.md', '/abs/studio/workflows/longform/references/imagery.md']])
      ]
    ])
    const turn = assembleTurn(
      registry,
      resolveTurnAssets(registry, { modeId: 'longform', profileId: '' }),
      {
        engagedPageId: null,
        modeId: null,
        profileId: null,
        briefId: null,
        viewPageId: null
      }
    )
    expect(turn.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n' +
        '## 按需参考（load_reference 工具按需读取）\n' +
        'path 参数 = 照抄下行行首 key（含桶前缀）\n' +
        '- workflow:longform/references/imagery.md —— 图像决策纪律'
    )
    expect(Object.fromEntries(turn.allowedReferences)).toEqual({
      'workflow:longform/references/imagery.md':
        '/abs/studio/workflows/longform/references/imagery.md'
    })
  })

  test('无 references → 无索引节 + 允许集为空', () => {
    const turn = assembleTurn(
      makeRegistry(),
      resolveTurnAssets(makeRegistry(), { modeId: 'longform', profileId: 'watercolor' }),
      {
        engagedPageId: null,
        modeId: null,
        profileId: null,
        briefId: null,
        viewPageId: null
      }
    )
    expect(turn.systemPrompt).not.toContain('按需参考')
    expect(turn.allowedReferences.size).toBe(0)
  })
})

// ── prepareTurn 端到端（桥假件）──────────────────────────────────────────────

describe('prepareTurn 端到端', () => {
  test('probeSlot 不可达 → 空规格制降级 + 页身份行全「无」+ promptText 原文透传', async () => {
    const bridge = makeFakeBridge()
    bridge.setProbe(null)
    const host = makeHost(bridge)
    const text = '[随便一段正文]'
    const { promptText } = await host.prepareTurn(text)
    expect(promptText).toBe(text)
    expect(host.turnAssembly()).toEqual({
      systemPrompt: '# studio base\nBASE',
      contextLines: ['[施工页 page=无 模式=无/无 brief=无]'],
      tools: [],
      allowedReferences: new Map()
    })
    host.finalizeTurn()
  })

  test('docUuid 命中 → page-state 读取 → 规制解析 + 页身份行；probeBrief 按落点页扫描', async () => {
    const pageState = makePageStateReader()
    pageState.set('doc-X', {
      modeId: 'longform',
      profileId: 'watercolor',
      engagedPageId: 'page-X'
    })
    const bridge = makeFakeBridge({ probe: { currentPageId: 'page-X', docUuid: 'doc-X' } })
    bridge.setBriefs('page-X', ['brief-1'])
    const host = makeHost(bridge, makeRegistry(), pageState.reader)
    await host.prepareTurn('做图')
    expect(bridge.briefCalls).toEqual(['page-X'])
    expect(host.turnAssembly()?.contextLines).toEqual([
      '[施工页 page=page-X 模式=longform/watercolor brief=brief-1]'
    ])
    expect(host.turnAssembly()?.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    host.finalizeTurn()
  })

  test('落点页无 brief / 多 brief 歧义 → brief=无（不静默取第一个）', async () => {
    const pageState = makePageStateReader()
    pageState.set('doc-X', { modeId: null, profileId: null, engagedPageId: 'page-X' })
    const bridge = makeFakeBridge({ probe: { currentPageId: 'page-X', docUuid: 'doc-X' } })
    bridge.setBriefs('page-X', [])
    const host = makeHost(bridge, makeRegistry(), pageState.reader)
    await host.prepareTurn('做图')
    expect(host.turnAssembly()?.contextLines).toEqual(['[施工页 page=page-X 模式=无/无 brief=无]'])
    host.finalizeTurn()

    const bridge2 = makeFakeBridge({ probe: { currentPageId: 'page-X', docUuid: 'doc-X' } })
    bridge2.setBriefs('page-X', ['brief-1', 'brief-2'])
    const host2 = makeHost(bridge2, makeRegistry(), pageState.reader)
    await host2.prepareTurn('做图')
    expect(host2.turnAssembly()?.contextLines).toEqual(['[施工页 page=page-X 模式=无/无 brief=无]'])
    host2.finalizeTurn()
  })

  test('落点未初始化（首跑）→ 不发 probeBrief，brief=无；视图页照注差分行', async () => {
    const pageState = makePageStateReader()
    pageState.set('doc-X', { modeId: null, profileId: null, engagedPageId: null })
    const bridge = makeFakeBridge({ probe: { currentPageId: 'page-V', docUuid: 'doc-X' } })
    const host = makeHost(bridge, makeRegistry(), pageState.reader)
    await host.prepareTurn('首条消息')
    expect(bridge.briefCalls).toEqual([])
    expect(host.turnAssembly()?.contextLines).toEqual(['[施工页 page=无 模式=无/无 brief=无]'])
    host.finalizeTurn()
  })

  test('视图页 ≠ 落点页 → 差分行照注（run 起始活页读是两事实之一）', async () => {
    const pageState = makePageStateReader()
    pageState.set('doc-X', { modeId: null, profileId: null, engagedPageId: 'page-X' })
    const bridge = makeFakeBridge({ probe: { currentPageId: 'page-V', docUuid: 'doc-X' } })
    bridge.setBriefs('page-X', ['brief-1'])
    const host = makeHost(bridge, makeRegistry(), pageState.reader)
    await host.prepareTurn('做图')
    expect(host.turnAssembly()?.contextLines).toEqual([
      '[施工页 page=page-X 模式=无/无 brief=brief-1]',
      '[你正在看第page-V页]'
    ])
    host.finalizeTurn()
  })

  test('probe docUuid 空（文档尚未铸造 uuid）→ page-state 跳过，全「无」占位', async () => {
    const pageState = makePageStateReader()
    pageState.set('doc-X', { modeId: 'longform', profileId: null, engagedPageId: 'page-X' })
    const bridge = makeFakeBridge({ probe: { currentPageId: 'page-V', docUuid: '' } })
    const host = makeHost(bridge, makeRegistry(), pageState.reader)
    await host.prepareTurn('做图')
    expect(host.turnAssembly()?.contextLines).toEqual(['[施工页 page=无 模式=无/无 brief=无]'])
    host.finalizeTurn()
  })

  test('finalizeTurn：turn 缓存袋清零（allowedReferences 随之复位）', async () => {
    const pageState = makePageStateReader()
    pageState.set('doc-X', { modeId: 'longform', profileId: null, engagedPageId: 'page-X' })
    const bridge = makeFakeBridge({ probe: { currentPageId: 'page-V', docUuid: 'doc-X' } })
    const host = makeHost(bridge, makeRegistry(), pageState.reader)
    await host.prepareTurn('做图')
    expect(host.turnAssembly()).not.toBeNull()
    host.finalizeTurn()
    expect(host.turnAssembly()).toBeNull()
  })
})
