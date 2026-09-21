/**
 * 批 2（2026-09-21 拍板①⑤⑥ + D6，意图确认卡机制与 UX 整改·UI 主线）：
 * 意图卡前端件钉扎——
 *
 *  - parseAwaitingIntentPart：setup_design output-available 信封识别（output
 *    信封 + 工具 input.canvas 提议值；他工具/非终态/形状不符/成功输出 → null）；
 *    信封 message 字段批 2 起不消费（模型向协议指令不进卡面，F1-L2）。
 *  - scanAwaitingIntentCards 全史扫描派生（D6 口径，重载后同律适用）：
 *    会话已决 > 随后同身份落图派生已确认 > 后续用户消息过期（拍板①过期规则）
 *    > 最后候选为唯一活卡（兄弟卡联动锁，AI 循环重试产的多张信封卡）。
 *  - awaitingCardView：记录 → 卡片三态视图映射（decision 仅 resolved 携带）。
 *  - lastUserMessageText：末条用户消息正文（拍板⑥自动续跑的重发源）。
 *
 * 不覆盖：卡片组件 markup（仓库 bun:test 无 DOM 基础设施——pending-decision.test.ts
 * 头注同款纪律）；resolveBriefDisplayName 读画布链路（L3 实测覆盖）。
 */

import { describe, expect, test } from 'bun:test'

import type { UIDataTypes, UIMessage, UIMessagePart, UITools } from 'ai'

import {
  awaitingCardView,
  lastUserMessageText,
  parseAwaitingIntentPart,
  scanAwaitingIntentCards,
  type AwaitingSessionDecision
} from '@/components/assistant/active-design'

type AnyPart = UIMessagePart<UIDataTypes, UITools>

/** 合成 part/消息桩：测试只消费 type/toolCallId/state/input/output 窄面，结构差由
 *  被测函数的防御性解析兜住（asPart 同款豁免先例：pending-decision.test.ts） */
function asPart(part: Record<string, unknown>): AnyPart {
  // oxlint-disable-next-line open-pencil/no-broad-double-cast -- 桩结构差由被测函数的窄消费面兜住
  return part as unknown as AnyPart
}

function asMessage(message: Record<string, unknown>): UIMessage {
  // oxlint-disable-next-line open-pencil/no-broad-double-cast -- 同上
  return message as unknown as UIMessage
}

function awaitingOutput(modeId: string, profileId = '', briefId = 'b1') {
  return {
    status: 'awaiting_new_intent_confirmation',
    proposed: { modeId, profileId, briefId },
    catalog: { modes: [{ id: modeId, label: `${modeId} 标签` }], profileIds: [] },
    message: '新建设计需要先获得用户确认——请询问用户（模型向协议指令，不进卡面）'
  }
}

function setupPart(
  toolCallId: string,
  output: unknown,
  options: { state?: string; canvas?: unknown } = {}
): AnyPart {
  const input: Record<string, unknown> = { modeId: 'm1', briefId: 'b1' }
  if (options.canvas !== undefined) input.canvas = options.canvas
  return asPart({
    type: 'tool-setup_design',
    toolCallId,
    state: options.state ?? 'output-available',
    input,
    output
  })
}

function successOutput(modeId: string, profileId?: string) {
  return {
    rootId: 'root-1',
    name: '海报',
    size: { width: 750, height: null },
    modeId,
    ...(profileId !== undefined ? { profileId } : {}),
    briefId: 'b1',
    placement: { x: 0, y: 0 },
    message: 'ok'
  }
}

function userMessage(id: string, text: string): UIMessage {
  return asMessage({ id, role: 'user', parts: [{ type: 'text', text }] })
}

function assistantMessage(id: string, parts: AnyPart[]): UIMessage {
  return asMessage({ id, role: 'assistant', parts })
}

const NO_DECISIONS: ReadonlyMap<string, AwaitingSessionDecision> = new Map()

