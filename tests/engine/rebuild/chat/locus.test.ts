/**
 * 2026-09-27 sl-w2-locus-gate：落点拦截门纯逻辑层单测。
 *
 * 覆盖矩阵（§3.1 全部变体）：
 *  - docUuid 缺失 → first-send-no-doc（不读 GET，捕获 currentPageId）
 *  - 真首跑（state 缺省 + hasSession=false）→ silent-init
 *  - 腐烂再初始化（state 缺省 + hasSession=true）→ gate-resolve orphan（无上一屏）
 *  - 视图页 == 落点页 → same-page（零动作）
 *  - 视图页 ≠ 落点页（页仍存在）→ gate-resolve switch
 *  - 悬空（engaged 在页列表查无）→ gate-resolve orphan（含 reason 区分）
 *  - 空字符串 engaged 等价 null（防御性归一）
 *
 * 防御性解析（parseLocusGetResponse）：
 *  - 非对象 / null → 退化为 { state: null, hasSession: false }
 *  - 形状坏（缺字段 / 类型错）→ 同上
 *  - hasSession 缺字段 / 非布尔 → 兜底 false
 *  - 正常形状 → 完整 state + hasSession
 *
 * 不覆盖：fetchLocusPageState / putLocusEngagedPage 网络层——本仓网络层一律
 * 桩全局 fetch，测试文件已存在 globalThis.fetch 桩消费先例；本任务范围
 * 主要是纯逻辑判定，不重复覆盖装配层（see repo 测试纪律 §装配缝配装配面）。
 */

import { describe, expect, test } from 'bun:test'

import {
  parseLocusGetResponse,
  resolveLocusIntercept,
  type LocusGetResponse
} from '@/components/assistant/locus'

const PAGE_A = 'page-aaa'
const PAGE_B = 'page-bbb'
const PAGE_C = 'page-ccc'

function makeResponse(state: LocusGetResponse['state'], hasSession: boolean): LocusGetResponse {
  return { state, hasSession }
}

describe('parseLocusGetResponse', () => {
  test('非对象 → 退化为 { state: null, hasSession: false }', () => {
    expect(parseLocusGetResponse(null)).toEqual({ state: null, hasSession: false })
    expect(parseLocusGetResponse('string')).toEqual({ state: null, hasSession: false })
    expect(parseLocusGetResponse(123)).toEqual({ state: null, hasSession: false })
  })

  test('缺 state 字段 → state: null', () => {
    expect(parseLocusGetResponse({ hasSession: true })).toEqual({
      state: null,
      hasSession: true
    })
  })

  test('缺 hasSession → 兜底 false', () => {
    expect(
      parseLocusGetResponse({
        state: { modeId: null, profileId: null, engagedPageId: PAGE_A }
      })
    ).toEqual({
      state: { modeId: null, profileId: null, engagedPageId: PAGE_A },
      hasSession: false
    })
  })

  test('hasSession 非布尔 → 兜底 false', () => {
    expect(
      parseLocusGetResponse({
        state: { modeId: null, profileId: null, engagedPageId: PAGE_A },
        hasSession: 'yes'
      })
    ).toEqual({
      state: { modeId: null, profileId: null, engagedPageId: PAGE_A },
      hasSession: false
    })
  })

  test('state 形状坏（engagedPageId 是数字） → state: null', () => {
    expect(
      parseLocusGetResponse({
        state: { modeId: null, profileId: null, engagedPageId: 123 },
        hasSession: true
      })
    ).toEqual({ state: null, hasSession: true })
  })

  test('state 缺字段 → state: null', () => {
    expect(
      parseLocusGetResponse({ state: { modeId: 'm', profileId: null }, hasSession: true })
    ).toEqual({ state: null, hasSession: true })
  })

  test('正常形状 → 完整 state + hasSession', () => {
    expect(
      parseLocusGetResponse({
        state: { modeId: 'm1', profileId: 'p1', engagedPageId: PAGE_A },
        hasSession: true
      })
    ).toEqual({
      state: { modeId: 'm1', profileId: 'p1', engagedPageId: PAGE_A },
      hasSession: true
    })
  })
})

