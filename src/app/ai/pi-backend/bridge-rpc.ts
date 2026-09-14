/**
 * 7600 桥 /rpc POST 共享助手（T52 集成期消克隆：tools.ts callBridgeTool 与
 * undo-group.ts sendUndoGroupSignal 的 fetch 块逐 token 相同，jscpd 门禁拦下）。
 *
 * 只负责发请求并返回原始 Response；状态码解读/重试/错误文案归各调用方
 * （语义不同：tools.ts 会抛错重试，undo-group.ts 吞掉不阻断）。
 *
 * T98-路由：windowId 是请求体外层信封字段（与 documentId 同风格），传入时
 * 放进 body 顶层 `{ command, args, windowId }`——桥按发起窗路由 RPC。
 * windowId 缺省时不出现在 body 中（向后兼容，缺省落最后注册窗）。
 */

import type { DiscoveryInfo } from '@/app/bridge/server/discovery'

export function postBridgeRPC(
  discovery: DiscoveryInfo,
  command: string,
  args: Record<string, unknown>,
  windowId?: string
): Promise<Response> {
  const body: Record<string, unknown> = { command, args }
  if (windowId) body.windowId = windowId
  return fetch(`http://127.0.0.1:${discovery.httpPort}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(discovery.authToken ? { authorization: `Bearer ${discovery.authToken}` } : {})
    },
    body: JSON.stringify(body)
  })
}
