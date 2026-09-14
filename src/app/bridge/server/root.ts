import { homedir, platform } from 'node:os'

import { readMCPRoot } from '@/app/orchestration/env'

export function resolveMCPRoot(value: string | undefined, runtimePlatform = platform()): string {
  // DIANJING_MCP_ROOT：sidecar 形态下 cwd 不可依赖时的显式覆盖；
  // 不传时维持现状（win32 → homedir，posix → cwd）
  return value?.trim() || readMCPRoot() || (runtimePlatform === 'win32' ? homedir() : process.cwd())
}
