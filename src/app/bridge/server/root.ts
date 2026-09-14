import { homedir, platform } from 'node:os'

export function resolveMCPRoot(value: string | undefined, runtimePlatform = platform()): string {
  // OPENPENCIL_MCP_ROOT：sidecar 形态下 cwd 不可依赖时的显式覆盖；
  // 不传时维持现状（win32 → homedir，posix → cwd）
  return (
    value?.trim() ||
    process.env.OPENPENCIL_MCP_ROOT?.trim() ||
    (runtimePlatform === 'win32' ? homedir() : process.cwd())
  )
}
