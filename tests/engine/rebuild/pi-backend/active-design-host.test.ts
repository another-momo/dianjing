/**
 * T60（Phase 3 W3/T-B9）active_design 宿主路由契约测试——pi-backend 侧。
 * T65：信封扩展可选 canvas 组（顺序固定 modeId→profileId→canvas）+ 集成缺口
 * 修复钉扎——剥离信封时确认参数组装成一行系统提示注入本回合 contextLines
 * （缺省字段省略；裸信封无参数不注入）。
 *
 * 验收映射（T60-plan §3 宿主侧 + T65-plan §2.4/§2.5；桥 IO 全注入假件，不触真桥）：
 *  - 组装：空槽（含桥不可达降级）/ 有槽 / 落盘 mode 缺失 / profile 有无 /
 *    base→workflow→profile 顺序固定；身份封套与系统提示行进 contextLines
 *  - 信封剥离 + 一次性旗标：置真 / finalizeTurn 复位 / 不滞留 / 仅首行命中 /
 *    canvas 组解析
 *  - 确认参数系统提示行：全字段 / 部分字段省略 / 裸信封不注入 / 有槽回合
 *    位于身份封套之后
 *  - 事件④：formId 映射移槽 / 跳过不移 / 未知 formId（刷新丢失边界）不移 /
 *    节点失格不移；映射记录只认 ask_user_question awaiting 信封
 *  - 删除悬空：清槽（writeSlot('')）+ slotCleared 提示行；brief 悬空提示行
 *  - setup_design 旗标契约（验收标准 2 宿主半）：信封真 → newIntentConfirmed
 *    返真（注入缝 __confirmedNewIntent 的真源），无信封恒假
 *  - T91b：pluginData 三键二源确认——document root 三键命中 → 旗标置真，
 *    与 envelope 路径 OR。clearNewIntent hook 由 onDesignCreated 触发
 *  - P0-1（newIntent 时序缺口修复）：资产解析（resolveTurnAssets）优先级
 *    newIntent > slot；空槽 + newIntent confirmed 的 Turn 1 也拿到
 *    workflow + profile + references；newIntent 未确认/modeId 空则维持 slot 语义。
 *    守卫（newIntentConfirmed）仍手动管理——不采文档建议的派生式（见宿主内注）。
 *    探针合并：newIntent 三键随 probeSlot 同片段返回（原独立 eval 撤销）
 */

import { describe, expect, test } from 'bun:test'

import type {
  ActiveDesignSlotState,
  DesignRootSnapshot
} from '@open-pencil/core/tools/fork/marketing/active-design'
import { serializeAskAnswer } from '@open-pencil/core/tools/fork/marketing/ask-user-question'
import type { NewIntentState } from '@open-pencil/core/tools/fork/marketing/brief'
import { ACTIVE_DESIGN_TEXTS } from '@open-pencil/core/tools/fork/marketing/texts'

