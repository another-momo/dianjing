/**
 * T28（决策单 #1）：直连后端的冒烟脚本共用——standalone 后端启动时把鉴权
 * token 落盘到 <cwd>/.dianjing/pi-backend-token（main.ts），脚本从该文件
 * 读 token 构造 Authorization 头。
 * token 卫生：只进请求头，断言输出/日志一律不打印 token 本体。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readBackendToken(backendRoot) {
  return readFileSync(join(backendRoot, '.dianjing', 'pi-backend-token'), 'utf8').trim()
}

export function authHeaders(token) {
  return { authorization: `Bearer ${token}` }
}
