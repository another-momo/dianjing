/**
 * 2026-09-26 sl-w1-page-state：open-docs HTTP 路由——docUuid 存活唯一守卫的
 * 三件端点。
 *
 * POST /api/pi/open-docs/claim      { docUuid, windowId, force?: boolean }
 *   → 200 { record: { pid, windowId, heartbeatAt } }         ok 持有
 *   → 409 { error: 'live_other_instance', holder: {...} }    另一活实例持有
 *
 * POST /api/pi/open-docs/heartbeat  { docUuid, windowId, force?: boolean }
 *   → 204 No Content                                       刷新成功
 *   → 409 { error: 'live_other_instance', holder: null }   别人占着（未 force；心跳是周期动作，不带 holder 避免歧义）
 *
 * POST /api/pi/open-docs/release    { docUuid, windowId }
 *   → 204 No Content                                       注销成功（已是他人占着 / 自己已不持 = no-op 也返 204）
 *
 * 三端点均为 POST——与决策类端点（decision-answer / intent-confirm）同律：
 * 写动作走 POST 而非 PUT，理由是端点语义是「动作触发」（claim / heartbeat
 * / release 都是动词）而非「资源覆写」。
 *
 * 响应 conflict 形态与 PendingDecisionStore 等同族冲突响应同构（409 +
 * holder 字段），前端统一走「拦 + 显原因 + 「仍要打开」覆写」模式。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import * as v from 'valibot'

import { parsePostBody, sendJSON } from '../http-utils'
import type { OpenDocsGuard } from './guard'

const docUuidSchema = v.pipe(v.string(), v.minLength(1, 'docUuid 不能为空'))
const windowIdSchema = v.pipe(v.string(), v.minLength(1, 'windowId 不能为空'))

const claimBodySchema = v.object({
  docUuid: docUuidSchema,
  windowId: windowIdSchema,
  force: v.optional(v.boolean())
})

const heartbeatBodySchema = v.object({
  docUuid: docUuidSchema,
  windowId: windowIdSchema,
  force: v.optional(v.boolean())
})

const releaseBodySchema = v.object({
  docUuid: docUuidSchema,
  windowId: windowIdSchema
})

/** safeParse + 400 hint 公共尾（jscpd 0 阈值纪律）：形状不合法即写 400 并返 null。 */
function parseBodyOrSendError<S extends v.GenericSchema>(
  res: ServerResponse,
  schema: S,
  body: unknown,
  hint: string
): v.InferOutput<S> | null {
  const parseResult = v.safeParse(schema, body)
  if (parseResult.success) return parseResult.output
  sendJSON(res, 400, { error: hint })
  return null
}

async function handleClaim(
  guard: OpenDocsGuard,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await parsePostBody(req, res)
  if (body === null) return
  const parsed = parseBodyOrSendError(
    res,
    claimBodySchema,
    body,
    'open-docs claim body 形状不合法：需 { docUuid, windowId, force?: boolean }'
  )
  if (parsed === null) return
  const { docUuid, windowId, force } = parsed
  try {
    const result = guard.claim(docUuid, windowId, { force: force === true })
    if (result.ok) {
      sendJSON(res, 200, { record: result.record })
    } else {
      sendJSON(res, 409, {
        error: result.reason,
        holder: result.holder
      })
    }
  } catch (error) {
    sendJSON(res, 400, {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function handleHeartbeat(
  guard: OpenDocsGuard,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await parsePostBody(req, res)
  if (body === null) return
  const parsed = parseBodyOrSendError(
    res,
    heartbeatBodySchema,
    body,
    'open-docs heartbeat body 形状不合法：需 { docUuid, windowId, force?: boolean }'
  )
  if (parsed === null) return
  const { docUuid, windowId, force } = parsed
  try {
    const ok = guard.heartbeat(docUuid, windowId, { force: force === true })
    if (ok) {
      res.writeHead(204).end()
    } else {
      sendJSON(res, 409, {
        error: 'live_other_instance',
        holder: null
      })
    }
  } catch (error) {
    sendJSON(res, 400, {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function handleRelease(
  guard: OpenDocsGuard,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await parsePostBody(req, res)
  if (body === null) return
  const parsed = parseBodyOrSendError(
    res,
    releaseBodySchema,
    body,
    'open-docs release body 形状不合法：需 { docUuid, windowId }'
  )
  if (parsed === null) return
  const { docUuid, windowId } = parsed
  try {
    // release 即便失败（已是他人占着 / 自己已不持）也返 204——
    // 调用方已声明「我要关了」，服务端据此宽容收尾；非 204 反而会让
    // 前端关闭流程产生无谓 retry。
    guard.release(docUuid, windowId)
    res.writeHead(204).end()
  } catch (error) {
    sendJSON(res, 400, {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function handleOpenDocsRequest(
  guard: OpenDocsGuard,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<void> {
  if (pathname === '/api/pi/open-docs/claim') {
    return handleClaim(guard, req, res)
  }
  if (pathname === '/api/pi/open-docs/heartbeat') {
    return handleHeartbeat(guard, req, res)
  }
  if (pathname === '/api/pi/open-docs/release') {
    return handleRelease(guard, req, res)
  }
  res.writeHead(404).end('Not Found')
}