import {
  assembleTurn,
  createActiveDesignHost,
  designTargetEnvelope,
  resolveTurnAssets,
  stripNewIntentEnvelope,
  type ActiveDesignBridgeIO,
  type CandidateProbeData,
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
    // P1-6：general.md 落位后 fixture 同步——workflows map 含 general，
    // resolveTurnAssets 通用路径命中（与 longform 同架构，无特判）
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

function designSnap(overrides: Partial<DesignRootSnapshot> = {}): DesignRootSnapshot {
  return {
    nodeId: 'd1',
    name: '长图',
    type: 'FRAME',
    pageId: 'page-1',
    marketingRoot: true,
    modeId: 'longform',
    profileId: 'watercolor',
    briefId: 'b1',
    ...overrides
  }
}

type FakeBridge = ActiveDesignBridgeIO & {
  writes: string[]
  /** 2026-09-15：probeCandidate 调用记录（验证 answered 移槽是否发起 probe） */
  candidateCalls: string[]
  setSlot(slotNodeId: string, design: DesignRootSnapshot | null): void
  setCandidate(nodeId: string, design: DesignRootSnapshot | null): void
  /** P0-1：pluginData newIntent 三键（随槽位探针同片段返回） */
  setNewIntent(intent: NewIntentState): void
}

/** 假桥：内存槽位 + 写记录；probeCandidate 读独立候选表 */
function makeFakeBridge(): FakeBridge {
  let slot: SlotProbeData = {
    slotNodeId: '',
    currentPageId: 'page-1',
    design: null,
    brief: null,
    newIntent: { modeId: '', profileId: '', confirmed: false, canvas: '' }
  }
  const candidateById = new Map<string, DesignRootSnapshot | null>()
  const writes: string[] = []
  const candidateCalls: string[] = []
  return {
    writes,
    candidateCalls,
    setSlot(slotNodeId, design) {
      slot = { ...slot, slotNodeId, design }
      if (design) candidateById.set(design.nodeId, design)
    },
    setCandidate(nodeId, design) {
      candidateById.set(nodeId, design)
    },
    setNewIntent(intent) {
      slot = { ...slot, newIntent: intent }
    },
    probeSlot: () => Promise.resolve(slot),
    probeCandidate: (nodeId) => {
      candidateCalls.push(nodeId)
      const design = candidateById.get(nodeId) ?? null
      const data: CandidateProbeData = {
        currentPageId: slot.currentPageId,
        design,
        brief: null
      }
      return Promise.resolve(data)
    },
    writeSlot: (nodeId) => {
      writes.push(nodeId)
      slot = { ...slot, slotNodeId: nodeId }
      return Promise.resolve(true)
    },
    // T91b：newIntent 清键 stub（探针侧已并入 probeSlot 的 newIntent 字段）
    // A3 波4：补全为真清内存 newIntent 四键——onDesignCreated 后下回合 probe 读到空态
    clearNewIntent: () => {
      slot = { ...slot, newIntent: { modeId: '', profileId: '', confirmed: false, canvas: '' } }
      return Promise.resolve(true)
    }
  }
}

function makeHost(bridge: ActiveDesignBridgeIO, registry = makeRegistry()) {
  return createActiveDesignHost({ registry: () => registry, bridge })
}

/**
 * P0-1：装配链路完整口径 = resolveTurnAssets（probe 阶段的 registry 查找 +
 * newIntent 优先级）→ assembleTurn（拼接）。测试统一走这条组合，与 prepareTurn
 * 内部顺序一致。
 */
function assemble(
  registry: StudioRegistry,
  slot: ActiveDesignSlotState,
  opts: { newIntent?: NewIntentState; notices?: string[] } = {}
) {
  const resolved = resolveTurnAssets(registry, slot, opts.newIntent ?? null)
  return assembleTurn(registry, resolved, opts.notices ?? [])
}

/** newIntent 四键构造糖（confirmed 默认 true；canvas 默认空） */
function intent(modeId: string, profileId = '', confirmed = true): NewIntentState {
  return { modeId, profileId, confirmed, canvas: '' }
}

// ── 信封剥离 ─────────────────────────────────────────────────────────────────

describe('新建意图信封剥离', () => {
  test('完整信封（modeId+profileId）→ 剥离 + 双字段', () => {
    const { envelope, stripped } = stripNewIntentEnvelope(
      '[新建意图确认 modeId=longform profileId=watercolor]\n帮我做一张图'
    )
    expect(envelope).toEqual({ modeId: 'longform', profileId: 'watercolor' })
    expect(stripped).toBe('帮我做一张图')
  })

  test('字段可缺省：裸标记 / 仅 modeId', () => {
    expect(stripNewIntentEnvelope('[新建意图确认]\nhi').envelope).toEqual({})
    expect(stripNewIntentEnvelope('[新建意图确认 modeId=general]\nhi').envelope).toEqual({
      modeId: 'general'
    })
  })

  test('T65 canvas 组：三字段全带 / 跳过 profileId / 仅 canvas', () => {
    expect(
      stripNewIntentEnvelope(
        '[新建意图确认 modeId=longform profileId=watercolor canvas=750x2000]\nhi'
      ).envelope
    ).toEqual({ modeId: 'longform', profileId: 'watercolor', canvas: '750x2000' })
    // 中间字段缺省、canvas 仍在（捕获组按序可选）
    expect(
      stripNewIntentEnvelope('[新建意图确认 modeId=longform canvas=1080x]\nhi').envelope
    ).toEqual({ modeId: 'longform', canvas: '1080x' })
    expect(stripNewIntentEnvelope('[新建意图确认 canvas=1080x]\nhi').envelope).toEqual({
      canvas: '1080x'
    })
  })

  test('仅首行命中：非首行/畸形不剥离', () => {
    const notFirst = stripNewIntentEnvelope('你好\n[新建意图确认 modeId=x]')
    expect(notFirst.envelope).toBeNull()
    expect(notFirst.stripped).toBe('你好\n[新建意图确认 modeId=x]')
    expect(stripNewIntentEnvelope('[新建意图确认 modeId=x\nhi').envelope).toBeNull()
    // canvas 值含空白 → 畸形不剥离（值域 [^\]\s]+）
    expect(stripNewIntentEnvelope('[新建意图确认 canvas=1080 x]\nhi').envelope).toBeNull()
  })

  test('信封即整条消息 → stripped 空串；CRLF 容忍', () => {
    expect(stripNewIntentEnvelope('[新建意图确认 modeId=x]').stripped).toBe('')
    expect(stripNewIntentEnvelope('[新建意图确认 modeId=x canvas=750x]\r\nhi').stripped).toBe('hi')
  })
})

// ── 一次性旗标（验收标准 2 宿主半）────────────────────────────────────────────

describe('新建意图一次性旗标', () => {
  test('信封回合 newIntentConfirmed 返真；finalizeTurn 复位；次回合不滞留', async () => {
    const host = makeHost(makeFakeBridge())
    await host.prepareTurn('[新建意图确认 modeId=longform]\n做图')
    expect(host.newIntentConfirmed()).toBe(true)
    host.finalizeTurn()
    expect(host.newIntentConfirmed()).toBe(false)

    await host.prepareTurn('普通消息')
    expect(host.newIntentConfirmed()).toBe(false)
    host.finalizeTurn()
  })

  test('无信封恒假（setup_design 契约：旗标假时 core 恒拒绝 unconfirmed_new_intent）', async () => {
    const host = makeHost(makeFakeBridge())
    await host.prepareTurn('做一张长图')
    expect(host.newIntentConfirmed()).toBe(false)
    host.finalizeTurn()
  })
})

// ── 确认参数系统提示行注入（T65 集成缺口修复：确认参数对 AI 可见）──────────────────

describe('确认参数系统提示行注入', () => {
  test('空槽 + 全字段信封 → contextLines 恰为确认参数行（格式逐字钉扎）', async () => {
    const host = makeHost(makeFakeBridge())
    await host.prepareTurn(
      '[新建意图确认 modeId=longform profileId=watercolor canvas=750x2000]\n做图'
    )
    expect(host.newIntentConfirmed()).toBe(true)
    expect(host.turnAssembly()?.contextLines).toEqual([
      '用户已为本次新建确认参数：modeId=longform profileId=watercolor 尺寸=750x2000（选择即锁定，不得覆盖）'
    ])
    host.finalizeTurn()
  })

  test('缺省字段省略：仅 modeId / 仅 canvas', async () => {
    const host = makeHost(makeFakeBridge())
    await host.prepareTurn('[新建意图确认 modeId=longform]\n做图')
    expect(host.turnAssembly()?.contextLines).toEqual([
      '用户已为本次新建确认参数：modeId=longform（选择即锁定，不得覆盖）'
    ])
    host.finalizeTurn()

    // A3 B3：上回合 effective=longform，本回合 envelope 仅 canvas（无 modeId）→
    // effective 回落 ''，触发身份差分通知；本回合 envelope 在场 → 触发源「用户确认新建」
    await host.prepareTurn('[新建意图确认 canvas=1080x]\n做图')
    expect(host.turnAssembly()?.contextLines).toEqual([
      '用户已为本次新建确认参数：尺寸=1080x（选择即锁定，不得覆盖）',
      '[系统] 设计模式已切换：longform → 通用（触发源：用户确认新建）；画布内容不受影响。'
    ])
    host.finalizeTurn()
  })

  test('裸信封（无参数）→ 旗标置真但不注入提示行；无信封无注入', async () => {
    const host = makeHost(makeFakeBridge())
    await host.prepareTurn('[新建意图确认]\n做图')
    expect(host.newIntentConfirmed()).toBe(true)
    expect(host.turnAssembly()?.contextLines).toEqual([])
    host.finalizeTurn()

    await host.prepareTurn('普通消息')
    expect(host.turnAssembly()?.contextLines).toEqual([])
    host.finalizeTurn()
  })

  test('有槽回合：提示行位于身份封套之后；次回合不滞留', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap()) // brief 快照 null → briefMissing 提示行同回合一并注入
    const host = makeHost(bridge)
    await host.prepareTurn('[新建意图确认 modeId=general canvas=750x]\n另起一张')
    const lines = host.turnAssembly()?.contextLines
    expect(lines).toEqual([
      '[当前设计目标 nodeId=d1 briefId=b1]',
      '用户已为本次新建确认参数：modeId=general 尺寸=750x（选择即锁定，不得覆盖）',
      ACTIVE_DESIGN_TEXTS.briefMissing
    ])
    host.finalizeTurn()

    // A3 B3：本回合无信封/无 probe.confirmed → effective 回落 slot 解析（longform），
    // 与上回合 effective=general 差分 → 注入身份切换通知
    await host.prepareTurn('继续')
    expect(host.turnAssembly()?.contextLines).toEqual([
      '[当前设计目标 nodeId=d1 briefId=b1]',
      '[系统] 设计模式已切换：通用（无专项流程，走基础路由） → longform（触发源：外部变更）；画布内容不受影响。',
      ACTIVE_DESIGN_TEXTS.briefMissing
    ])
    host.finalizeTurn()
  })
})

