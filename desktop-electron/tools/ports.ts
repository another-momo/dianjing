/**
 * Electron 端口自举——从 desktop-electron/main/main.ts 抽出，smoke 脚本同源
 * 复用。三份内联拷贝收敛到一处（main.ts:62-87、electron-full-smoke.ts:54、
 * sidecar-smoke.ts:51）。
 *
 * 端口段：20000-49000（避免碰主战场 1420/7600/7700/1420——后两个是
 * pi-backend / automation bridge 的默认端口）。失败兜底 27900 是「1/8 概率
 * 命中」的几何期望值，与 main.ts 同款；smoke 脚本因循环 32 次尝试基本不会
 * 走到兜底。
 */

import { createServer } from 'node:net'

const MIN_PORT = 20000
const MAX_PORT = 49000
const MAX_RANDOM_ATTEMPTS = 8
const PROBE_BIND_ATTEMPTS = 32
const FORBIDDEN_PORTS: readonly number[] = [1420, 7600, 7700]
const FALLBACK_PORT = 27900

/**
 * 在 20000-49000 段随机一个非 1420/7600/7700 的端口。最多 8 次重试；仍命中
 * 禁止端口则回退 27900（极罕见——概率 (3/29000)^8 ≈ 10^-31）。
 */
export function randomPort(): number {
  for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
    const candidate = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT))
    if (!FORBIDDEN_PORTS.includes(candidate)) return candidate
  }
  return FALLBACK_PORT
}

/**
 * 探测一个真空闲端口（probe-bind 再 close）。32 次尝试，每次随机端口——
 * 让回环服务能确定性地 listen 在已知端口（给 sidecar CORS origin 用）。
 */
export async function pickFreePort(): Promise<number> {
  for (let attempt = 0; attempt < PROBE_BIND_ATTEMPTS; attempt++) {
    const candidate = randomPort()
    const ok = await new Promise<boolean>((resolveProbe) => {
      const probe = createServer()
      probe.once('error', () => resolveProbe(false))
      probe.listen(candidate, '127.0.0.1', () => {
        probe.close(() => resolveProbe(true))
      })
    })
    if (ok) return candidate
  }
  throw new Error('无可用空闲端口（20000-49000 段已耗尽）')
}
