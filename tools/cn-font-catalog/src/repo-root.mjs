import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 向上走到仓根（含 bun.lock 的目录）——lint 禁 import.meta 起两级以上
 * 字面值攀爬（no-deep-parent-relative-paths），各脚本统一走此 helper。
 */
export function repoRoot(from = dirname(fileURLToPath(import.meta.url))) {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'bun.lock'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`workspace root not found from ${from}`)
    dir = parent
  }
}