// ── 每回合组装 ───────────────────────────────────────────────────────────────

describe('每回合组装（assembleTurn）', () => {
  const registry = makeRegistry()

  test('空槽 = base only + 无封套（general + 无 profile）', () => {
    const turn = assemble(registry, { status: 'empty' })
    // A3 B7：base 段前冠 `# studio base` 来源头
    expect(turn.systemPrompt).toBe('# studio base\nBASE')
    expect(turn.contextLines).toEqual([])
  })

  test('有槽：base → workflow → profile 顺序固定 + 身份封套首行', () => {
    const slot: ActiveDesignSlotState = {
      status: 'ok',
      design: designSnap(),
      briefMissing: false
    }
    const turn = assemble(registry, slot)
    // A3 B7：非空段前冠来源头；空段不冠——fixture 资产 id 分别是 base / longform / watercolor
    expect(turn.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    expect(turn.contextLines[0]).toBe('[当前设计目标 nodeId=d1 briefId=b1]')
  })

  test('general mode：A3 B1 兼容行——跳过 workflow 查表，按 base only 组装（profile 仍按 P2-10 modes 过滤）', () => {
    const turn = assemble(registry, {
      status: 'ok',
      design: designSnap({ modeId: 'general' }),
      briefMissing: false
    })
    // A3 B1：general 跳过 workflow 查表——系统提示仅 BASE，无 GENERAL-WORKFLOW 段；
    // profile.modes=['longform'] 仍过滤，general 不在列 → 不注 profile 段
    expect(turn.systemPrompt).toBe('# studio base\nBASE')
  })

  test('profile 缺省 → 封套省略 profileId 字段且不注入 profile 段', () => {
    const turn = assemble(registry, {
      status: 'ok',
      design: designSnap({ profileId: '' }),
      briefMissing: false
    })
    // A3 B7：base + workflow 段均非空，前冠来源头
    expect(turn.systemPrompt).toBe('# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW')
    // P2-2（2026-09-07）：designTargetEnvelope 移除 modeId/profileId——agent 从
    // system prompt 内容本身知道当前 workflow/profile，不需文件名 id
    expect(turn.contextLines[0]).toBe('[当前设计目标 nodeId=d1 briefId=b1]')
  })

  test('profileId 未命中注册表 → 跳过（失败面归 manifest failures）', () => {
    const turn = assemble(registry, {
      status: 'ok',
      design: designSnap({ profileId: 'ghost' }),
      briefMissing: false
    })
    expect(turn.systemPrompt).toBe('# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW')
  })

  test('落盘 mode 的 workflow 缺失 → 一行系统提示 + 按 general 组装（封套保留）', () => {
    const turn = assemble(registry, {
      status: 'ok',
      design: designSnap({ modeId: 'ghost-mode' }),
      briefMissing: false
    })
    // A3 B7：workflow 缺失 → workflow 段为空不冠头；只剩 base 段
    expect(turn.systemPrompt).toBe('# studio base\nBASE')
    expect(turn.contextLines).toHaveLength(2)
    expect(turn.contextLines[1]).toBe(ACTIVE_DESIGN_TEXTS.workflowMissing('ghost-mode'))
  })

  test('brief 悬空 → 提示行进 contextLines', () => {
    const turn = assemble(registry, {
      status: 'ok',
      design: designSnap(),
      briefMissing: true
    })
    expect(turn.contextLines).toContain(ACTIVE_DESIGN_TEXTS.briefMissing)
  })
})

// ── P0-1：newIntent 时序缺口修复（newIntent 优先于 slot）───────────────────────

describe('P0-1 newIntent 优先级装配（resolveTurnAssets）', () => {
  test('① 空槽 + newIntent confirmed（modeId+profileId）→ workflow + profile + references 索引', () => {
    const registry = makeRegistry()
    // workflow 挂 references，验证索引节随 newIntent 解析的资产一并出现
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
    const turn = assemble(
      registry,
      { status: 'empty' },
      { newIntent: intent('longform', 'watercolor') }
    )
    // 修复前：空槽恒 'BASE'（workflow/profile/references 全丢）
    // P2-3（2026-09-07）：read_reference → load_reference
    // A3 B7：base/workflow/profile 段均非空，前冠来源头
    // 2026-09-21 owner 拍板统一限定形寻址：索引行恒带桶前缀、节首加操作指令
    expect(turn.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY\n\n' +
        '## 按需参考（load_reference 工具按需读取）\n' +
        'path 参数 = 照抄下行行首 key（含桶前缀）\n' +
        '- workflow:longform/references/imagery.md —— 图像决策纪律'
    )
    expect(Object.fromEntries(turn.allowedReferences)).toEqual({
      'workflow:longform/references/imagery.md':
        '/abs/studio/workflows/longform/references/imagery.md'
    })
    // 空槽 → 无身份封套（设计区尚未落图）
    expect(turn.contextLines).toEqual([])
  })

  test('② slot=ok（旧设计）+ newIntent confirmed（新模式）→ newIntent 胜出', () => {
    const registry = makeRegistry()
    registry.workflows.set('poster', makeWorkflow('poster', 'POSTER-WORKFLOW'))
    const turn = assemble(
      registry,
      { status: 'ok', design: designSnap(), briefMissing: false }, // 旧设计 = longform/watercolor
      { newIntent: intent('poster') }
    )
    // 新 workflow 而非旧设计的 LONGFORM-WORKFLOW；profileId 由 newIntent 给（此处空）
    // A3 B7：来源头冠段
    expect(turn.systemPrompt).toBe('# studio base\nBASE\n\n# workflow: poster\nPOSTER-WORKFLOW')
    expect(turn.systemPrompt).not.toContain('LONGFORM-WORKFLOW')
    expect(turn.systemPrompt).not.toContain('PROFILE-BODY')
    // 身份封套仍按 slot 落盘事实（目标节点没变；P2-2 移除 modeId/profileId）
    expect(turn.contextLines[0]).toBe('[当前设计目标 nodeId=d1 briefId=b1]')
  })

  test('③ newIntent 未 confirmed / modeId 空 → 维持 slot 逻辑不变', () => {
    const registry = makeRegistry()
    registry.workflows.set('poster', makeWorkflow('poster', 'POSTER-WORKFLOW'))
    const slot: ActiveDesignSlotState = {
      status: 'ok',
      design: designSnap(),
      briefMissing: false
    }
    // confirmed=false → 忽略 newIntent，走 slot（longform + watercolor）
    // A3 B7：来源头冠段
    expect(assemble(registry, slot, { newIntent: intent('poster', '', false) }).systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    // confirmed=true 但 modeId 空（裸信封路径）→ 同样忽略，走 slot
    expect(assemble(registry, slot, { newIntent: intent('') }).systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    // 空槽 + 未确认 → base only（原语义；A3 B7 来源头）
    expect(
      assemble(registry, { status: 'empty' }, { newIntent: intent('poster', '', false) })
        .systemPrompt
    ).toBe('# studio base\nBASE')
  })

  test('newIntent 的 modeId=general → A3 B1 兼容行：跳过 workflow 查表 = base only + profile 按 P2-10 过滤', () => {
    const turn = assemble(
      makeRegistry(),
      { status: 'empty' },
      { newIntent: intent('general', 'watercolor') }
    )
    // A3 B1：general 跳过 workflow 查表；profile.modes=['longform'] 不含 general → 不注 profile
    expect(turn.systemPrompt).toBe('# studio base\nBASE')
    expect(turn.contextLines).toEqual([])
  })

  test('newIntent 的 modeId 未命中 registry → workflowMissing 提示 + 不注 profile', () => {
    const turn = assemble(
      makeRegistry(),
      { status: 'empty' },
      { newIntent: intent('ghost-mode', 'watercolor') }
    )
    expect(turn.systemPrompt).toBe('# studio base\nBASE')
    expect(turn.contextLines).toEqual([ACTIVE_DESIGN_TEXTS.workflowMissing('ghost-mode')])
  })

  // P2-10（2026-09-07）：profile.modes 运行时过滤——显式填写时仅在列出的 mode 下注入
  // A3 B1：general 兼容行——profile 仍按 P2-10 modes 过滤
  test('P2-10 + A3 B1：profile.modes 显式列出 [longform] 时，slot=general + profile=watercolor → 不注 profile', () => {
    // 默认 fixture 中 watercolor 的 modes = ['longform']——slot=general 时不匹配；
    // general 跳过 workflow 查表 → BASE only
    const turn = assemble(makeRegistry(), {
      status: 'ok',
      design: designSnap({ modeId: 'general' }),
      briefMissing: false
    })
    expect(turn.systemPrompt).toBe('# studio base\nBASE') // A3 B1：无 GENERAL-WORKFLOW；modes 不匹配 → 无 PROFILE-BODY
  })

  test('P2-10 + A3 B1：profile.modes 缺省/空数组 = 所有 mode 可用（无限制）', () => {
    const registry = makeRegistry()
    // 把 watercolor 的 modes 改成空数组
    const w = registry.profiles.get('watercolor')
    if (w) w.modes = []
    const turn = assemble(registry, {
      status: 'ok',
      design: designSnap({ modeId: 'general' }),
      briefMissing: false
    })
    // A3 B1：general 跳过 workflow 查表 → BASE only + profile（modes 空数组 = 通用）
    // A3 B7：base + profile 段均非空，前冠来源头
    expect(turn.systemPrompt).toBe('# studio base\nBASE\n\n# profile: watercolor\nPROFILE-BODY')
  })

  test('prepareTurn 端到端：pluginData newIntent（空槽）→ Turn 1 拿到 workflow + profile + 守卫置真', async () => {
    const bridge = makeFakeBridge()
    bridge.setNewIntent(intent('longform', 'watercolor'))
    const host = makeHost(bridge)
    await host.prepareTurn('开始做图')
    // A3 B7：来源头冠段
    expect(host.turnAssembly()?.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    // 守卫语义不变：pluginData confirmed → setup_design 的 __confirmedNewIntent 真源
    expect(host.newIntentConfirmed()).toBe(true)
    host.finalizeTurn()
  })

  test('prepareTurn 端到端：信封 modeId（pluginData 未写）也参与资产解析', async () => {
    const host = makeHost(makeFakeBridge())
    await host.prepareTurn('[新建意图确认 modeId=longform profileId=watercolor]\n做图')
    // A3 B7：来源头冠段
    expect(host.turnAssembly()?.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    expect(host.newIntentConfirmed()).toBe(true)
    host.finalizeTurn()
  })

  test('prepareTurn 端到端：信封优先于 pluginData（信封 modeId 非空时）', async () => {
    const registry = makeRegistry()
    registry.workflows.set('poster', makeWorkflow('poster', 'POSTER-WORKFLOW'))
    const bridge = makeFakeBridge()
    bridge.setNewIntent(intent('longform', 'watercolor')) // 旧 pluginData
    const host = makeHost(bridge, registry)
    await host.prepareTurn('[新建意图确认 modeId=poster]\n换一个')
    // A3 B7：来源头冠段
    expect(host.turnAssembly()?.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: poster\nPOSTER-WORKFLOW'
    )
    host.finalizeTurn()
  })

  test('守卫语义回归：slot=ok + pluginData confirmed（替换/另起）→ newIntentConfirmed 仍真', async () => {
    // 文档建议的派生式 `slot.status !== 'ok' && resolvedWorkflow != null` 在此路径下
    // 会把守卫误关；保留手动旗标 → 此处必须为真
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    bridge.setNewIntent(intent('longform', 'watercolor'))
    const host = makeHost(bridge)
    await host.prepareTurn('再做一张')
    expect(host.newIntentConfirmed()).toBe(true)
    host.finalizeTurn()
  })
})

// ── T85：references 索引注入与每回合允许集 ────────────────────────────────────

describe('references 索引注入（T85 定谳 3/4）', () => {
  const REFS: StudioAssetReference[] = [
    { path: 'references/imagery.md', description: '图像决策纪律' },
    { path: 'references/typography.md', description: '版式排印原则' }
  ]
  /** 带 references 的注册表：workflow 两条 + 桶内绝对路径；可选 base/profile 各一条 */
  function registryWithRefs(opts: { base?: boolean; profile?: boolean } = {}): StudioRegistry {
    const r = makeRegistry()
    r.workflows.set('longform', makeWorkflow('longform', 'LONGFORM-WORKFLOW', REFS))
    r.resolvedReferences = new Map([
      [
        'workflow:longform',
        new Map([
          ['references/imagery.md', '/abs/studio/workflows/longform/references/imagery.md'],
          ['references/typography.md', '/abs/studio/workflows/longform/references/typography.md']
        ])
      ]
    ])
    if (opts.base && r.base) {
      r.base.references = [{ path: 'references/house.md', description: '团队纪律' }]
      r.resolvedReferences.set(
        'base:base',
        new Map([['references/house.md', '/abs/studio/base/references/house.md']])
      )
    }
    if (opts.profile) {
      const p = r.profiles.get('watercolor')
      if (p) p.references = [{ path: 'references/recipe.md', description: '配方细节' }]
      r.resolvedReferences.set(
        'profile:watercolor',
        new Map([['references/recipe.md', '/abs/studio/profiles/watercolor/references/recipe.md']])
      )
    }
    return r
  }

  test('有槽：索引节追加 systemPrompt 尾段（行格式逐字钉扎）+ 允许集 = 限定 key → 绝对路径', () => {
    const turn = assemble(registryWithRefs(), {
      status: 'ok',
      design: designSnap({ profileId: '' }),
      briefMissing: false
    })
    // A3 B7：来源头冠段
    // 2026-09-21：索引行恒带桶前缀、节首加操作指令、行尾无来源标注
    expect(turn.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n' +
        '## 按需参考（load_reference 工具按需读取）\n' +
        'path 参数 = 照抄下行行首 key（含桶前缀）\n' +
        '- workflow:longform/references/imagery.md —— 图像决策纪律\n' +
        '- workflow:longform/references/typography.md —— 版式排印原则'
    )
    expect(Object.fromEntries(turn.allowedReferences)).toEqual({
      'workflow:longform/references/imagery.md':
        '/abs/studio/workflows/longform/references/imagery.md',
      'workflow:longform/references/typography.md':
        '/abs/studio/workflows/longform/references/typography.md'
    })
  })

  test('无任何 references → 无索引节 + 允许集为空（systemPrompt 逐字不变）', () => {
    const turn = assemble(makeRegistry(), {
      status: 'ok',
      design: designSnap(),
      briefMissing: false
    })
    expect(turn.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    expect(turn.systemPrompt).not.toContain('按需参考')
    expect(turn.allowedReferences.size).toBe(0)
  })

  test('空槽 = base only：base 有 references 才出现索引节（base 桶特判 base 标签）', () => {
    const withBase = assemble(registryWithRefs({ base: true }), { status: 'empty' })
    // A3 B7：base 段前冠来源头
    // 2026-09-21：索引行恒带桶前缀；base 桶特判 `base`（非 `base:base`）
    expect(withBase.systemPrompt).toBe(
      '# studio base\nBASE\n\n' +
        '## 按需参考（load_reference 工具按需读取）\n' +
        'path 参数 = 照抄下行行首 key（含桶前缀）\n' +
        '- base/references/house.md —— 团队纪律'
    )
    expect(Object.fromEntries(withBase.allowedReferences)).toEqual({
      'base/references/house.md': '/abs/studio/base/references/house.md'
    })
    // base 无 references 的空槽：无节、空允许集
    const plain = assemble(makeRegistry(), { status: 'empty' })
    expect(plain.systemPrompt).toBe('# studio base\nBASE')
    expect(plain.allowedReferences.size).toBe(0)
  })

  test('profile 选中时其 references 同机制入并集（位于 workflow 行之后）', () => {
    const turn = assemble(registryWithRefs({ profile: true }), {
      status: 'ok',
      design: designSnap(),
      briefMissing: false
    })
    expect(turn.systemPrompt).toContain('- profile:watercolor/references/recipe.md —— 配方细节')
    const lines = turn.systemPrompt.split('\n')
    const idxW = lines.findIndex((l) => l.includes('workflow:longform/references/imagery.md'))
    const idxP = lines.findIndex((l) => l.includes('profile:watercolor/references/recipe.md'))
    expect(idxP).toBeGreaterThan(idxW)
    expect(turn.allowedReferences.get('profile:watercolor/references/recipe.md')).toBe(
      '/abs/studio/profiles/watercolor/references/recipe.md'
    )
  })

  test('落盘 mode 的 workflow 缺失 → workflow references 不进并集（按 general 组装）', () => {
    const turn = assemble(registryWithRefs(), {
      status: 'ok',
      design: designSnap({ modeId: 'ghost-mode', profileId: '' }),
      briefMissing: false
    })
    expect(turn.systemPrompt).toBe('# studio base\nBASE')
    expect(turn.allowedReferences.size).toBe(0)
  })

  test('prepareTurn 挂载 + finalizeTurn 复位：允许集随 turn 缓存袋清零', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap({ profileId: '' }))
    const host = makeHost(bridge, registryWithRefs())
    await host.prepareTurn('继续')
    expect(host.turnAssembly()?.allowedReferences.size).toBe(2)
    host.finalizeTurn()
    expect(host.turnAssembly()).toBeNull()
  })
})

// ── 统一限定形寻址：跨桶同名 path 各登记（无 first-wins 静默误指）─────────

describe('reference 统一限定形寻址（跨桶同名 path）', () => {
  /** base + workflow 各自声明同名 references/imagery.md + 一条独立 typography */
  function registryWithCrossBucketPath(): StudioRegistry {
    const r = makeRegistry()
    if (r.base) {
      r.base.references = [{ path: 'references/imagery.md', description: '基础图像纪律' }]
      r.resolvedReferences.set(
        'base:base',
        new Map([['references/imagery.md', '/abs/studio/base/references/imagery.md']])
      )
    }
    r.workflows.set(
      'longform',
      makeWorkflow('longform', 'LONGFORM-WORKFLOW', [
        { path: 'references/imagery.md', description: '长图图像纪律' },
        { path: 'references/typography.md', description: '版式排印原则' }
      ])
    )
    r.resolvedReferences.set(
      'workflow:longform',
      new Map([
        ['references/imagery.md', '/abs/studio/workflows/longform/references/imagery.md'],
        ['references/typography.md', '/abs/studio/workflows/longform/references/typography.md']
      ])
    )
    return r
  }

  test('跨桶同名 path：索引行各登记为限定 key + 桶前缀，行尾无来源标注；无 ⚠ 注记', () => {
    const turn = assemble(registryWithCrossBucketPath(), {
      status: 'ok',
      design: designSnap({ profileId: '' }),
      briefMissing: false
    })
    // base 桶特判 `base`（非 `base:base` 结巴形）
    expect(turn.systemPrompt).toContain('- base/references/imagery.md —— 基础图像纪律')
    expect(turn.systemPrompt).toContain('- workflow:longform/references/imagery.md —— 长图图像纪律')
    // 非同名 typography.md 同样限定形（agent 唯一寻址手段 = 照抄行首 key）
    expect(turn.systemPrompt).toContain(
      '- workflow:longform/references/typography.md —— 版式排印原则'
    )
    // 整段无来源标注 / ⚠ 注记
    expect(turn.systemPrompt).not.toContain('⚠同名冲突')
    expect(turn.systemPrompt).not.toContain('（base）')
    expect(turn.systemPrompt).not.toContain('（workflow:')
    expect(turn.systemPrompt).not.toContain('（profile:')
    // 负向：裸路径不再作为寻址 key 出现在渲染行
    expect(turn.systemPrompt).not.toMatch(/^- references\/imagery\.md ——/)
    expect(turn.systemPrompt).not.toMatch(/^- references\/typography\.md ——/)
    // 节首加操作指令行
    expect(turn.systemPrompt).toContain('path 参数 = 照抄下行行首 key（含桶前缀）')
  })

  test('跨桶同名 path：允许集只登记限定 key（裸 path 已彻底移除，无 first-wins 静默误指）', () => {
    const turn = assemble(registryWithCrossBucketPath(), {
      status: 'ok',
      design: designSnap({ profileId: '' }),
      briefMissing: false
    })
    const allowed = turn.allowedReferences
    // 跨桶同名：两个不同 key 各自可达
    expect(allowed.get('base/references/imagery.md')).toBe('/abs/studio/base/references/imagery.md')
    expect(allowed.get('workflow:longform/references/imagery.md')).toBe(
      '/abs/studio/workflows/longform/references/imagery.md'
    )
    // 非同名：仍登记限定 key（agent 只用限定形）
    expect(allowed.get('workflow:longform/references/typography.md')).toBe(
      '/abs/studio/workflows/longform/references/typography.md'
    )
    // 负向：裸 path / 旧 base:base 结巴形不再在允许集中
    expect(allowed.has('references/imagery.md')).toBe(false)
    expect(allowed.has('references/typography.md')).toBe(false)
    expect(allowed.has('base:base/references/imagery.md')).toBe(false)
  })

  test('同 bucket 内多次声明同名 path：渲染两条（资产作者面可见）；允许集 Map 天然去重一条', () => {
    const r = makeRegistry()
    r.workflows.set(
      'longform',
      makeWorkflow('longform', 'LONGFORM-WORKFLOW', [
        { path: 'references/imagery.md', description: 'first' },
        { path: 'references/imagery.md', description: 'second' }
      ])
    )
    r.resolvedReferences.set(
      'workflow:longform',
      new Map([['references/imagery.md', '/abs/studio/workflows/longform/references/imagery.md']])
    )
    const turn = assemble(r, {
      status: 'ok',
      design: designSnap({ profileId: '' }),
      briefMissing: false
    })
    // 限定形行格式、两条都渲染
    expect(turn.systemPrompt).toContain('- workflow:longform/references/imagery.md —— first')
    expect(turn.systemPrompt).toContain('- workflow:longform/references/imagery.md —— second')
    // 允许集 Map 同 key 去重 → 仅一条登记
    expect(turn.allowedReferences.size).toBe(1)
    expect(turn.allowedReferences.get('workflow:longform/references/imagery.md')).toBe(
      '/abs/studio/workflows/longform/references/imagery.md'
    )
  })

  test('三方跨桶同名（base + workflow + profile）：索引行各带桶前缀；允许集三方全可达', () => {
    const r = makeRegistry()
    if (r.base) {
      r.base.references = [{ path: 'references/shared.md', description: '基础共享' }]
      r.resolvedReferences.set(
        'base:base',
        new Map([['references/shared.md', '/abs/studio/base/references/shared.md']])
      )
    }
    r.workflows.set(
      'longform',
      makeWorkflow('longform', 'LONG-WF', [
        { path: 'references/shared.md', description: '工作流共享' }
      ])
    )
    r.resolvedReferences.set(
      'workflow:longform',
      new Map([['references/shared.md', '/abs/studio/workflows/longform/references/shared.md']])
    )
    const profile = r.profiles.get('watercolor')
    if (profile) {
      profile.references = [{ path: 'references/shared.md', description: '风格共享' }]
      r.resolvedReferences.set(
        'profile:watercolor',
        new Map([['references/shared.md', '/abs/studio/profiles/watercolor/references/shared.md']])
      )
    }
    const turn = assemble(r, {
      status: 'ok',
      design: designSnap(),
      briefMissing: false
    })
    expect(turn.systemPrompt).toContain('- base/references/shared.md —— 基础共享')
    expect(turn.systemPrompt).toContain('- workflow:longform/references/shared.md —— 工作流共享')
    expect(turn.systemPrompt).toContain('- profile:watercolor/references/shared.md —— 风格共享')
    // 三方限定 key 全可达、各自指向各自桶解析绝对路径
    expect(turn.allowedReferences.get('base/references/shared.md')).toBe(
      '/abs/studio/base/references/shared.md'
    )
    expect(turn.allowedReferences.get('workflow:longform/references/shared.md')).toBe(
      '/abs/studio/workflows/longform/references/shared.md'
    )
    expect(turn.allowedReferences.get('profile:watercolor/references/shared.md')).toBe(
      '/abs/studio/profiles/watercolor/references/shared.md'
    )
  })
})

// ── prepareTurn 管线（桥假件）────────────────────────────────────────────────

describe('prepareTurn 管线', () => {
  test('桥不可达（probeSlot → null）→ 空槽降级 + 信封照常剥离（T65 确认参数行 + P0-1 信封资产解析）', async () => {
    const down: ActiveDesignBridgeIO = {
      probeSlot: () => Promise.resolve(null),
      probeCandidate: () => Promise.resolve(null),
      writeSlot: () => Promise.resolve(false),
      clearNewIntent: () => Promise.resolve(false)
    }
    const host = makeHost(down)
    const { promptText } = await host.prepareTurn('[新建意图确认 modeId=longform]\n做图')
    expect(promptText).toBe('做图')
    expect(host.newIntentConfirmed()).toBe(true)
    // P0-1：桥不可达也不该把 Turn 1 退化成 base only——信封 modeId 仍驱动资产解析
    // A3 B7：来源头冠段
    expect(host.turnAssembly()).toEqual({
      systemPrompt: '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW',
      contextLines: ['用户已为本次新建确认参数：modeId=longform（选择即锁定，不得覆盖）'],
      allowedReferences: new Map()
    })
    host.finalizeTurn()
  })

  test('桥不可达 + 无信封 → base only（原降级语义不变）', async () => {
    const down: ActiveDesignBridgeIO = {
      probeSlot: () => Promise.resolve(null),
      probeCandidate: () => Promise.resolve(null),
      writeSlot: () => Promise.resolve(false),
      clearNewIntent: () => Promise.resolve(false)
    }
    const host = makeHost(down)
    await host.prepareTurn('随便聊聊')
    expect(host.newIntentConfirmed()).toBe(false)
    expect(host.turnAssembly()?.systemPrompt).toBe('# studio base\nBASE')
    host.finalizeTurn()
  })

  test('槽位悬空 → 清槽（writeSlot 空串）+ slotCleared 提示 + 按空槽组装', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('ghost-node', null) // 槽指针悬空（节点已删）
    const host = makeHost(bridge)
    await host.prepareTurn('继续')
    expect(bridge.writes).toEqual([''])
    const turn = host.turnAssembly()
    expect(turn?.systemPrompt).toBe('# studio base\nBASE')
    expect(turn?.contextLines).toEqual([ACTIVE_DESIGN_TEXTS.slotCleared])
    host.finalizeTurn()
  })

  test('有槽回合：封套 + 系统提示经 turnAssembly 供 before_agent_start 搬运', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    const host = makeHost(bridge)
    const { promptText } = await host.prepareTurn('继续填充')
    expect(promptText).toBe('继续填充')
    // A3 B7：来源头冠段
    expect(host.turnAssembly()?.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    host.finalizeTurn()
    expect(host.turnAssembly()).toBeNull()
  })
})

// ── 事件④：表单作答移槽 ──────────────────────────────────────────────────────

describe('事件④：formId 映射移槽', () => {
  const FORM_ID = 'form-test-aaaaaa'

  test('作答信封 → 移槽回发表单 run 所属设计区', async () => {
    const bridge = makeFakeBridge()
    const design = designSnap()
    bridge.setSlot(design.nodeId, design)
    const host = makeHost(bridge)
    await host.prepareTurn('第一阶段') // run 1：槽位 d1
    host.observeToolExecution('ask_user_question', false, {
      formId: FORM_ID,
      status: 'awaiting_user'
    })
    host.finalizeTurn()

    await host.prepareTurn(
      serializeAskAnswer(FORM_ID, { aborted: false, answers: { q1: { value: 'a' } } })
    )
    expect(bridge.writes).toEqual(['d1'])
    host.finalizeTurn()
  })

  test('作答消息文本不剥离（AI 须读答案）；[表单跳过] 不移槽', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    const host = makeHost(bridge)
    await host.prepareTurn('第一阶段')
    host.observeToolExecution('ask_user_question', false, {
      formId: FORM_ID,
      status: 'awaiting_user'
    })
    host.finalizeTurn()

    const answerText = serializeAskAnswer(FORM_ID, {
      aborted: false,
      answers: { q1: { value: 'a' } }
    })
    const { promptText } = await host.prepareTurn(answerText)
    expect(promptText).toBe(answerText)
    host.finalizeTurn()

    const skipText = serializeAskAnswer(FORM_ID, { aborted: true, freeText: '算了' })
    const writesBefore = bridge.writes.length
    await host.prepareTurn(skipText)
    expect(bridge.writes.length).toBe(writesBefore)
    host.finalizeTurn()
  })

  test('未知 formId（刷新丢映射边界）→ 静默不移槽', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    const host = makeHost(bridge)
    await host.prepareTurn(serializeAskAnswer('form-gone-zzzzzz', { aborted: false, answers: {} }))
    expect(bridge.writes).toEqual([])
    host.finalizeTurn()
  })

  test('节点失格（已非设计区根框）→ 不移槽', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    const host = makeHost(bridge)
    await host.prepareTurn('第一阶段')
    host.observeToolExecution('ask_user_question', false, {
      formId: FORM_ID,
      status: 'awaiting_user'
    })
    host.finalizeTurn()

    bridge.setSlot('', null)
    bridge.setCandidate('d1', designSnap({ marketingRoot: false })) // 节点仍在但已非设计区根框
    const writesBefore = bridge.writes.length
    await host.prepareTurn(serializeAskAnswer(FORM_ID, { aborted: false, answers: {} }))
    expect(bridge.writes.length).toBe(writesBefore)
    host.finalizeTurn()
  })

  test('映射登记只认 ask_user_question awaiting 信封（其他工具/错误结果忽略）', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    const host = makeHost(bridge)
    await host.prepareTurn('第一阶段')
    host.observeToolExecution('create_brief', false, { formId: FORM_ID })
    host.observeToolExecution('ask_user_question', true, {
      formId: FORM_ID,
      status: 'awaiting_user'
    })
    host.observeToolExecution('ask_user_question', false, { formId: FORM_ID, status: 'done' })
    host.finalizeTurn()

    await host.prepareTurn(serializeAskAnswer(FORM_ID, { aborted: false, answers: {} }))
    expect(bridge.writes).toEqual([])
    host.finalizeTurn()
  })
})

