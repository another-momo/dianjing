/**
 * 标准契约适配器（kind='standard'）。
 *
 * 形态：GET {baseURL}/catalog.json → { families: StoreCatalogFamily[] }。
 * 字段直序——每个 style 必填 fileURL/format/weight/italic/style 串；坏条目
 * 跳过（不抛、不阻断整目录）。
 *
 * 容错：
 *   - 顶层非对象 / families 非数组 → 返 []
 *   - 单族缺 family 或 styles 非数组 → 跳过
 *   - 单 style 缺 fileURL/format/weight/style → 跳过（不抛）
 */
import type {
  FetchLike,
  StandardCatalogFile,
  StoreAdapter,
  StoreCatalogFamily
} from '#core/text/font/store/types'

export function createStandardAdapter(baseURL: string): StoreAdapter {
  const normalized = baseURL.replace(/\/+$/, '')
  return {
    async fetchCatalog(fetchImpl: FetchLike): Promise<StoreCatalogFamily[]> {
      const response = await fetchImpl(`${normalized}/catalog.json`, {
        signal: AbortSignal.timeout(60_000)
      })
      if (!response.ok) {
        throw new Error(`Catalog fetch failed: HTTP ${response.status}`)
      }
      const raw = await response.json()
      const parsed = normalizeCatalogFile(raw)
      return parsed.families
    }
  }
}

export function normalizeCatalogFile(raw: unknown): StandardCatalogFile {
  if (!raw || typeof raw !== 'object') return { families: [] }
  const r = raw as { families?: unknown }
  if (!Array.isArray(r.families)) return { families: [] }
  const families: StoreCatalogFamily[] = []
  for (const item of r.families) {
    const family = normalizeFamily(item)
    if (family) families.push(family)
  }
  return { families }
}

/** catalog.json 单族未校验入线形态（字段逐一 typeof 校验后才采信） */
interface RawFamilyShape {
  family?: unknown
  displayName?: unknown
  license?: unknown
  version?: unknown
  lastModified?: unknown
  styles?: unknown
}

function normalizeFamily(raw: unknown): StoreCatalogFamily | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as RawFamilyShape
  if (typeof r.family !== 'string' || r.family.length === 0) return null
  if (!Array.isArray(r.styles)) return null
  const styles = []
  for (const item of r.styles) {
    const style = normalizeStyle(item)
    if (style) styles.push(style)
  }
  if (styles.length === 0) return null
  const out: StoreCatalogFamily = {
    family: r.family,
    styles
  }
  if (typeof r.displayName === 'string' && r.displayName.length > 0) {
    out.displayName = r.displayName
  }
  if (typeof r.license === 'string' && r.license.length > 0) {
    out.license = r.license
  }
  if (typeof r.version === 'string' && r.version.length > 0) {
    out.version = r.version
  }
  if (typeof r.lastModified === 'string' && r.lastModified.length > 0) {
    out.lastModified = r.lastModified
  }
  return out
}

/** catalog.json 单 style 未校验入线形态 */
interface RawStyleShape {
  style?: unknown
  fileURL?: unknown
  format?: unknown
  weight?: unknown
  italic?: unknown
  variable?: unknown
  wghtRange?: unknown
}

function normalizeStyle(raw: unknown): StoreCatalogFamily['styles'][number] | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as RawStyleShape
  if (typeof r.style !== 'string' || r.style.length === 0) return null
  if (typeof r.fileURL !== 'string' || r.fileURL.length === 0) return null
  if (r.format !== 'ttf' && r.format !== 'otf' && r.format !== 'woff2') return null
  if (typeof r.weight !== 'number' || !Number.isFinite(r.weight)) return null
  const out: StoreCatalogFamily['styles'][number] = {
    style: r.style,
    weight: r.weight,
    italic: r.italic === true,
    fileURL: r.fileURL,
    format: r.format
  }
  if (r.variable === true) {
    out.variable = true
    const range = normalizeWghtRange(r.wghtRange)
    if (range) out.wghtRange = range
  }
  return out
}

function normalizeWghtRange(raw: unknown): { min: number; max: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { min?: unknown; max?: unknown }
  if (typeof r.min !== 'number' || !Number.isFinite(r.min)) return null
  if (typeof r.max !== 'number' || !Number.isFinite(r.max)) return null
  if (r.max < r.min) return null
  return { min: r.min, max: r.max }
}
