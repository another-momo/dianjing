/**
 * 2026-09-15：POST /api/pi/ask-answer —— 表单作答/跳过端点（ask_user_question
 * 硬阻断新流）。body {formId, answers?, skip?, notes?}；answers 与 skip 二选一；
 * formId 非空 string。'ok' resolve 并 200；'not_found' 表中无该 formId 返 404
 * + {error:'no_pending_form'}；body 校验失败 400。鉴权走既有 bearer 中间件
 * （路由表之下）。错误处理与 setPiCredential 同律。Wave 2：per-entry 形态扩为
 * {value?, values?: string[], freeText?, notes?}——任一字段非空白即合法形态
 * （与 core normalizeQuestionAnswer 同律；必填必答闸在前端）；顶层 notes
 * 透传给 service.askAnswer（写入 details.notes 与 envelope）。
 *
 * 独立 handler 文件——server.ts 主体已被 max-lines 卡在 600 行上界，本文件专责
 * ask-answer 端点的所有逻辑（路由分发仍由 server.ts 装配）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { parsePostBody, sendJSON } from '../http-utils'
import type { createPiChatService } from '../service'

type AskAnswerService = Pick<ReturnType<typeof createPiChatService>, 'askAnswer'>

interface AskAnswerBody {
  formId?: unknown
  answers?: unknown
  skip?: unknown
  notes?: unknown
}

export async function handleAskAnswerRequest(
  service: AskAnswerService,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await parsePostBody<AskAnswerBody>(req, res)
  if (body === null) return
  if (typeof body.formId !== 'string' || body.formId === '') {
    sendJSON(res, 400, { error: 'invalid_args', message: 'formId 必须为非空字符串' })
    return
  }
  const hasAnswers = body.answers !== undefined
  const hasSkip = body.skip === true
  if (hasAnswers === hasSkip) {
    sendJSON(res, 400, {
      error: 'invalid_args',
      message: 'answers 与 skip 必须二选一（skip=true 或 answers 对象）'
    })
    return
  }
  if (hasSkip) {
    respondAskNotFoundOrOk(service.askAnswer(body.formId, collectSkipPayload(body)), res)
    return
  }
  const parsed = parseAnswersEntries(body.answers, res)
  if (parsed === null) return
  const payload: { answers: typeof parsed; notes?: string } = { answers: parsed }
  if (typeof body.notes === 'string' && body.notes !== '') payload.notes = body.notes
  respondAskNotFoundOrOk(service.askAnswer(body.formId, payload), res)
}

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

function respondAskNotFoundOrOk(result: 'ok' | 'not_found', res: ServerResponse): void {
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