// ── 事件①：setup_design 成功移槽回调 ────────────────────────────────────────

describe('事件①：onDesignCreated 移槽', () => {
  test('成功 → writeSlot(新 root id)', async () => {
    const bridge = makeFakeBridge()
    const host = makeHost(bridge)
    await host.onDesignCreated('new-root')
    expect(bridge.writes).toEqual(['new-root'])
  })
})

// ── 2026-09-15：ask_user_question 硬阻断新流——recordAskForm + answered 结果点移槽

describe('新流：recordAskForm + answered 结果点移槽', () => {
  test('recordAskForm 注册 → 后续 answered 信封命中映射 → 移槽', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    const host = makeHost(bridge)
    await host.prepareTurn('第一阶段') // 槽位 d1
    host.recordAskForm('ask-call-1')
    host.finalizeTurn()

    host.observeToolExecution('ask_user_question', false, {
      formId: 'ask-call-1',
      status: 'answered',
      questions: [],
      answers: { q1: { value: 'a' } }
    })
    // observeToolExecution 是同步契约，移槽 fire-and-forget；轮询等待
    for (let i = 0; i < 20 && bridge.writes.length === 0; i++) {
      await new Promise((r) => {
        setTimeout(r, 5)
      })
    }
    expect(bridge.writes).toEqual(['d1'])
  })

  test('answered 信封 → 移槽后 delete formId 映射（重复 observe 不再触发）', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    const host = makeHost(bridge)
    await host.prepareTurn('第一阶段')
    host.recordAskForm('ask-call-1')
    host.finalizeTurn()

    host.observeToolExecution('ask_user_question', false, {
      formId: 'ask-call-1',
      status: 'answered',
      questions: [],
      answers: { q1: { value: 'a' } }
    })
    for (let i = 0; i < 20 && bridge.writes.length === 0; i++) {
      await new Promise((r) => {
        setTimeout(r, 5)
      })
    }
    const writesAfterFirst = bridge.writes.length
    // 重复 observe 不应再移槽（映射已删）
    host.observeToolExecution('ask_user_question', false, {
      formId: 'ask-call-1',
      status: 'answered',
      questions: [],
      answers: { q1: { value: 'a' } }
    })
    await new Promise((r) => {
      setTimeout(r, 20)
    })
    expect(bridge.writes.length).toBe(writesAfterFirst)
  })

  test('answered 信封 formId 未在映射 → 静默不触发（fire-and-forget probeCandidate 不发起）', async () => {
    const bridge = makeFakeBridge()
    const host = makeHost(bridge)
    await host.prepareTurn('第一阶段')
    host.finalizeTurn()

    host.observeToolExecution('ask_user_question', false, {
      formId: 'ask-unknown',
      status: 'answered',
      questions: [],
      answers: {}
    })
    await new Promise((r) => {
      setTimeout(r, 20)
    })
    // 未注册 formId → 不发起 probeCandidate → writes 不变
    expect(bridge.writes).toEqual([])
  })

  test('节点失格 → answered 信封仍走 probe 但移槽失败，映射已删（无副作用）', async () => {
    const bridge = makeFakeBridge()
    const host = makeHost(bridge)
    bridge.setSlot('d1', designSnap())
    await host.prepareTurn('第一阶段')
    host.recordAskForm('ask-call-1')
    host.finalizeTurn()

    bridge.setCandidate('d1', designSnap({ marketingRoot: false }))
    host.observeToolExecution('ask_user_question', false, {
      formId: 'ask-call-1',
      status: 'answered',
      questions: [],
      answers: { q1: { value: 'a' } }
    })
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => {
        setTimeout(r, 5)
      })
      if (bridge.candidateCalls.includes('d1')) break
    }
    expect(bridge.candidateCalls).toContain('d1') // probe 发起
    expect(bridge.writes).toEqual([]) // 节点失格 → 移槽失败
  })

  test('awaiting 信封路径仍兼容（降级场景）—— 已答信封触发移槽', async () => {
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    const host = makeHost(bridge)
    await host.prepareTurn('第一阶段')
    // 旧 awaiting 信封路径
    host.observeToolExecution('ask_user_question', false, {
      formId: 'form-old-aaaaaa',
      status: 'awaiting_user'
    })
    host.finalizeTurn()
    // 通过序列化信封触发 resolveFormAnswer 移槽（旧路径）
    await host.prepareTurn(
      serializeAskAnswer('form-old-aaaaaa', { aborted: false, answers: { q1: { value: 'a' } } })
    )
    expect(bridge.writes).toEqual(['d1'])
    host.finalizeTurn()
  })
})

