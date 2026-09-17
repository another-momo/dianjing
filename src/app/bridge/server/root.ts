import { homedir, platform } from 'node:os'

import { readBridgeRoot } from '@/app/orchestration/env'

export function resolveBridgeRoot(value: string | undefined, runtimePlatform = platform()): string {
  // DIANJING_BRIDGE_ROOT：sidecar 形态下 cwd 不可依赖时的显式覆盖；
  // 不传时维持现状（win32 → homedir，posix → cwd）
  return (
    value?.trim() || readBridgeRoot() || (runtimePlatform === 'win32' ? homedir() : process.cwd())
  )
}
