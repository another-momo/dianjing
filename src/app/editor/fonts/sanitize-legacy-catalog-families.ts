import { LEGACY_CN_FAMILY_ALIAS } from '@open-pencil/core/text'

/**
 * 把持久化的 enabled-catalog 清单做一次性字重聚合迁移：
 * - 旧字重拆族族名（如 `LXGW Bright Light`）→ 合并后 base（`LXGW Bright`）；
 * - 现役族名原样保留；
 * - 去重保序。
 *
 * 字重聚合接入：catalog 持久化清单若含旧名，下次启动会被自动映射并写回 localStorage，
 * 避免 picker 关停分支反向漏合并。纯函数，便于单测；watch 内置 immediate 时调用一次。
 */
export function sanitizeLegacyCatalogFamilies(input: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const family of input) {
    const mapped = LEGACY_CN_FAMILY_ALIAS[family] ?? family
    if (!seen.has(mapped)) {
      seen.add(mapped)
      out.push(mapped)
    }
  }
  return out
}
