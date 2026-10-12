/**
 * Google Fonts Web API 兼容适配器（kind='gf-api'）。
 *
 * 形态：GET {base}/webfonts/v1/webfonts?key={apiKey} → { items: GoogleFontsItem[] }。
 * 字段映射：
 *   - variants 解析：'regular' → (400, normal)；'italic' → (400, italic)；
 *     '700' → (700, normal)；'700italic' → (700, italic)。其它数字字重同理。
 *   - files[variant] 即 fileUrl。
 *   - format：URL 扩展名推断（.ttf / .otf / .woff2）——GF API 默认 .ttf。
 *   - axes 不消费：files map 里全是静态实例文件（VF 文件要走 css2 API 另取，
 *     暂不支持）——把静态实例标 variable+wghtRange 会让 App 按 VF 用静态文件，
 *     故一律按静态条目出。
 *   - license 上游不返回 → undefined（UI 展示「授权状态未知」）。
 *
 * 容错：items 非数组 → 返 []；单族缺 variants/files → 跳过；variant 解析失败 → 跳过。
 */
import { styleLabel } from '#core/text/font/store/style-label'
import type {
  FetchLike,
  GoogleFontsItem,
  StoreAdapter,
  StoreCatalogFamily,
  StoreCatalogStyle
} from '#core/text/font/store/types'

export function createGoogleFontsAdapter(baseURL: string, apiKey: string): StoreAdapter {
  const normalized = baseURL.replace(/\/+$/, '')
  const trimmedKey = apiKey.trim()
  return {
    async fetchCatalog(fetchImpl: FetchLike): Promise<StoreCatalogFamily[]> {
      const url = `${normalized}/webfonts/v1/webfonts?key=${encodeURIComponent(trimmedKey)}`
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(60_000)
      })
      if (!response.ok) {
        throw new Error(`GF-API catalog fetch failed: HTTP ${response.status}`)
      }
      const raw = await response.json()
      if (!raw || typeof raw !== 'object') return []
      const r = raw as { items?: unknown }
      if (!Array.isArray(r.items)) return []
      const families: StoreCatalogFamily[] = []
      for (const item of r.items) {
        const family = normalizeItem(item)
        if (family) families.push(family)
      }
      return families
    }
  }
}

function normalizeItem(raw: unknown): StoreCatalogFamily | null {
  if (!raw || typeof raw !== 'object') return null
  const it = raw as GoogleFontsItem
  if (typeof it.family !== 'string' || it.family.length === 0) return null
  if (!Array.isArray(it.variants)) return null
  if (!it.files || typeof it.files !== 'object') return null
  const styles: StoreCatalogStyle[] = []
  const files = it.files
  for (const variant of it.variants) {
    if (typeof variant !== 'string') continue
    const fileURL = files[variant]
    if (typeof fileURL !== 'string' || fileURL.length === 0) continue
    const parsed = parseVariant(variant)
    if (!parsed) continue
    const format = inferFormat(fileURL)
    styles.push({
      style: styleLabel(parsed.weight, parsed.italic),
      weight: parsed.weight,
      italic: parsed.italic,
      fileURL,
      format
    })
  }
  if (styles.length === 0) return null
  const out: StoreCatalogFamily = {
    family: it.family,
    styles
  }
  return out
}

function parseVariant(variant: string): { weight: number; italic: boolean } | null {
  if (variant === 'regular') return { weight: 400, italic: false }
  if (variant === 'italic') return { weight: 400, italic: true }
  if (variant.endsWith('italic')) {
    const digits = variant.slice(0, -'italic'.length)
    const weight = Number.parseInt(digits, 10)
    if (Number.isFinite(weight) && weight > 0) return { weight, italic: true }
    return null
  }
  const weight = Number.parseInt(variant, 10)
  if (Number.isFinite(weight) && weight > 0) return { weight, italic: false }
  return null
}

function inferFormat(url: string): 'ttf' | 'otf' | 'woff2' {
  const lower = url.toLowerCase()
  if (lower.endsWith('.woff2')) return 'woff2'
  if (lower.endsWith('.otf')) return 'otf'
  return 'ttf'
}
