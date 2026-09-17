/**
 * 2026-09-16：GET/PUT /api/pi/design-assignment 路由实现——
 * design 模型指派读写（指派后端化，真源 <状态根>/pi-agent/
 * design-assignment.json）。
 *
 * GET → { assignment: PiModelSpec | null }；
 * PUT 接 { assignment }，service.setDesignAssignment 抛 TypeError → 400；
 * null → 删文件（service.setDesignAssignment 内部 existsSync 守卫）。
 *
 * 端点保持薄：不做 catalog 存在性校验——腐烂指派由 provider-gate needs-setup
 * 兜底（指派 provider/model 不在目录也走 needs-setup）。
 *
 * 独立 handler 文件——server.ts 主体已被 max-lines 卡在 600 行上界
 * （问答案 handler 同款先例 ask/answer-route.ts）。路由分发仍由 server.ts 装配。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PiModelSpec } from './client'
import { PayloadTooLargeError, readBody, sendJSON, sendPayloadTooLarge } from './http-utils'
import type { createPiChatService } from './service'

type DesignAssignmentService = Pick<
  ReturnType<typeof createPiChatService>,
  'getDesignAssignment' | 'setDesignAssignment'
>

interface DesignAssignmentBody {
  assignment?: PiModelSpec | null
}

export async function handleDesignAssignmentRequest(
  service: DesignAssignmentService,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method === 'GET') {
    sendJSON(res, 200, { assignment: service.getDesignAssignment() })
    return
  }
  if (req.method !== 'PUT') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  let body: DesignAssignmentBody
  try {
    body = JSON.parse(await readBody(req)) as DesignAssignmentBody
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendPayloadTooLarge(req, res)
      return
    }
    res.writeHead(400).end('Bad Request: invalid JSON')
    return
  }
  // 缺字段 ≠ 显式 null：缺字段是畸形请求（400），显式 null 才是清除指派——
  // 否则 PUT {} 会静默删指派（主 agent review 补洞）
  if (!('assignment' in body)) {
    sendJSON(res, 400, { error: 'body 缺 assignment 字段（显式 null = 清除指派）' })
    return
  }
  try {
    // set 已做形状校验；null 允许（删文件）；非 null 形状坏 → TypeError
    const next = service.setDesignAssignment(body.assignment ?? null)
    sendJSON(res, 200, { assignment: next })
  } catch (error) {
    sendJSON(res, 400, {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
