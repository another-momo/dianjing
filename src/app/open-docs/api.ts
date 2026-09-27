/**
 * open-docs 前端 HTTP 客户端——三件端点契约真源在后端 route.ts 头注：
 * claim 200 { record } / 409 { holder }、heartbeat 204 / 409、release 恒 204。
 * fetch 一律相对路径（dev 走 vite proxy，产品形态走 loopback——与
 * intent-confirm 同款）；windowId 随请求直传。
 */

import { getWindowId } from '@/app/bridge/window-id'

/** 活性文件登记形（与后端 OpenDocRecord 同构） */
export interface OpenDocsHolder {
  pid: number
  windowId: string
  heartbeatAt: number
}

export type ClaimOutcome =
  | { kind: 'claimed'; record: OpenDocsHolder }
  | { kind: 'conflict'; holder: OpenDocsHolder }
  /** 网络/非预期响应——守卫尽力而为，调用方不拦打开 */
  | { kind: 'unavailable' }

function postJSON(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** 409 响应体防御性解析：holder 形状坏 → null（调用方按 unavailable 处理） */
async function readConflictHolder(res: Response): Promise<OpenDocsHolder | null> {
  const body = (await res.json().catch(() => null)) as { holder?: OpenDocsHolder } | null
  const holder = body?.holder
  if (
    holder !== null &&
    typeof holder === 'object' &&
    typeof holder.pid === 'number' &&
    typeof holder.windowId === 'string' &&
    typeof holder.heartbeatAt === 'number'
  ) {
    return holder
  }
  return null
}

export async function requestClaim(docUuid: string, force = false): Promise<ClaimOutcome> {
  try {
    const res = await postJSON('/api/pi/open-docs/claim', {
      docUuid,
      windowId: getWindowId(),
      force
    })
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { record?: OpenDocsHolder } | null
      if (body?.record) return { kind: 'claimed', record: body.record }
      return { kind: 'unavailable' }
    }
    if (res.status === 409) {
      const holder = await readConflictHolder(res)
      if (holder) return { kind: 'conflict', holder }
    }
    return { kind: 'unavailable' }
  } catch {
    return { kind: 'unavailable' }
  }
}

/** 204 = 持有刷新成功；409 = 持有权已被他人接管；其余状态视为网络层异常抛出 */
export async function requestHeartbeat(docUuid: string): Promise<'held' | 'taken'> {
  const res = await postJSON('/api/pi/open-docs/heartbeat', {
    docUuid,
    windowId: getWindowId()
  })
  if (res.status === 204) return 'held'
  if (res.status === 409) return 'taken'
  throw new Error(`open-docs heartbeat unexpected status: ${res.status}`)
}

/** release 恒 204，发射后不管（失败不重试——持有登记由心跳 TTL 过期回收） */
export async function requestRelease(docUuid: string): Promise<void> {
  try {
    await postJSON('/api/pi/open-docs/release', { docUuid, windowId: getWindowId() })
  } catch (error) {
    // release 失败由心跳 TTL 兜底
    console.warn('[open-docs] release request failed; heartbeat TTL will reclaim:', error)
  }
}