describe('resolveLocusIntercept — docUuid 缺失分支', () => {
  test('docUuid 缺失 → first-send-no-doc（不论 GET 结果）', () => {
    const intercept = resolveLocusIntercept({
      currentPageId: PAGE_B,
      pageList: [PAGE_A, PAGE_B],
      response: makeResponse({ modeId: 'm1', profileId: null, engagedPageId: PAGE_A }, true),
      docUuidPresent: false
    })
    expect(intercept).toEqual({ kind: 'first-send-no-doc', currentPageId: PAGE_B })
  })

  test('docUuid 缺失 + state 缺省 + 无 session → 仍是 first-send-no-doc（首开路径优先）', () => {
    expect(
      resolveLocusIntercept({
        currentPageId: PAGE_B,
        pageList: [PAGE_A, PAGE_B],
        response: makeResponse(null, false),
        docUuidPresent: false
      })
    ).toEqual({ kind: 'first-send-no-doc', currentPageId: PAGE_B })
  })
})

describe('resolveLocusIntercept — 初始化分支', () => {
  test('真首跑（state 缺省 + hasSession=false） → silent-init', () => {
    expect(
      resolveLocusIntercept({
        currentPageId: PAGE_B,
        pageList: [PAGE_A, PAGE_B],
        response: makeResponse(null, false),
        docUuidPresent: true
      })
    ).toEqual({ kind: 'silent-init', currentPageId: PAGE_B })
  })

  test('腐烂再初始化（state 缺省 + hasSession=true） → gate-resolve orphan（无上一屏）', () => {
    expect(
      resolveLocusIntercept({
        currentPageId: PAGE_B,
        pageList: [PAGE_A, PAGE_B],
        response: makeResponse(null, true),
        docUuidPresent: true
      })
    ).toEqual({
      kind: 'gate-resolve',
      currentPageId: PAGE_B,
      engagedPageId: '',
      reason: 'orphan'
    })
  })

  test('engagedPageId = 空字符串等价于 null（防御性归一） → 真首跑 silent-init', () => {
    expect(
      resolveLocusIntercept({
        currentPageId: PAGE_B,
        pageList: [PAGE_A, PAGE_B],
        response: makeResponse({ modeId: null, profileId: null, engagedPageId: '' }, false),
        docUuidPresent: true
      })
    ).toEqual({ kind: 'silent-init', currentPageId: PAGE_B })
  })

  test('engagedPageId = 空字符串 + hasSession=true → gate orphan', () => {
    expect(
      resolveLocusIntercept({
        currentPageId: PAGE_B,
        pageList: [PAGE_A, PAGE_B],
        response: makeResponse({ modeId: null, profileId: null, engagedPageId: '' }, true),
        docUuidPresent: true
      })
    ).toEqual({
      kind: 'gate-resolve',
      currentPageId: PAGE_B,
      engagedPageId: '',
      reason: 'orphan'
    })
  })
})

describe('resolveLocusIntercept — same-page / gate-switch 分支', () => {
  test('视图页 == engagedPageId → same-page（零动作）', () => {
    expect(
      resolveLocusIntercept({
        currentPageId: PAGE_A,
        pageList: [PAGE_A, PAGE_B],
        response: makeResponse({ modeId: null, profileId: null, engagedPageId: PAGE_A }, true),
        docUuidPresent: true
      })
    ).toEqual({ kind: 'same-page' })
  })

  test('视图页 ≠ engagedPageId（页存在） → gate-resolve switch（两按钮形态）', () => {
    expect(
      resolveLocusIntercept({
        currentPageId: PAGE_B,
        pageList: [PAGE_A, PAGE_B, PAGE_C],
        response: makeResponse({ modeId: null, profileId: null, engagedPageId: PAGE_A }, true),
        docUuidPresent: true
      })
    ).toEqual({
      kind: 'gate-resolve',
      currentPageId: PAGE_B,
      engagedPageId: PAGE_A,
      reason: 'switch'
    })
  })

  test('悬空（engaged 在页列表查无） → gate-resolve orphan（仅确认按钮）', () => {
    expect(
      resolveLocusIntercept({
        currentPageId: PAGE_B,
        pageList: [PAGE_A, PAGE_B],
        response: makeResponse(
          { modeId: null, profileId: null, engagedPageId: 'page-deleted' },
          true
        ),
        docUuidPresent: true
      })
    ).toEqual({
      kind: 'gate-resolve',
      currentPageId: PAGE_B,
      engagedPageId: 'page-deleted',
      reason: 'orphan'
    })
  })

  test('空 pageList（极异常：文档无任何页） + state 缺省 + 无 session → silent-init', () => {
    // 兜底——上层若触发 silent-init 即可放行；不允许 gate 因为没有上一屏名可显示。
    expect(
      resolveLocusIntercept({
        currentPageId: PAGE_A,
        pageList: [],
        response: makeResponse(null, false),
        docUuidPresent: true
      })
    ).toEqual({ kind: 'silent-init', currentPageId: PAGE_A })
  })
})