describe('parseAwaitingIntentPart（part 级信封识别）', () => {
  test('完整信封：output 三键 + catalog 快照归一 + input.canvas 提议值', () => {
    const info = parseAwaitingIntentPart(
      setupPart('c1', awaitingOutput('longform', 'watercolor'), { canvas: '750x2000' })
    )
    expect(info).toEqual({
      toolCallId: 'c1',
      modeId: 'longform',
      profileId: 'watercolor',
      briefId: 'b1',
      canvas: '750x2000',
      catalogModes: [{ id: 'longform', label: 'longform 标签' }],
      briefName: null
    })
  })

  test('input.canvas 非法/缺省 → canvas null（卡面显示自动）', () => {
    expect(
      parseAwaitingIntentPart(setupPart('c2', awaitingOutput('m1'), { canvas: '宽750' }))?.canvas
    ).toBeNull()
    expect(parseAwaitingIntentPart(setupPart('c3', awaitingOutput('m1')))?.canvas).toBeNull()
  })

  test('catalog.modes 混杂形状 → 只留 {id,label} 全合法条目', () => {
    const output = awaitingOutput('m1')
    // oxlint-disable-next-line open-pencil/no-broad-double-cast -- 混杂形状桩由被测函数的防御性归一兜住（同 asPart 豁免）
    output.catalog.modes = [
      { id: 'a', label: 'A' },
      { id: 'b' },
      { label: 'C' },
      'junk',
      null
    ] as unknown as { id: string; label: string }[]
    expect(parseAwaitingIntentPart(setupPart('c4', output))?.catalogModes).toEqual([
      { id: 'a', label: 'A' }
    ])
  })

  test('非 setup_design 工具 / 非终态 / 形状不符 / 成功输出 → null', () => {
    expect(
      parseAwaitingIntentPart(
        asPart({ type: 'tool-bash', toolCallId: 'c5', state: 'output-available', output: {} })
      )
    ).toBeNull()
    expect(
      parseAwaitingIntentPart(setupPart('c6', awaitingOutput('m1'), { state: 'input-available' }))
    ).toBeNull()
    expect(parseAwaitingIntentPart(setupPart('c7', { status: 'other' }))).toBeNull()
    expect(parseAwaitingIntentPart(setupPart('c8', successOutput('m1'))))?.toBeNull()
  })
})

describe('scanAwaitingIntentCards（D6 全史派生）', () => {
  test('唯一信封且无后续用户消息 → pending 活卡（重载后未决复活即此形态）', () => {
    const records = scanAwaitingIntentCards(
      [
        userMessage('u1', '做张图'),
        assistantMessage('a1', [setupPart('s1', awaitingOutput('m1'))])
      ],
      NO_DECISIONS
    )
    const record = records.get('s1')
    expect(record?.state).toEqual({ kind: 'pending' })
    expect(record?.candidate).toBe(true)
  })

  test('信封后出现用户消息 → expired（拍板①：用户发新消息不答即过期）', () => {
    const records = scanAwaitingIntentCards(
      [
        userMessage('u1', '做张图'),
        assistantMessage('a1', [setupPart('s1', awaitingOutput('m1'))]),
        userMessage('u2', '换个话题')
      ],
      NO_DECISIONS
    )
    expect(records.get('s1')?.state).toEqual({ kind: 'expired' })
    expect(records.get('s1')?.candidate).toBe(false)
  })

  test('随后同身份落图 → 派生已确认（后一条消息的成功 part）', () => {
    const records = scanAwaitingIntentCards(
      [
        userMessage('u1', '做张图'),
        assistantMessage('a1', [setupPart('s1', awaitingOutput('m1'))]),
        userMessage('u2', '做张图'),
        assistantMessage('a2', [setupPart('s2', successOutput('m1'))])
      ],
      NO_DECISIONS
    )
    expect(records.get('s1')?.state).toEqual({ kind: 'resolved', decision: 'confirmed' })
  })

  test('同一条消息内后序 part 落图 → 派生已确认（AI 同回合重试成功）', () => {
    const records = scanAwaitingIntentCards(
      [
        userMessage('u1', '做张图'),
        assistantMessage('a1', [
          setupPart('s1', awaitingOutput('m1')),
          setupPart('s2', successOutput('m1'))
        ])
      ],
      NO_DECISIONS
    )
    expect(records.get('s1')?.state).toEqual({ kind: 'resolved', decision: 'confirmed' })
  })

  test('落图身份不符（modeId/profileId 不同）→ 不派生', () => {
    const base = [
      userMessage('u1', '做张图'),
      assistantMessage('a1', [setupPart('s1', awaitingOutput('m1', 'p1'))]),
      assistantMessage('a2', [setupPart('s2', successOutput('m2', 'p1'))])
    ]
    expect(scanAwaitingIntentCards(base, NO_DECISIONS).get('s1')?.state).toEqual({
      kind: 'pending'
    })
    const profileMismatch = [
      userMessage('u1', '做张图'),
      assistantMessage('a1', [setupPart('s1', awaitingOutput('m1', 'p1'))]),
      assistantMessage('a2', [setupPart('s2', successOutput('m1', 'p2'))])
    ]
    expect(scanAwaitingIntentCards(profileMismatch, NO_DECISIONS).get('s1')?.state).toEqual({
      kind: 'pending'
    })
  })

  test('兄弟卡联动锁：同消息两信封 → 最后候选为唯一活卡，先产卡 expired', () => {
    const records = scanAwaitingIntentCards(
      [
        userMessage('u1', '做张图'),
        assistantMessage('a1', [
          setupPart('s1', awaitingOutput('m1')),
          setupPart('s2', awaitingOutput('m1'))
        ])
      ],
      NO_DECISIONS
    )
    expect(records.get('s1')?.candidate).toBe(true)
    expect(records.get('s1')?.state).toEqual({ kind: 'expired' })
    expect(records.get('s2')?.candidate).toBe(true)
    expect(records.get('s2')?.state).toEqual({ kind: 'pending' })
  })

  test('会话已决优先：confirmed/cancelled → resolved；superseded → expired', () => {
    const decisions: ReadonlyMap<string, AwaitingSessionDecision> = new Map([
      ['s1', 'confirmed'],
      ['s2', 'cancelled'],
      ['s3', 'superseded']
    ])
    const records = scanAwaitingIntentCards(
      [
        userMessage('u1', '做张图'),
        assistantMessage('a1', [
          setupPart('s1', awaitingOutput('m1')),
          setupPart('s2', awaitingOutput('m1')),
          setupPart('s3', awaitingOutput('m1'))
        ])
      ],
      decisions
    )
    expect(records.get('s1')?.state).toEqual({ kind: 'resolved', decision: 'confirmed' })
    expect(records.get('s2')?.state).toEqual({ kind: 'resolved', decision: 'cancelled' })
    expect(records.get('s3')?.state).toEqual({ kind: 'expired' })
  })

  test('会话 confirmed 优先于后续用户消息过期（确认 + 自动重发的历史形态）', () => {
    const records = scanAwaitingIntentCards(
      [
        userMessage('u1', '做张图'),
        assistantMessage('a1', [setupPart('s1', awaitingOutput('m1'))]),
        userMessage('u2', '做张图')
      ],
      new Map([['s1', 'confirmed']])
    )
    expect(records.get('s1')?.state).toEqual({ kind: 'resolved', decision: 'confirmed' })
  })

  test('briefName 解析器注入：命中落 info.briefName；briefId 空串不调解析器', () => {
    const records = scanAwaitingIntentCards(
      [
        userMessage('u1', '做张图'),
        assistantMessage('a1', [
          setupPart('s1', awaitingOutput('m1', '', 'b1')),
          setupPart('s2', awaitingOutput('m1', '', ''))
        ])
      ],
      NO_DECISIONS,
      (briefId) => (briefId === 'b1' ? '双十一需求单' : null)
    )
    expect(records.get('s1')?.info.briefName).toBe('双十一需求单')
    expect(records.get('s2')?.info.briefName).toBeNull()
  })

  test('空消息列表 → 空集', () => {
    expect(scanAwaitingIntentCards([], NO_DECISIONS).size).toBe(0)
  })
})

