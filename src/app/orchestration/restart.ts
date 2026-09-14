/**
 * T27 退避纯函数：崩溃自动复活的有限次退避表。
 * 移植自 src/app/ai/pi-backend/vite-plugin.ts 与 desktop-electron/main/main.ts
 * 的同源常量——三处共享以防漂移（实测一票同源升级由此保证）。
 */

export const MAX_AUTO_RESTARTS = 3

export const RESTART_BACKOFF_MS = [500, 1_500, 4_000] as const

/**
 * 给定当前连续崩溃计数，返回下一次退避延迟（毫秒）。
 * - count < MAX_AUTO_RESTARTS：返回 RESTART_BACKOFF_MS[count]（首翻 500）
 * - count >= MAX_AUTO_RESTARTS：返回 null（调用方应停手并给明确指引）
 */
export function nextRestartDelay(count: number): number | null {
  if (count < 0 || count >= MAX_AUTO_RESTARTS) return null
  return RESTART_BACKOFF_MS[count]
}
