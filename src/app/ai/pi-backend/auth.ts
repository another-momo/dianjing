/**
 * T28（决策单 #1，owner 拍板 2026-08-25）：pi 后端 bearer token 鉴权。
 *
 * 机制对齐 7600 桥（automation/bridge/server/auth.ts）：sha256 摘要 + timingSafeEqual
 * 定时常数比较（不直接比原始 token，防时序侧信道；摘要定长天然规避长度差异
 * 导致的 timingSafeEqual 抛错）。
 *
 * token 本体只经两条路到达后端进程（main.ts 解析，见该文件头部注释）：
 *  - vite 插件 spawn：env DIANJING_PI_TOKEN 注入（每 vite 进程一枚随机值），
 *    vite proxy 给 /api/pi 转发自动补 Authorization 头，前端同源调用零改动
 *  - standalone（bun run dev:backend）：自生成随机值写 .dianjing/pi-backend-token
 *    （0o600），控制台只打印文件路径
 *
 * key 卫生：本模块只在内存中比较，任何日志/响应不得含 token 本体。
 */

import { createHash, timingSafeEqual } from 'node:crypto'

export function bearerToken(authorization: string | undefined | null): string | null {
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null
}

/** expected 为 null/空 = 无 token 配置（不应发生）——fail-close 全拒 */
export function isAuthorized(
  authorization: string | undefined | null,
  expected: string | null
): boolean {
  if (!expected) return false
  const provided = bearerToken(authorization)
  if (provided === null) return false
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}
