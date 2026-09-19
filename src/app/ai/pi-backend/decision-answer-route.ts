/**
 * 2026-09-19 broker P1 件1：POST /api/pi/decision-answer —— ask/authz 统一决断
 * 端点（仓外 docs/202609181745-agent-permission-broker-design.md §6 统筹：answer
 * 端点合一，kind 判别路由；并行线冻结契约，body 字段名禁改）：
 * body = { kind, formId, decision, answers?, ruleText?, note? }。
 *  - kind 'ask'：decision ∈ 'answer'|'skip'——封装现有 answer/skip 语义（answers
 *    per-entry 校验 parser 单源在本档，自 ask/answer-route.ts 搬入；note 映射为
 *    顶层 notes）。
 *  - kind 'authz'：decision ∈ 'allow-once'|'allow-rule'|'deny'——'allow-rule'
 *    必带 ruleText（规则原文，guard 派生经卡按钮回传入库）；note = 拒绝附言
 *   （进 authz-guard 结构化回执）。
 * 'ok' resolve 并 200 {ok:true}；'not_found' 404 {error:'no_pending_form'}；
 * body 校验失败 400。鉴权走 server.ts 既有 bearer 中间件（路由表之下）。
 * 2026-09-19 A线尾单件3：旧 /api/pi/ask-answer 端点删除（前端已全量迁统一
 * 端点）——ask 族校验三件（collectSkipPayload / parseAnswersEntries /
 * respondNotFoundOrOk）与内部 helper（parseOneAnswerEntry/isRecord）自
 * ask/answer-route.ts 原位搬入本档（移动非复制，jscpd 纪律），形态零变化。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { parsePostBody, sendJSON } from './http-utils'
import type { AskAnswerPayload, AuthzAnswerPayload, AuthzDecision } from './pending-decision'
import type { createPiChatService } from './service'

type DecisionAnswerService = Pick<ReturnType<typeof createPiChatService>, 'decisionAnswer'>

interface DecisionAnswerBody {
  kind?: unknown
  formId?: unknown
  decision?: unknown
  answers?: unknown
  ruleText?: unknown
  note?: unknown
}

export async function handleDecisionAnswerRequest(
  service: DecisionAnswerService,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await parsePostBody<DecisionAnswerBody>(req, res)
  if (body === null) return
  if (body.kind !== 'ask' && body.kind !== 'authz') {
    sendJSON(res, 400, { error: 'invalid_args', message: "kind 必须为 'ask' 或 'authz'" })
    return
  }
  if (typeof body.formId !== 'string' || body.formId === '') {
    sendJSON(res, 400, { error: 'invalid_args', message: 'formId 必须为非空字符串' })
    return
  }
  const formId = body.formId
  const note = typeof body.note === 'string' && body.note !== '' ? body.note : undefined
  if (body.kind === 'ask') {
    handleAskKind(service, formId, body, note, res)
    return
  }
  handleAuthzKind(service, formId, body, note, res)
}

function handleAskKind(
  service: DecisionAnswerService,
  formId: string,
  body: DecisionAnswerBody,
  note: string | undefined,
  res: ServerResponse
): void {
  if (body.decision === 'skip') {
    const payload = collectSkipPayload({ notes: note })
    respondNotFoundOrOk(service.decisionAnswer({ kind: 'ask', formId, payload }), res)
    return
  }
  if (body.decision !== 'answer') {
    sendJSON(res, 400, {
      error: 'invalid_args',
      message: "kind 为 'ask' 时 decision 必须为 'answer' 或 'skip'"
    })
    return
  }
  const parsed = parseAnswersEntries(body.answers, res)
  if (parsed === null) return
  const payload: AskAnswerPayload = { answers: parsed }
  if (note) payload.notes = note
  respondNotFoundOrOk(service.decisionAnswer({ kind: 'ask', formId, payload }), res)
}

function handleAuthzKind(
  service: DecisionAnswerService,
  formId: string,
  body: DecisionAnswerBody,
  note: string | undefined,
  res: ServerResponse
): void {
  if (!isAuthzDecision(body.decision)) {
    sendJSON(res, 400, {
      error: 'invalid_args',
      message: "kind 为 'authz' 时 decision 必须为 'allow-once' / 'allow-rule' / 'deny'"
    })
    return
  }
  const payload: AuthzAnswerPayload = { decision: body.decision }
  if (body.decision === 'allow-rule') {
    if (typeof body.ruleText !== 'string' || body.ruleText.trim() === '') {
      sendJSON(res, 400, {
        error: 'invalid_args',
        message: "decision 为 'allow-rule' 时 ruleText 必须为非空字符串（规则原文）"
      })
      return
    }
    payload.ruleText = body.ruleText
  }
  if (note) payload.note = note
  respondNotFoundOrOk(service.decisionAnswer({ kind: 'authz', formId, payload }), res)
}

function isAuthzDecision(value: unknown): value is AuthzDecision {
  return value === 'allow-once' || value === 'allow-rule' || value === 'deny'
}

// ── ask 族校验与响应形态（2026-09-19 A线尾单件3 自 ask/answer-route.ts 原位搬入）──

function collectSkipPayload(body: { notes?: unknown }): { skip: true; notes?: string } {
  return typeof body.notes === 'string' && body.notes !== ''
    ? { skip: true, notes: body.notes }
    : { skip: true }
}

function parseAnswersEntries(
  raw: unknown,
  res: ServerResponse
): null | Record<string, { value?: string; values?: string[]; freeText?: string; notes?: string }> {
  if (!isRecord(raw)) {
    sendJSON(res, 400, {
      error: 'invalid_args',
      message: 'answers 必须为对象（qid → {value|values, freeText?, notes?}）'
    })
    return null
  }
  const answers: Record<
    string,
    { value?: string; values?: string[]; freeText?: string; notes?: string }
  > = {}
  for (const [qid, entry] of Object.entries(raw)) {
    const out = parseOneAnswerEntry(qid, entry, res)
    if (out === null) return null
    answers[qid] = out
  }
  return answers
}

function parseOneAnswerEntry(
  qid: string,
  raw: unknown,
  res: ServerResponse
): null | { value?: string; values?: string[]; freeText?: string; notes?: string } {
  if (!isRecord(raw)) {
    sendJSON(res, 400, {
      error: 'invalid_args',
      message: `answers.${qid} 必须为对象 {value|values, freeText?, notes?}`
    })
    return null
  }
  const entry: {
    value?: string
    values?: string[]
    freeText?: string
    notes?: string
  } = {}
  // 任一字段非空白即合法形态（与 core normalizeQuestionAnswer 同律——
  // notes/freeText 独存也是有效作答；必填题的必答闸在前端 missingRequiredAskAnswers）
  let hasContent = false
  if (typeof raw.value === 'string' && raw.value.trim() !== '') {
    entry.value = raw.value
    hasContent = true
  }
  if (Array.isArray(raw.values)) {
    // values 每项必须 string；空白 trim 后过滤。非 string 即拒（不静默吞）
    const list: string[] = []
    for (const v of raw.values) {
      if (typeof v !== 'string') {
        sendJSON(res, 400, {
          error: 'invalid_args',
          message: `answers.${qid}.values 每项必须为 string`
        })
        return null
      }
      if (v.trim() !== '') list.push(v)
    }
    if (list.length > 0) {
      entry.values = list
      hasContent = true
    }
  }
  if (typeof raw.freeText === 'string' && raw.freeText.trim() !== '') {
    entry.freeText = raw.freeText
    hasContent = true
  }
  if (typeof raw.notes === 'string' && raw.notes.trim() !== '') {
    entry.notes = raw.notes
    hasContent = true
  }
  if (!hasContent) {
    sendJSON(res, 400, {
      error: 'invalid_args',
      message: `answers.${qid} 必须至少有非空白 value/values/freeText/notes 之一`
    })
    return null
  }
  return entry
}

function respondNotFoundOrOk(result: 'ok' | 'not_found', res: ServerResponse): void {
  if (result === 'not_found') {
    sendJSON(res, 404, {
      error: 'no_pending_form',
      message: '该表单已答/已取消/未注册，无需再答'
    })
    return
  }
  sendJSON(res, 200, { ok: true })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
