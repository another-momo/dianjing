/**
 * 2026-09-18 broker P1（前端件）：pending-decision 纯函数钉扎——ask/authz 双族
 * 统筹的共享助手（设计真源 docs/202609181745-agent-permission-broker-design.md
 * §5/§6）。
 *
 * 覆盖：
 *  - 冻结契约钉扎：AUTHZ_REQUEST_PART_TYPE 字面量、formId 'authz-' 前缀、
 *    POST /api/pi/decision-answer 五类载荷形态（authz 三决断 + ask answer/skip）
 *    逐字段上送；
 *  - parseAuthzRequestData 防御性归一（形状不符 → null；缺省字段兜底）；
 *  - deriveDefaultBashRule（§11-4 默认口径：argv[0]+可识别子命令前缀+' *'）；
 *  - resolved map roundtrip（已决即收卡的数据源）；
 *  - collectPinnedDecisions 收集规则（ask input-* 未答 / authz 未决入列，
 *    已答/已决/已了结/形状不符排除）。
 *
 * 不覆盖：PendingDecisionCard.vue 的 markup/三态皮肤分叉——仓库测试栈
 * （bun:test）无 DOM 基础设施（reasoning-i18n.test.ts 头注同款纪律）。
 *
 * 状态纪律：resolvedAuthzRecords 是模块级单例（无 reset 出口）——各用例一律用
 * 互不相同的 formId，避免跨用例污染。
 */

import { afterEach, describe, expect, test } from 'bun:test'

import type { UIDataTypes, UIMessagePart, UITools } from 'ai'

import {
  AUTHZ_REQUEST_PART_TYPE,
  authzToolCallId,
  collectPinnedDecisions,
  deriveDefaultBashRule,
  getAuthzResolved,
  markAuthzResolved,
  parseAuthzRequestData,
  postDecisionAnswer,
  type DecisionAnswerPayload
} from '@/components/assistant/pending-decision'

type AnyPart = UIMessagePart<UIDataTypes, UITools>

/** 合成 UIMessagePart 桩：测试只消费 type/toolCallId/state/data 窄面，桩与真实
 *  part 的结构差由被测函数的防御性解析兜住（asElement 同款豁免先例：
 *  tests/engine/rebuild/chat/use-scroll-following.test.ts） */
function asPart(part: Record<string, unknown>): AnyPart {
  // oxlint-disable-next-line open-pencil/no-broad-double-cast -- 桩结构差由被测函数的窄消费面兜住
  return part as unknown as AnyPart
}

function askToolPart(toolCallId: string, state: string): AnyPart {
  const base = { type: 'tool-ask_user_question', toolCallId, state, input: { questions: [] } }
  return asPart(state === 'output-available' ? { ...base, output: { status: 'answered' } } : base)
}

function authzDataPart(data: unknown): AnyPart {
  return asPart({ type: AUTHZ_REQUEST_PART_TYPE, data })
}

function validAuthzPayload(formId: string) {
  return {
    formId,
    kind: 'authz',
    toolName: 'bash',
    command: 'bun test src/x.test.ts',
    cwd: '/repo'
  }
}

describe('冻结契约字面量', () => {
  test('SSE data part 类型 = data-authz-request', () => {
    expect(AUTHZ_REQUEST_PART_TYPE).toBe('data-authz-request')
  })

  test("formId 前缀 'authz-'：authzToolCallId 剥前缀 / 非前缀返 null", () => {
    expect(authzToolCallId('authz-call-123')).toBe('call-123')
    expect(authzToolCallId('authz-')).toBeNull()
    expect(authzToolCallId('call-123')).toBeNull()
    expect(authzToolCallId('')).toBeNull()
  })
})