// P2-2（2026-09-07）：designTargetEnvelope 移除 modeId/profileId——agent 从
// system prompt 内容本身知道当前 workflow/profile，不需文件名 id
test('designTargetEnvelope：nodeId + briefId（modeId/profileId 已剥离）', () => {
  expect(designTargetEnvelope(designSnap())).toBe('[当前设计目标 nodeId=d1 briefId=b1]')
  expect(designTargetEnvelope(designSnap({ profileId: '' }))).toBe(
    '[当前设计目标 nodeId=d1 briefId=b1]'
  )
})

// ── A3 波4：B3/B2 行为定钉（D 组）─────────────────────────────────────────────

describe('A3 波4：B3 身份差分通知', () => {
  test('B3 首回合抑制：lastIdentity===null 即便 slot 携带身份也不注 B3 通知行', async () => {
    // pluginData 侧 newIntent 持久路径（B2.③ 参数锁定行注；非 B3 通知——首回合豁免）
    const bridge = makeFakeBridge()
    bridge.setNewIntent(intent('longform', 'watercolor'))
    const host = makeHost(bridge)
    await host.prepareTurn('开始做图')
    const lines = host.turnAssembly()?.contextLines ?? []
    // 首回合豁免——无任何 B3 通知行
    expect(lines.some((l) => l.startsWith('[系统] 设计模式已切换'))).toBe(false)
    expect(lines.some((l) => l.startsWith('[系统] 设计风格已切换'))).toBe(false)
    // 但 B2 参数锁定行照注（持久路径与首回合无关）
    expect(lines).toContain(
      '用户已为本次新建确认参数：modeId=longform profileId=watercolor（选择即锁定，不得覆盖）'
    )
    host.finalizeTurn()
  })

  test('B3 profile-only 差分：mode 不变 + profile 变 → 注「设计风格已切换」且非「设计模式已切换」', async () => {
    // Turn1：slot 已有 longform+watercolor（lastIdentity 落点）
    const bridge = makeFakeBridge()
    bridge.setSlot('d1', designSnap())
    const host = makeHost(bridge)
    await host.prepareTurn('继续')
    // fake bridge probeSlot 返 brief=null → briefMissing 提示行进 contextLines（与既有测试同律）
    expect(host.turnAssembly()?.contextLines ?? []).toEqual([
      '[当前设计目标 nodeId=d1 briefId=b1]',
      '当前设计目标关联的需求单已被删除——可新建需求单绑定，或不走需求单直接聊天修改。'
    ])
    host.finalizeTurn()

    // Turn2：newIntent 切换 profileId 为空（同 mode）——profile-only diff
    bridge.setNewIntent(intent('longform', ''))
    await host.prepareTurn('改风格')
    const lines = host.turnAssembly()?.contextLines ?? []
    expect(lines).toContain(
      '[系统] 设计风格已切换：watercolor → （触发源：用户确认新建）；画布内容不受影响。'
    )
    expect(lines.some((l) => l.startsWith('[系统] 设计模式已切换'))).toBe(false)
    host.finalizeTurn()
  })
})

