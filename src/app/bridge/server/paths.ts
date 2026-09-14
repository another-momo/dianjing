import { chmod, mkdir } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'

// 链上文件禁 @/——同走相对路径（与上一行同因）。
// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { resolveAppDataRoot } from '../../orchestration/app-data'
// 本文件经 bridge/vite-plugin.ts 处于 vite.config.ts 加载链上——Storybook/vite
// 配置 loader 不注册 @/ 别名（2026-09-14 CI+dev L3 实证），链上文件禁 @/。
// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { BRIDGE_DIR_NAME_UNIX } from '../../orchestration/brand'
// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { readMCPDiscoveryPathOverride, readMCPSocketPath } from '../../orchestration/env'

/**
 * Platform-specific paths for the automation bridge's Unix domain socket
 * and the discovery JSON file.
 *
 * Discovery file directory layout（D2：与 Electron userData 同位，对齐
 * resolveAppDataRoot 单点）：
 *   macOS:   ~/Library/Application Support/Dianjing/
 *   Linux:   ~/.config/Dianjing/  （resolveAppDataRoot 单源）
 *   Windows: %APPDATA%\Dianjing\  （roaming，对齐 userData；D2 前是 local）
 *
 * Socket directory layout (overridable via DIANJING_MCP_SOCKET):
 *   macOS:   <discovery>/mcp.sock（即 discovery 同目录）
 *   Linux:   $XDG_RUNTIME_DIR/dianjing/mcp.sock  （fallback: <discovery> 同目录）
 *   Windows: N/A — Unix domain sockets 不可用，桥走 TCP only
 *
 * On Windows, Unix domain sockets are unavailable — the server uses TCP only.
 *
 * Discovery file: at the platform-default path above, UNLESS
 * DIANJING_MCP_DISCOVERY_PATH is set (see getDiscoveryPath()). The socket
 * override (DIANJING_MCP_SOCKET) never moves the discovery file — it is
 * recorded in the discovery file's `socketPath` field so clients read it
 * from the well-known location.
 * Socket file:     <socketDir>/mcp.sock  (or the override path)
 *
 * IMPORTANT: getSocketDir() returns the directory that contains the socket
 * file. It does NOT always contain the discovery file — when
 * DIANJING_MCP_SOCKET is set, the discovery file stays at getPlatformDir().
 */

const DIR_NAME_UNIX = BRIDGE_DIR_NAME_UNIX
const SOCKET_FILENAME = 'mcp.sock'
const DISCOVERY_FILENAME = 'mcp.json'

const isMacOS = platform() === 'darwin'
const isWindows = platform() === 'win32'

/**
 * Returns the platform-specific default directory for MCP runtime files,
 * ignoring DIANJING_MCP_SOCKET. The discovery file always lives here so
 * clients can find it at a well-known location regardless of socket overrides.
 * Creates the directory (with restrictive permissions) if it does not exist.
 *
 * The 0o700 mode restricts permissions on Unix. On Windows, mkdir ignores
 * the mode and uses default ACLs — directory access is controlled by the
 * filesystem, not the permission bits.
 */
async function getPlatformDir(): Promise<string> {
  let dir: string

  if (isMacOS) {
    // macOS：resolveAppDataRoot 单源解析（~/Library/Application Support/Dianjing）
    dir = resolveAppDataRoot(process.env, 'darwin')
  } else if (isWindows) {
    // D2：discovery 目录对齐 Electron userData（%APPDATA%/Dianjing，roaming）——
    // 桥进程不再依赖 LOCALAPPDATA（local），改走 APPDATA（roaming）。解析
    // 单源由 resolveAppDataRoot 承担，不再散点拼 LOCALAPPDATA 字面量。
    dir = resolveAppDataRoot(process.env, 'win32')
  } else {
    // Linux / 其他 Unix：discovery 与 userData 同位（~/.config/Dianjing）
    dir = resolveAppDataRoot(process.env, 'linux')
  }

  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (!isWindows) await chmod(dir, 0o700)
  return dir
}

/**
 * Returns the directory for the MCP socket file.
 *
 * When DIANJING_MCP_SOCKET is set, its dirname is used as the socket
 * directory. When unset, the platform default from getPlatformDir() is used.
 * Creates the directory (with restrictive permissions) if it does not exist.
 *
 * NOTE: The discovery file always lives at getPlatformDir(), regardless of
 * DIANJING_MCP_SOCKET. This function should NOT be used to locate it.
 *
 * Linux 特例（D2 保留）：socket 是临时 IPC 端点，规范落点是
 * $XDG_RUNTIME_DIR/dianjing/（tmpfs、随会话生命周期清理）——discovery 文件
 * 留在 getPlatformDir()（~/.config/Dianjing）不动，两者分居；XDG_RUNTIME_DIR
 * 缺失时 socket fallback 到 discovery 同目录。
 */
export async function getSocketDir(): Promise<string> {
  const socketOverride = readMCPSocketPath()

  if (socketOverride) {
    const dir = dirname(socketOverride)
    // Create missing parents with restrictive permissions. Do NOT chmod
    // existing directories — the override path is user-controlled and
    // may be in a shared directory (e.g. /tmp for tests).
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  if (platform() === 'linux') {
    const xdgRuntime = process.env.XDG_RUNTIME_DIR?.trim()
    if (xdgRuntime) {
      const dir = join(xdgRuntime, DIR_NAME_UNIX)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
      return dir
    }
  }

  return getPlatformDir()
}

/**
 * Returns the full path to the MCP Unix domain socket.
 *
 * On macOS/Linux: <socketDir>/mcp.sock
 *
 * When DIANJING_MCP_SOCKET is set, its value is returned directly
 * (no directory resolution needed).
 */
export async function getSocketPath(): Promise<string> {
  const socketOverride = readMCPSocketPath()
  if (socketOverride) {
    // Ensure the override directory exists. getSocketDir() creates the
    // directory for the custom socket path (dirname of the override).
    await getSocketDir()
    return socketOverride
  }

  const dir = await getSocketDir()
  return join(dir, SOCKET_FILENAME)
}

/**
 * Returns the full path to the MCP discovery JSON file.
 *
 * The discovery file lives at the platform-default location so clients can
 * find it without knowing whether DIANJING_MCP_SOCKET is set. It contains
 * the actual socket path (which may be overridden) in its `socketPath` field,
 * so clients read the discovery file to learn where to connect — not the other
 * way around.
 *
 * Set DIANJING_MCP_DISCOVERY_PATH to relocate the discovery file (e.g. to a
 * temp directory for test isolation). The parent directory is created (0o700)
 * so writeDiscoveryFile's atomic temp-then-rename succeeds.
 */
export async function getDiscoveryPath(): Promise<string> {
  const override = readMCPDiscoveryPathOverride()
  if (override) {
    const dir = dirname(override)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return override
  }
  const dir = await getPlatformDir()
  return join(dir, DISCOVERY_FILENAME)
}

/**
 * Returns true if the current platform supports Unix domain sockets.
 * Unix domain sockets are available on macOS, Linux, and other POSIX
 * platforms but not on native Windows. WSL is detected as Linux.
 */
export function platformHasUnixSockets(): boolean {
  return !isWindows
}

/**
 * Returns the platform name for display purposes.
 */
export function platformName(): 'macos' | 'linux' | 'windows' | 'other' {
  if (isMacOS) return 'macos'
  if (isWindows) return 'windows'
  if (platform() === 'linux') return 'linux'
  return 'other'
}
