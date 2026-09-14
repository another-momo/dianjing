/**
 * 窗口感知路由（multi-window）：每个 JS realm 一个模块级 UUID，用于桥路由
 * 把同 app 多窗的 RPC 调用精准投到发起窗口。
 *
 * 设计取舍（T98-路由决策单 #1）：
 *  - 不用 sessionStorage：复制标签页（duplicate tab）会继承源 tab 的
 *    sessionStorage —— 两窗同 windowId 在桥侧撞槽位，路由退化为不可预测
 *    的 last-wins。模块级缓存 + crypto.randomUUID() 每个 realm 拿一份独立
 *    id（每个 window/iframe 独立 VM），复制粘贴不复用；
 *  - 整页刷新拿新 id：可接受 —— 旧槽位经 ws close 清理（browser-rpc.ts
 *    handleClose 删除对应 windowId 槽位 + reject 该槽 pending）；
 *  - 不持久化：刷新即变，documentId 才是文档级稳定键 —— 路由靠 windowId +
 *    documentId 双键，documentId 仍跨刷新稳定（document-key.ts）。
 */
let cachedWindowId: string | null = null

export function getWindowId(): string {
  if (cachedWindowId === null) {
    cachedWindowId = crypto.randomUUID()
  }
  return cachedWindowId
}
