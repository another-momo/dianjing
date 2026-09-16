/**
 * T24 聊天模式契约（type-only 单源，同 session/summary.ts 先例）：
 * 前后端共用 PiChatMode 类型。type-shapes 门禁禁止同构类型重复定义——
 * 浏览器侧 import type 构建期擦除，不进后端 bundle 边界问题。
 */

/** AgentMode 标识（T24-plan D1 四层抽象的模式层键） */
export type PiChatMode = 'ui' | 'marketing'
