/**
 * T23 会话族谱清单条目的共享契约（GET /api/pi/sessions 响应元素）。
 *
 * 独立成纯类型模块的原因：后端 service.ts（node:fs）与前端 document-key.ts
 * （浏览器包）都需要该形状，而 test:type-shapes 禁止两处同构定义；
 * 本文件零运行时 import，浏览器侧 type-only 引用在构建期擦除、不带入 node 依赖。
 */
export type PiSessionSummary = {
  sessionId: string
  /** 首条 user 文本截断 40 字符；无 user 消息时空串 */
  title: string
  /** 折叠后的 UIMessage 条数（toolResult 并入 assistant 工具卡片） */
  messageCount: number
  /** 会话文件 mtime（展示参考，不参与排序——排序键=创建时刻后缀字典序） */
  updatedAtMs: number
}