describe('parseAuthzRequestData 防御性归一', () => {
  test('全字段载荷原样通过', () => {
    const parsed = parseAuthzRequestData({
      ...validAuthzPayload('authz-p1'),
      matchedRule: 'bun test *'
    })
    expect(parsed).toEqual({
      formId: 'authz-p1',
      kind: 'authz',
      toolName: 'bash',
      command: 'bun test src/x.test.ts',
      cwd: '/repo',
      matchedRule: 'bun test *'
    })
  })

  test('toolName 缺省兜底 bash、cwd 缺省兜底空串、matchedRule 空串视为缺席', () => {
    const parsed = parseAuthzRequestData({
      formId: 'authz-p2',
      kind: 'authz',
      command: 'ls',
      matchedRule: ''
    })
    expect(parsed).toEqual({
      formId: 'authz-p2',
      kind: 'authz',
      toolName: 'bash',
      command: 'ls',
      cwd: ''
    })
  })

  test('形状不符 → null（kind 错 / 缺 formId / 空 command / 非对象）', () => {
    expect(parseAuthzRequestData({ ...validAuthzPayload('authz-p3'), kind: 'ask' })).toBeNull()
    expect(parseAuthzRequestData({ kind: 'authz', command: 'ls' })).toBeNull()
    expect(parseAuthzRequestData({ ...validAuthzPayload(''), command: 'ls' })).toBeNull()
    expect(parseAuthzRequestData({ ...validAuthzPayload('authz-p4'), command: '' })).toBeNull()
    expect(parseAuthzRequestData(null)).toBeNull()
    expect(parseAuthzRequestData('authz-p5')).toBeNull()
  })
})

describe('deriveDefaultBashRule（§11-4 默认口径）', () => {
  test('argv[0] + 可识别子命令 + 通配', () => {
    expect(deriveDefaultBashRule('bun test src/x.test.ts')).toBe('bun test *')
    expect(deriveDefaultBashRule('git status')).toBe('git status *')
    expect(deriveDefaultBashRule('git push --force origin main')).toBe('git push *')
  })

  test('第二 token 是旗标/路径 → 不并入前缀', () => {
    expect(deriveDefaultBashRule('bun --version')).toBe('bun *')
    expect(deriveDefaultBashRule('ls -la /tmp')).toBe('ls *')
    expect(deriveDefaultBashRule('bun ./script.ts')).toBe('bun *')
  })

  test('空白容错与空命令兜底', () => {
    expect(deriveDefaultBashRule('  bun   test   x  ')).toBe('bun test *')
    expect(deriveDefaultBashRule('ls')).toBe('ls *')
    expect(deriveDefaultBashRule('')).toBe('*')
    expect(deriveDefaultBashRule('   ')).toBe('*')
  })
})

describe('resolved map', () => {
  test('markAuthzResolved → getAuthzResolved roundtrip；未命中返 undefined', () => {
    expect(getAuthzResolved('authz-r0')).toBeUndefined()
    markAuthzResolved({
      formId: 'authz-r0',
      command: 'bun test',
      cwd: '/repo',
      decision: 'allow-rule',
      ruleText: 'bun test *'
    })
    expect(getAuthzResolved('authz-r0')?.decision).toBe('allow-rule')
    expect(getAuthzResolved('authz-r0')?.ruleText).toBe('bun test *')
  })
})

describe('collectPinnedDecisions（pinned dock 收集规则）', () => {
  test('ask 未决（input-available / input-streaming）入列，part 与 partState 原值', () => {
    const available = askToolPart('c1', 'input-available')
    const streaming = askToolPart('c2', 'input-streaming')
    const views = collectPinnedDecisions([streaming, available], new Set())
    expect(views).toHaveLength(2)
    expect(views[0]).toMatchObject({ kind: 'ask', partState: 'input-streaming' })
    expect(views[1]).toMatchObject({ kind: 'ask', partState: 'input-available' })
    expect(views[0].kind === 'ask' && views[0].part === streaming).toBe(true)
  })

  test('ask 已了结（output-available）与已答（信封 formId 命中）排除', () => {
    const done = askToolPart('c3', 'output-available')
    const answered = askToolPart('c4', 'input-available')
    const views = collectPinnedDecisions([done, answered], new Set(['ask-c4']))
    expect(views).toHaveLength(0)
  })

  test('authz 未决入列（mode pending）；已决 / 形状不符排除', () => {
    markAuthzResolved({
      formId: 'authz-r1',
      command: 'bun test',
      cwd: '/repo',
      decision: 'allow-once'
    })
    const views = collectPinnedDecisions(
      [
        authzDataPart(validAuthzPayload('authz-r2')),
        authzDataPart(validAuthzPayload('authz-r1')),
        authzDataPart({ kind: 'ask', formId: 'ask-x', command: 'ls' })
      ],
      new Set()
    )
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      kind: 'authz',
      mode: 'pending',
      request: { formId: 'authz-r2', toolName: 'bash' }
    })
  })

  test('其他 part（其他工具 / 文本）不入列', () => {
    const bashTool = asPart({
      type: 'tool-bash',
      toolCallId: 'c5',
      state: 'input-available',
      input: { command: 'ls' }
    })
    const text = asPart({ type: 'text', text: 'hi' })
    expect(collectPinnedDecisions([bashTool, text], new Set())).toHaveLength(0)
  })
})

