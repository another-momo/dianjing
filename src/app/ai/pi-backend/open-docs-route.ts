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

import { PayloadTooLargeError, readBody, sendJSON, sendPayloadTooLarge } from './http-utils'
import type { OpenDocsGuard } from './open-docs'

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

async function readJSONBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const body: unknown = JSON.parse(await readBody(req))
    return { ok: true, body }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendPayloadTooLarge(req, res)
    } else {
      res.writeHead(400).end('Bad Request: invalid JSON')
    }
    return { ok: false }
  }
}

async function handleClaim(
  guard: OpenDocsGuard,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  const parsed = await readJSONBody(req, res)
  if (!parsed.ok) return
  const parseResult = v.safeParse(claimBodySchema, parsed.body)
  if (!parseResult.success) {
    sendJSON(res, 400, {
      error: 'open-docs claim body 形状不合法：需 { docUuid, windowId, force?: boolean }'
    })
    return
  }
  const { docUuid, windowId, force } = parseResult.output
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
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  const parsed = await readJSONBody(req, res)
  if (!parsed.ok) return
  const parseResult = v.safeParse(heartbeatBodySchema, parsed.body)
  if (!parseResult.success) {
    sendJSON(res, 400, {
      error: 'open-docs heartbeat body 形状不合法：需 { docUuid, windowId, force?: boolean }'
    })
    return
  }
  const { docUuid, windowId, force } = parseResult.output
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
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  const parsed = await readJSONBody(req, res)
  if (!parsed.ok) return
  const parseResult = v.safeParse(releaseBodySchema, parsed.body)
  if (!parseResult.success) {
    sendJSON(res, 400, {
      error: 'open-docs release body 形状不合法：需 { docUuid, windowId }'
    })
    return
  }
  const { docUuid, windowId } = parseResult.output
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
