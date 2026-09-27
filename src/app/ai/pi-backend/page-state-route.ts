/**
 * 2026-09-26 sl-w1-page-state：page-state HTTP 路由——
 * GET  /api/pi/page-state?docUuid=<uuid>
 *   → 200 { state: { modeId, profileId, engagedPageId } | null,
 *           hasSession: boolean }
 *   腐烂 / 缺失 → state: null（不抛、不 500；与 store.read 语义一致）
 *   hasSession = 族内是否有过会话（docKey 前缀扫描 index.json）；
 *   前端初始化分档用——有会话 = 历史回填命中；无 = 真首跑路径
 *
 * PUT  /api/pi/page-state { docUuid, patch }
 *   patch: { modeId?: string|null, profileId?: string|null, engagedPageId?: string|null }
 *   未传字段 = 不动；显式 null = 清空该字段
 *   → 200 { state: { ... } }
 *
 * 端点薄：store.write 已做形状校验（字符串 / null），此处仅 Valibot 兜
 * 字段存在性与 docUuid 合法性；空 body / patch 缺字段走 400 不删文件
 * （与 design-assignment-route 同律：缺字段 ≠ 显式 null）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import * as v from 'valibot'

import { PayloadTooLargeError, readBody, sendJSON, sendPayloadTooLarge } from './http-utils'
import type { PageStateStore } from './page-state'

type PageStateStoreService = Pick<PageStateStore, 'read' | 'write' | 'clear' | 'exists'>
/** 2026-09-27 sl-w2-state-chain：hasSession 真源——会话索引按 docUuid 键控，
 *  前端初始化分档。注入式接口（避免本路由直接依赖 service.ts 闭包） */
type PageStateRouteDeps = {
  store: PageStateStoreService
  hasSessionForDocUuid(docUuid: string): boolean
}

const docUuidSchema = v.pipe(v.string(), v.minLength(1, 'docUuid 不能为空'))

const nullableString = v.union([v.string(), v.null()])

const patchSchema = v.object({
  modeId: v.optional(nullableString),
  profileId: v.optional(nullableString),
  engagedPageId: v.optional(nullableString)
})

const putBodySchema = v.object({
  docUuid: docUuidSchema,
  patch: v.optional(patchSchema)
})

export async function handlePageStateRequest(
  deps: PageStateRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method === 'GET') {
    const url = new URL(req.url ?? '', 'http://localhost')
    const docUuidRaw = url.searchParams.get('docUuid')
    const parseResult = v.safeParse(docUuidSchema, docUuidRaw ?? '')
    if (!parseResult.success) {
      sendJSON(res, 400, { error: 'query 缺 docUuid（或非法）' })
      return
    }
    try {
      const state = deps.store.read(parseResult.output)
      // 2026-09-27 sl-w2-state-chain：hasSession 真源 = service 层
      // hasSessionForDocUuid（sha1(docUuid) → 前缀扫描 index.json）；
      // 非法 docUuid 由 store 形状校验兜回 400，此处不会再遇。
      const hasSession = deps.hasSessionForDocUuid(parseResult.output)
      sendJSON(res, 200, { state, hasSession })
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return
  }
  if (req.method !== 'PUT') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readBody(req))
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendPayloadTooLarge(req, res)
      return
    }
    res.writeHead(400).end('Bad Request: invalid JSON')
    return
  }
  const parseBody = v.safeParse(putBodySchema, raw)
  if (!parseBody.success) {
    sendJSON(res, 400, {
      error: 'page-state body 形状不合法：需 { docUuid, patch? }'
    })
    return
  }
  const { docUuid, patch } = parseBody.output
  // 缺 patch ≠ 空 patch：缺省 = 调用方形状错误 → 400 不删文件（缺字段 ≠
  // 显式空）；显式 patch: {} 才走 store 的空 patch 语义（删文件，与
  // design-assignment set(null) 同律）。缺省误删会把一个手滑的 PUT 变成
  // 文档状态清空。
  if (patch === undefined) {
    sendJSON(res, 400, {
      error: 'page-state body 缺 patch（显式 patch: {} 才是清空语义）'
    })
    return
  }
  try {
    const state = deps.store.write(docUuid, patch)
    sendJSON(res, 200, { state })
  } catch (error) {
    sendJSON(res, 400, {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