describe('postDecisionAnswer（统一端点 POST /api/pi/decision-answer）', () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; method: string | null; body: unknown } | null

  afterEach(() => {
    globalThis.fetch = originalFetch
    captured = null
  })

  function stubFetch(impl: (body: unknown) => Response | Promise<Response>) {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      let url: string
      if (typeof input === 'string') url = input
      else if (input instanceof URL) url = input.href
      else url = input.url
      const rawBody = typeof init?.body === 'string' ? init.body : null
      const body: unknown = rawBody === null ? null : JSON.parse(rawBody)
      captured = { url, method: init?.method ?? null, body }
      return impl(body)
    }
    globalThis.fetch = fetchImpl as typeof fetch
  }

  function jsonResponse(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }

  test('authz allow-rule 载荷逐字段上送（ruleText = 按钮呈现的规则原文）', async () => {
    stubFetch(() => jsonResponse(200, { ok: true }))
    const payload: DecisionAnswerPayload = {
      kind: 'authz',
      formId: 'authz-f1',
      decision: 'allow-rule',
      ruleText: 'bun test *'
    }
    const result = await postDecisionAnswer(payload)
    expect(result).toEqual({ ok: true })
    expect(captured?.url).toBe('/api/pi/decision-answer')
    expect(captured?.method).toBe('POST')
    expect(captured?.body).toEqual({
      kind: 'authz',
      formId: 'authz-f1',
      decision: 'allow-rule',
      ruleText: 'bun test *'
    })
  })

  test('ask answer/skip 封装进同一端点形态（notes 可选）', async () => {
    stubFetch(() => jsonResponse(200, { ok: true }))
    await postDecisionAnswer({
      kind: 'ask',
      formId: 'ask-f2',
      decision: 'answer',
      answers: { q1: { value: 'A' } },
      notes: '备注'
    })
    expect(captured?.body).toEqual({
      kind: 'ask',
      formId: 'ask-f2',
      decision: 'answer',
      answers: { q1: { value: 'A' } },
      notes: '备注'
    })
    await postDecisionAnswer({ kind: 'ask', formId: 'ask-f3', decision: 'skip' })
    expect(captured?.body).toEqual({
      kind: 'ask',
      formId: 'ask-f3',
      decision: 'skip'
    })
  })

  test('优雅降级：404 / ok:false / 网络错误 → {ok:false, message}，不抛', async () => {
    stubFetch(() => jsonResponse(404, { error: 'not found' }))
    expect(
      await postDecisionAnswer({ kind: 'authz', formId: 'authz-f4', decision: 'deny' })
    ).toEqual({
      ok: false,
      message: 'not found'
    })

    stubFetch(() => jsonResponse(200, { ok: false, message: 'pending gone' }))
    expect(
      await postDecisionAnswer({ kind: 'authz', formId: 'authz-f5', decision: 'allow-once' })
    ).toEqual({ ok: false, message: 'pending gone' })

    stubFetch(() => {
      throw new Error('socket hangup')
    })
    const result = await postDecisionAnswer({ kind: 'authz', formId: 'authz-f6', decision: 'deny' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toBe('socket hangup')
  })
})
