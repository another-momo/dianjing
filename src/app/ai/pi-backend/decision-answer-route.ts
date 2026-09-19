/**
 * 2026-09-19 broker P1 件1：POST /api/pi/decision-answer —— ask/authz 统一决断
 * 端点（仓外 docs/202609181745-agent-permission-broker-design.md §6 统筹：answer
 * 端点合一，kind 判别路由；并行线冻结契约，body 字段名禁改）：
 * body = { kind, formId, decision, answers?, ruleText?, note? }。
 *  - kind 'ask'：decision ∈ 'answer'|'skip'——封装现有 answer/skip 语义（answers
 *    per-entry 校验复用 ask/answer-route.ts parser，单一真源；note 映射为顶层 notes）。
 *  - kind 'authz'：decision ∈ 'allow-once'|'allow-rule'|'deny'——'allow-rule'
 *    必带 ruleText（规则原文，guard 派生经卡按钮回传入库）；note = 拒绝附言
 *   （进 authz-guard 结构化回执）。
 * 'ok' resolve 并 200 {ok:true}；'not_found' 404 {error:'no_pending_form'}；
 * body 校验失败 400。鉴权走 server.ts 既有 bearer 中间件（路由表之下）。
 * 旧 /api/pi/ask-answer 保留（ask/answer-route.ts）——前端另一线未收口前现网
 * ask 卡仍走旧端点，删除旧端点留给尾单。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { collectSkipPayload, parseAnswersEntries, respondNotFoundOrOk } from './ask/answer-route'
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
