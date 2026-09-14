import { expect, test } from 'bun:test'

import { devMCPDiscoveryPath } from '@/app/ai/pi-backend/vite-plugin'

// T38：钉扎 pi 后端侧 discovery 路径推导与桥 vite 插件（上游
// src/app/bridge/vite-plugin.ts 的 safeRuntimeId + startChild）同源——
// digest 硬编码，上游若改算法本测试变红，提示同步。
// 实证事故（2026-08-28）：上游 0f981ff2 经 T34 合入后 dev 桥 discovery 隔离到
// tmpdir，pi 后端 tools.ts 盲读平台默认路径 → 工具调用全灭（T38-plan §1 根因 B）。
test('pi dev discovery path matches bridge plugin algorithm', () => {
  // 'localhost-7600' 是 devAutomationRoute() 无 PORTLESS_URL 时的 fallback runtimeId
  const path = devMCPDiscoveryPath('localhost-7600').replaceAll('\\', '/')
  expect(path.endsWith('open-pencil-mcp/18d901424f534c7b/mcp.json')).toBe(true)
})
