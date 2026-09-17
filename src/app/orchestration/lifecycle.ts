import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { READY_MARKER_PREFIX } from './brand'

/**
 * 子进程编排共享件——三个薄壳（bridge vite 插件、pi-backend vite 插件、
 * pi-backend host.ts）原本各自内联同一形态的 stopChild/stderr 透传/ready
 * marker 推导，本文件收敛为可复用纯函数。
 *
 * 边界：本模块面向 node:child_process 的 ChildProcess；Electron main.ts 的
 * utilityProcess.fork 类型不同（无 exitCode、kill 不接 signal、需 taskkill
 * Windows 兜底），留在 main.ts 不进本文件。
 */

const DEFAULT_STOP_TIMEOUT_MS = 2_000
const POLL_INTERVAL_MS = 50

/**
 * 优雅停止：kill + 轮询等 exitCode !== null，超时 SIGKILL 兜底。
 *
 * 行为对齐 src/app/ai/pi-backend/vite-plugin.ts:75 stopChild：
 *  - 已经退出的子进程（exitCode !== null）直接返回
 *  - kill() 后每 50ms 轮询一次（不挂事件——直接读 exitCode 避免 type-aware
 *    lint 把循环比较判「不可能」，函数调用每次取实时值）
 *  - 2s 内未退出则 SIGKILL
 *  - 不负责 console 日志——调用方按需打印 label（host.ts 需要，bridge/pi-backend
 *    不需要，差异即规格）
 */
export async function stopChildGracefully(
  child: ChildProcess | null,
  options: { timeoutMs?: number } = {}
): Promise<void> {
  if (!child) return
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const hasExited = (): boolean => child.exitCode !== null
  if (hasExited()) return
  child.kill()
  const deadline = Date.now() + timeoutMs
  while (!hasExited() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS)
    })
  }
  if (!hasExited()) child.kill('SIGKILL')
}

export interface AttachStderrPassthroughOptions {
  /** stderr 流被「桥接管」时打的标签——日志可定位（host.ts 已用「自动化桥」/「pi 后端」） */
  label?: string
  /**
   * EADDRINUSE 命中回调：调用方按自己的文案与 kill 策略处理
   * （bridge 红字英文 + 自动 kill、host 中文 + kill、pi-backend 透传）。
   * 不传则 EADDRINUSE 也按纯透传处理。
   */
  onEaddrinuse?: (chunk: string) => void
}

/**
 * 挂 stderr 'data' 监听：默认 process.stderr.write 透传；可选 EADDRINUSE 回调。
 *
 * 行为对齐 src/app/bridge/vite-plugin.ts:152 与 src/app/ai/pi-backend/host.ts:60
 * 的同源 passthrough 形态——EADDRINUSE 检测是唯一的形态差异点，故作回调注入。
 */
export function attachStderrPassthrough(
  child: Pick<ChildProcess, 'stderr' | 'kill'>,
  options: AttachStderrPassthroughOptions = {}
): void {
  if (!child.stderr) return
  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString()
    if (text.includes('EADDRINUSE') && options.onEaddrinuse) {
      options.onEaddrinuse(text)
      return
    }
    process.stderr.write(data)
  })
}

/**
 * 构造 ready marker——前缀 `dianjing-ready:` + randomUUID。
 *
 * 行为对齐 src/app/bridge/vite-plugin.ts:129 的内联拼装：
 *   `dianjing-ready:${randomUUID()}`
 * 由 child-ready.ts 的 waitForChildReady 解析（marker 串写入 DIANJING_BRIDGE_READY_MARKER
 * 后写入子进程 stderr，父进程按 marker 判定子进程就绪）。
 */
export function makeReadyMarker(): string {
  return `${READY_MARKER_PREFIX}${randomUUID()}`
}
