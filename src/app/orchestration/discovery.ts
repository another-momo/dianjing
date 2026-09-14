/**
 * Dev MCP discovery 路径推导单源：tmpdir()/dianjing-mcp/sha256(runtimeId)[:16]/mcp.json。
 *
 * 算法历史（移植自 src/app/ai/pi-backend/vite-plugin.ts:58 与
 * src/app/bridge/vite-plugin.ts:120 的同源推导）：上游 0f981ff2（经 T34 合入）
 * 把 dev 桥 discovery 隔离到 tmpdir 后，pi-backend 侧 tools.ts 盲读平台默认
 * 路径→工具调用全灭（T38-plan §1 根因 B）。算法必须与桥 vite 插件保持一致，
 * 一致性由 tests/engine/rebuild/pi-backend/dev-discovery.test.ts 硬编码 digest 钉扎
 * （上游改算法即红）。
 */
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEV_MCP_TMP_PREFIX } from './brand'

function safeRuntimeId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** runtimeId 同源推导的 dev 桥 discovery 目录（不带 mcp.json） */
export function devMCPRuntimeDir(runtimeId: string): string {
  return join(tmpdir(), DEV_MCP_TMP_PREFIX, safeRuntimeId(runtimeId))
}

/** runtimeId 同源推导的 dev 桥 discovery 文件全路径（mcp.json 终态） */
export function devMCPDiscoveryPath(runtimeId: string): string {
  return join(devMCPRuntimeDir(runtimeId), 'mcp.json')
}