describe('awaitingCardView（记录 → 卡片三态视图）', () => {
  const info = {
    toolCallId: 's1',
    modeId: 'm1',
    profileId: 'p1',
    briefId: 'b1',
    canvas: null,
    catalogModes: [],
    briefName: null
  }

  test('pending / expired 不带 decision；resolved 携带决断', () => {
    expect(awaitingCardView({ info, candidate: true, state: { kind: 'pending' } })).toEqual({
      mode: 'pending',
      modeId: 'm1',
      profileId: 'p1',
      briefId: 'b1',
      briefName: null,
      canvas: null,
      catalogModes: []
    })
    expect(awaitingCardView({ info, candidate: false, state: { kind: 'expired' } }).mode).toBe(
      'expired'
    )
    const resolved = awaitingCardView({
      info,
      candidate: false,
      state: { kind: 'resolved', decision: 'cancelled' }
    })
    expect(resolved.mode).toBe('resolved')
    expect(resolved.decision).toBe('cancelled')
  })
})

describe('lastUserMessageText（拍板⑥自动续跑重发源）', () => {
  test('取末条用户消息正文（多 text part 拼接）', () => {
    const text = lastUserMessageText([
      userMessage('u1', '第一条'),
      asMessage({ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '回复' }] }),
      asMessage({
        id: 'u2',
        role: 'user',
        parts: [
          { type: 'text', text: '做张' },
          { type: 'text', text: '长图' }
        ]
      })
    ])
    expect(text).toBe('做张长图')
  })

  test('空白用户消息跳过取上一条；无用户消息 → null', () => {
    expect(lastUserMessageText([userMessage('u1', '  '), assistantMessage('a1', [])])).toBeNull()
    expect(lastUserMessageText([assistantMessage('a1', [])])).toBeNull()
  })
})