describe('A3 波4：B2 pluginData 持久化路径', () => {
  test('B2 次回合仍按 intent 组装（pluginData 未清）→ workflow longform 段在场 + 参数锁定行持续', async () => {
    // Turn1：pluginData 写入 newIntent（confirmed）→ 按 probeIntent 解析
    const bridge = makeFakeBridge()
    bridge.setNewIntent(intent('longform', 'watercolor'))
    const host = makeHost(bridge)
    await host.prepareTurn('开始')
    // A3 B7：来源头冠段
    expect(host.turnAssembly()?.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    expect(host.turnAssembly()?.contextLines).toContain(
      '用户已为本次新建确认参数：modeId=longform profileId=watercolor（选择即锁定，不得覆盖）'
    )
    host.finalizeTurn()

    // Turn2：不写 pluginData、不带信封——fake bridge 内存 newIntent 仍存在
    // → resolveTurnAssets 走 probeIntent（confirmed=true）→ 同套装配 + 参数锁定行再注
    await host.prepareTurn('普通跟进')
    expect(host.turnAssembly()?.systemPrompt).toBe(
      '# studio base\nBASE\n\n# workflow: longform\nLONGFORM-WORKFLOW\n\n# profile: watercolor\nPROFILE-BODY'
    )
    expect(host.turnAssembly()?.contextLines).toContain(
      '用户已为本次新建确认参数：modeId=longform profileId=watercolor（选择即锁定，不得覆盖）'
    )
    host.finalizeTurn()
  })

  test('B2 canvas 锁在场：newIntent 带 canvas → 无信封 prepareTurn 注尺寸锁定行', async () => {
    const bridge = makeFakeBridge()
    bridge.setNewIntent({ modeId: 'longform', profileId: '', confirmed: true, canvas: '750x2000' })
    const host = makeHost(bridge)
    await host.prepareTurn('普通跟进')
    expect(host.turnAssembly()?.contextLines).toContain(
      '用户已为本次新建确认参数：modeId=longform 尺寸=750x2000（选择即锁定，不得覆盖）'
    )
    host.finalizeTurn()
  })

  test('B2 落图后清除：onDesignCreated 清 pluginData → 下回合按空槽组装 + 身份有 diff 则触发源=新设计落图', async () => {
    // Turn1：pluginData 写入 longform+watercolor（lastIdentity 落点）
    const bridge = makeFakeBridge()
    bridge.setNewIntent(intent('longform', 'watercolor'))
    const host = makeHost(bridge)
    await host.prepareTurn('开始')
    expect(host.turnAssembly()?.contextLines).toContain(
      '用户已为本次新建确认参数：modeId=longform profileId=watercolor（选择即锁定，不得覆盖）'
    )
    host.finalizeTurn()

    // 落图 + 清键（fake bridge 已补 clearNewIntent 真清内存）
    await host.onDesignCreated('d-new')

    // Turn2：probe.newIntent 已空（clearNewIntent 真清）→ 按空槽组装
    await host.prepareTurn('续作')
    // 空槽 = base only（无 workflow/profile 段）
    expect(host.turnAssembly()?.systemPrompt).toBe('# studio base\nBASE')
    // 参数锁定行不再注（probeConfirmed=false）
    expect(host.turnAssembly()?.contextLines).not.toContain(
      expect.stringContaining('用户已为本次新建确认参数')
    )
    // lastIdentity={longform,watercolor} vs effective={'',''} → mode diff，触发源 newDesignCreated
    expect(host.turnAssembly()?.contextLines).toContain(
      '[系统] 设计模式已切换：longform → 通用（触发源：新设计落图）；画布内容不受影响。'
    )
    host.finalizeTurn()
  })
})
