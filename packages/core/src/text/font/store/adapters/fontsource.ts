/**
 * Fontsource（https://fontsource.org）预设适配器。
 *
 * 实证（2026-10-12，_ops/20261012-fontsource-api-probe/）：
 *   目录：GET {base}/v1/fonts → 数组，每族字段：
 *     id, family, subsets[], weights[], styles[] ('normal'|'italic'),
 *     defSubset, variable, lastModified (YYYY-MM-DD),
 *     license（如 'OFL-1.1'，可能缺失）, version, type, source
 *   详细：GET {base}/v1/fonts/{id} → 多一个 variants map
 *     （{weight:{style:{subset:{url:{woff2,woff,ttf}}}}}）。本适配器不消费详细
 *     ——目录数据足够合成 jsdelivr 直链；详情路径归后续工作做单族精确控制。
 *
 * 合成口径：
 *   - 静态族：fileUrl = https://cdn.jsdelivr.net/fontsource/fonts/{id}@latest/{subset}-{weight}-{style}.woff2
 *   - variable 族：VF 文件在独立 `:vf` 包——fileUrl = .../fonts/{id}:vf@latest/{subset}-wght-{style}.woff2
 *     （实证 2026-10-12：inter:vf 两 style 均 200/font-woff2；variable 族的 per-weight
 *     路径是静态实例文件，标 wghtRange 会让静态实例被当 VF 用，故 variable 族只发
 *     每 styleFlag 一条 VF 条目）
 *   - subset：优先 defSubset，其次 latin，再次 latin-ext，否则 subsets[0]
 *   - ext：只发 woff2（jsdelivr 路径含 woff2/woff/ttf，优先 woff2——端点侧
 *     installBytes 时按需 woff2 → sfnt 转码）
 *   - variable 族：wghtRange = { min: weights[0], max: weights[len-1] }
 *     （上游无 wghtAxis 字段，从 weights 数组派生）
 *   - style 字符串：static（variable=false）按 (weight, italic) 走 'Regular' / 'Bold' /
 *     'Bold Italic'；variable 走 'Variable' / 'Variable Italic'
 *
 * 裁剪：本适配器返回全量族——裁剪归服务端 route 层（控制响应大小；端点侧按
 * catalog 返回后再筛选）。
 */
import { styleLabel } from '#core/text/font/store/style-label'
import type {
  FetchLike,
  StoreAdapter,
  StoreCatalogFamily,
  StoreCatalogStyle
} from '#core/text/font/store/types'

interface FontsourceListItem {
  id?: unknown
  family?: unknown
  subsets?: unknown
  weights?: unknown
  styles?: unknown
  defSubset?: unknown
  variable?: unknown
  lastModified?: unknown
  license?: unknown
  version?: unknown
}

const FORMAT = 'woff2' as const
const CDN_BASE = 'https://cdn.jsdelivr.net/fontsource/fonts'

/** Fontsource 适配器实例——kind=fontsource 服务共用同一实现 */
export const fontsourceAdapter: StoreAdapter = {
  async fetchCatalog(fetchImpl: FetchLike): Promise<StoreCatalogFamily[]> {
    const response = await fetchImpl('https://api.fontsource.org/v1/fonts', {
      signal: AbortSignal.timeout(60_000)
    })
    if (!response.ok) {
      throw new Error(`Fontsource catalog fetch failed: HTTP ${response.status}`)
    }
    const raw = await response.json()
    if (!Array.isArray(raw)) {
      throw new TypeError('Fontsource catalog response is not an array')
    }
    const families: StoreCatalogFamily[] = []
    for (const item of raw) {
      const family = normalizeFamily(item)
      if (family) families.push(family)
    }
    return families
  }
}

function normalizeFamily(item: unknown): StoreCatalogFamily | null {
  if (!item || typeof item !== 'object') return null
  const it = item as FontsourceListItem
  const id = typeof it.id === 'string' && it.id.length > 0 ? it.id : null
  if (!id) return null
  const subsets = asStringArray(it.subsets)
  const weights = asNumberArray(it.weights)
  const styles = asStringArray(it.styles).filter((s) => s === 'normal' || s === 'italic')
  if (subsets.length === 0 || weights.length === 0 || styles.length === 0) return null
  const subset = pickSubset(subsets, asString(it.defSubset))
  const styleEntries = buildStyleEntries(id, subset, weights, styles, it.variable === true)
  if (styleEntries.length === 0) return null
  const familyName = typeof it.family === 'string' && it.family.length > 0 ? it.family : id
  const out: StoreCatalogFamily = {
    family: familyName,
    styles: styleEntries
  }
  applyOptionalMetadata(out, it)
  return out
}

function buildStyleEntries(
  id: string,
  subset: string,
  weights: number[],
  styles: string[],
  variable: boolean
): StoreCatalogStyle[] {
  // VF 族：每 styleFlag 一条 :vf 包 wght 轴条目（per-weight 路径是静态实例，不用）
  if (variable) {
    // 不假设上游 weights 有序——取真值区间
    const wghtRange = { min: Math.min(...weights), max: Math.max(...weights) }
    return styles.map((styleFlag) => {
      const italic = styleFlag === 'italic'
      return {
        style: italic ? 'Variable Italic' : 'Variable',
        weight: 400,
        italic,
        fileURL: `${CDN_BASE}/${id}:vf@latest/${subset}-wght-${italic ? 'italic' : 'normal'}.${FORMAT}`,
        format: FORMAT,
        variable: true,
        wghtRange
      }
    })
  }
  const entries: StoreCatalogStyle[] = []
  for (const weight of weights) {
    for (const styleFlag of styles) {
      const italic = styleFlag === 'italic'
      entries.push({
        style: styleLabel(weight, italic),
        weight,
        italic,
        fileURL: `${CDN_BASE}/${id}@latest/${subset}-${weight}-${italic ? 'italic' : 'normal'}.${FORMAT}`,
        format: FORMAT
      })
    }
  }
  return entries
}

function applyOptionalMetadata(out: StoreCatalogFamily, it: FontsourceListItem): void {
  if (typeof it.license === 'string' && it.license.length > 0) {
    out.license = it.license
  }
  if (typeof it.version === 'string' && it.version.length > 0) {
    out.version = it.version
  }
  if (typeof it.lastModified === 'string' && it.lastModified.length > 0) {
    out.lastModified = it.lastModified
  }
}

function pickSubset(subsets: string[], defSubset: string | null): string {
  if (defSubset && subsets.includes(defSubset)) return defSubset
  if (subsets.includes('latin')) return 'latin'
  if (subsets.includes('latin-ext')) return 'latin-ext'
  return subsets[0]
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
