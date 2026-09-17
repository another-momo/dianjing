import { uniq } from 'es-toolkit/array'

import { ResourceCache } from '#core/cache/resource'
import { DEFAULT_FONT_FAMILY } from '#core/constants'
import { fontManager } from '#core/text/fonts'

const familiesCache = new ResourceCache<string, string[]>({ maxEntries: 256 })

export function resolveParagraphFontFamilies(
  primary: string,
  style: string,
  arabicFallbacks: readonly string[] = fontManager.getArabicFallbackFamilies(),
  cjkFallbacks: readonly string[] = fontManager.getCJKFallbackFamilies()
): string[] {
  const renderPrimary = fontManager.renderFamily(primary, style)
  // CDN 互斥分片各持 alias 注册（同名会塌缩成单 typeface），经回退链合流；
  // alias 随增量加载增长，必须进缓存键
  const renderAliases = fontManager.renderFamilyAliases(primary, style)
  const renderArabicFallbacks = arabicFallbacks.map((family) =>
    fontManager.renderFamily(family, 'Regular')
  )
  const renderCJKFallbacks = cjkFallbacks.map((family) =>
    fontManager.renderFamily(family, 'Regular')
  )
  const key = `${renderPrimary}\0${renderAliases.join('\0')}\0${renderArabicFallbacks.join('\0')}\0${renderCJKFallbacks.join('\0')}`
  const cached = familiesCache.peek(key)
  if (cached) return cached
  const families = [renderPrimary, ...renderAliases]
  if (primary !== DEFAULT_FONT_FAMILY) families.push(DEFAULT_FONT_FAMILY)
  families.push(...renderArabicFallbacks, ...renderCJKFallbacks)
  const resolved = uniq(families)
  familiesCache.set(key, resolved)
  return resolved
}
