import { randomUUID } from 'node:crypto'

import { devAutomationRoute } from '../src/app/bridge/portless-route'
import { automationPlugin } from '../src/app/bridge/vite-plugin'
import {
  readDevAutomationAuthToken,
  readDevBridgePort,
  readDevOrigin,
  readPortlessURL
} from '../src/app/orchestration/env'

// 缺省 randomUUID 与原位 `?? randomUUID()` 语义一致；测试环境用 env 注入。
const devAutomationAuthToken = readDevAutomationAuthToken() ?? randomUUID()

export function localAutomationToken(command: string): string | null {
  return command === 'serve' ? devAutomationAuthToken : null
}

export function automationCORSOrigin(host: string | undefined): string {
  return host ? `http://${host}:1420` : 'http://localhost:1420'
}

export function localAutomationRoute(host: string | undefined) {
  // 解析 dev 端口 + 端口范围校验抛错（与原位 throw 等价）；reader 自身抛错，
  // 调用方让 vite plugin 启动失败——与原位 throw 同一时序。
  const port = readDevBridgePort()
  const envOrigin = readDevOrigin()
  const origin = envOrigin ?? automationCORSOrigin(host)
  // origin 校验在 reader 阶段完成（readDevOrigin 已抛非 http(s)），
  // 这里再二次校验兜底 default 拼接结果。
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
    throw new Error('DIANJING_DEV_ORIGIN must be an HTTP(S) origin')
  }
  return {
    ...devAutomationRoute(readPortlessURL() ?? undefined, port, origin),
    httpPort: port
  }
}

export function openPencilAutomationPlugin(command: string, host: string | undefined) {
  return automationPlugin(localAutomationToken(command), localAutomationRoute(host))
}
