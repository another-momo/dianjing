/**
 * 中文网字计划（@chinese-fonts/*）商店适配器。
 *
 * 零网络：直接读 core 端 FONT_REGISTRY（source='cdn' 精选层）+ CN_FONT_CATALOG
 * （全量目录）合成 StoreCatalogFamily[]。撞名让 registry 胜（与 listFamilyOptions
 * 既有口径一致）；别名族（LEGACY_CN_FAMILY_ALIAS 目标）去重——目标族已存在则
 * 别名不重复发。
 *
 * style 合成：
 *  - 静态族：每个 weight 一条 StoreCatalogStyle，fileURL 置空串，piecesRef
 *    = 族 descriptor（与 registry CnFontCdnDescriptor 同型）
 *  - 变量族（registry variable:true / catalog variable:true）：单条 variable 条目
 *    覆盖整族 wght 区间，wghtRange 由 weights 真值区间派生（不假设有序）
 *  - format 标 'woff2'（cn-font-split 默认输出 woff2，piece 端点按内容嗅探
 *    决定是否转码——format 仅作安装管线提示，piece URL 的 .woff2 后缀是真信号）
 *
 * 实施依据：registry 精选层与 catalog 全量目录的合并顺序为「registry 先、catalog
 * 兜底」（与 listFamilyOptions 现有口径一致）；内置预设 baseURL = jsdelivr。
 */
import { CN_FONT_CATALOG } from '#core/text/font/cn-catalog'
import type { CnFontCatalogEntry } from '#core/text/font/cn-catalog'
import { FONT_REGISTRY } from '#core/text/font/registry'
import type { CnFontCdnDescriptor, FontRegistryEntry } from '#core/text/font/registry'
import { styleLabel } from '#core/text/font/store/style-label'
import type {
  StoreAdapter,
  StoreCatalogFamily,
  StoreCatalogStyle
} from '#core/text/font/store/types'

const VARIABLE_STYLE_LABEL = 'Variable'
const VARIABLE_ITALIC_STYLE_LABEL = 'Variable Italic'

/** catalog 条目 → descriptor：catalog 字段形态（package/version/base）映射为 descriptor */
function catalogToDescriptor(entry: CnFontCatalogEntry): CnFontCdnDescriptor {
  const descriptor: CnFontCdnDescriptor = {
    package: entry.package,
    version: entry.version
  }
  if (entry.base) descriptor.baseURL = entry.base
  return descriptor
}

/** registry 条目 → descriptor：cdn 字段直用 */
function registryToDescriptor(entry: FontRegistryEntry): CnFontCdnDescriptor | null {
  if (!entry.cdn) return null
  // 不可变只读——直传同型
  return entry.cdn
}

function buildStyleEntryForWeight(
  weight: number,
  italic: boolean,
  descriptor: CnFontCdnDescriptor
): StoreCatalogStyle {
  return {
    style: styleLabel(weight, italic),
    weight,
    italic,
    fileURL: '',
    format: 'woff2',
    piecesRef: descriptor
  }
}

function buildVariableEntry(
  descriptor: CnFontCdnDescriptor,
  italic: boolean,
  weights: readonly number[]
): StoreCatalogStyle {
  // 不假设上游 weights 有序——取真值区间
  const wghtRange = { min: Math.min(...weights), max: Math.max(...weights) }
  return {
    style: italic ? VARIABLE_ITALIC_STYLE_LABEL : VARIABLE_STYLE_LABEL,
    weight: 400,
    italic,
    fileURL: '',
    format: 'woff2',
    variable: true,
    wghtRange,
    piecesRef: descriptor
  }
}

function buildRegistryFamily(entry: FontRegistryEntry): StoreCatalogFamily | null {
  const descriptor = registryToDescriptor(entry)
  if (!descriptor) return null
  // VF 族：weights 数组通常为空（registry 标注法），单条 variable 条目覆盖整族
  if (entry.variable) {
    const wghts: number[] = entry.weights.length > 0 ? weightsToNumbers(entry.weights) : [400]
    return {
      family: entry.family,
      styles: [buildVariableEntry(descriptor, false, wghts)]
    }
  }
  // 静态族：每个 weight × (normal/italic) 出一条；registry.weights 是 style 名
  // （如 'Regular' / 'Bold'）——styleToWeight 派生数值。cn-font 子族目录名 = style
  // 派生（Light/Regular/Medium/Bold），同款 style 名集合与字重数对应。
  const numericWeights = weightsToNumbers(entry.weights)
  if (numericWeights.length === 0) return null
  const styles: StoreCatalogStyle[] = []
  for (const weight of numericWeights) {
    styles.push(buildStyleEntryForWeight(weight, false, descriptor))
  }
  const out: StoreCatalogFamily = { family: entry.family, styles }
  if (entry.displayName) out.displayName = entry.displayName
  if (entry.license) out.license = entry.license
  return out
}

function weightsToNumbers(styles: readonly string[]): number[] {
  const WEIGHT_BY_NAME: Record<string, number> = {
    Thin: 100,
    ExtraLight: 200,
    Light: 300,
    Regular: 400,
    Normal: 400,
    Medium: 500,
    SemiBold: 600,
    Bold: 700,
    ExtraBold: 800,
    Black: 900
  }
  const out: number[] = []
  for (const style of styles) {
    const w = WEIGHT_BY_NAME[style]
    if (typeof w === 'number') out.push(w)
  }
  return out
}

function buildCatalogFamily(entry: CnFontCatalogEntry): StoreCatalogFamily {
  const descriptor = catalogToDescriptor(entry)
  if (entry.variable) {
    // catalog.weights 在 VF 场景下为区间端点（[min, max]），作真值区间用
    return {
      family: entry.family,
      styles: [buildVariableEntry(descriptor, false, entry.weights)]
    }
  }
  const styles: StoreCatalogStyle[] = []
  for (const weight of entry.weights) {
    styles.push(buildStyleEntryForWeight(weight, false, descriptor))
  }
  const out: StoreCatalogFamily = { family: entry.family, styles }
  if (entry.displayName) out.displayName = entry.displayName
  out.license = entry.license
  return out
}

/** 中文网字计划内置适配器：零网络合成全量目录 */
export const cnFontsAdapter: StoreAdapter = {
  async fetchCatalog(_fetchImpl): Promise<StoreCatalogFamily[]> {
    const families: StoreCatalogFamily[] = []
    const seen = new Set<string>()
    // registry 精选层先行（撞名胜出——与 listFamilyOptions 既有口径一致）
    for (const entry of FONT_REGISTRY) {
      if (entry.source !== 'cdn') continue
      const family = buildRegistryFamily(entry)
      if (!family) continue
      families.push(family)
      seen.add(family.family)
    }
    // catalog 全量目录兜底（catalog 条目本身就是规范族名；别名源不在 CN_FONT_CATALOG 内）
    for (const entry of CN_FONT_CATALOG) {
      if (seen.has(entry.family)) continue
      families.push(buildCatalogFamily(entry))
      seen.add(entry.family)
    }
    return families
  }
}
