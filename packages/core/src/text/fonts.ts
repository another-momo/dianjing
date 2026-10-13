/* eslint-disable max-lines -- font loading and registration share FontManager lifecycle state */

import type { CanvasKit, TypefaceFontProvider } from 'canvaskit-wasm'

import type { FontVariation, SceneGraph } from '@open-pencil/scene-graph'

import { IS_BROWSER } from '#core/constants'
import { parseFontStyle } from '#core/text/face'
import { FontMemoryLedger } from '#core/text/font/memory'
import type { FontMemoryStats } from '#core/text/font/memory'
import { FONT_REGISTRY, isBundledFamilyAllowed } from '#core/text/font/registry'
import { styleToWeight, weightToStyle } from '#core/text/font/style'
import { FULL_WEIGHT_RANGE, sniffVariableFont } from '#core/text/font/variable'
import { namedInstanceVariations } from '#core/text/font/variation'
import { formatUnicodeRanges } from '#core/text/web-font/cn-fonts'

export * from '#core/text/font/cn-catalog'
export * from '#core/text/font/sources'
export * from '#core/text/font/style'
export * from '#core/text/font/memory'
export * from '#core/text/font/variable'
export { fontFamilyDisplayName, fontRegistryEntry } from '#core/text/font/registry'
export * from '#core/text/font/variation'
import type { FontFallbackScript } from '#core/text/fallbacks'
import type { FontFamilyOption, FontLoadedSource, UserFontProvider } from '#core/text/font/sources'
import { collectGraphFontKeys } from '#core/text/requirements'

type WeightRange = { min: number; max: number }

/** bundled 字体清单：键 = 'Family|Style'，值 = public/ 与 assets/ 双份同名路径。 */
const BUNDLED_FONTS: Record<string, string> = {
  'Inter|Regular': '/Inter-Regular.ttf',
  'Inter|Medium': '/Inter-Medium.ttf',
  'Inter|SemiBold': '/Inter-SemiBold.ttf',
  'Inter|Bold': '/Inter-Bold.ttf',
  'Inter|ExtraBold': '/Inter-ExtraBold.ttf',
  'Noto Naskh Arabic|Regular': '/NotoNaskhArabic-Regular.ttf'
}

// Alibaba PuHuiTi 9 字重（T39，CJK 312）：从注册表派生避免双源漂移。
for (const weight of FONT_REGISTRY.find((e) => e.family === 'Alibaba PuHuiTi')?.weights ?? []) {
  BUNDLED_FONTS[`Alibaba PuHuiTi|${weight}`] = `/AlibabaPuHuiTi-${weight}.ttf`
}

/**
 * 应用字体库（用户安装）族视图的 style 键匹配：精确命中 → weight+italic 派生
 * 两级回退（manifest 端 styleKey 与 caller style 名异构场景下走派生通道）。
 * 命中返回 manifest 端 key 供 read 用；未命中返 null。
 */
function matchUserStyleKey(
  view: { styles: { key: string; weight: number; italic: boolean; variable: boolean }[] },
  callerStyle: string
): string | null {
  for (const s of view.styles) {
    if (s.key === callerStyle) return s.key
  }
  const requested = parseFontStyle(callerStyle)
  for (const s of view.styles) {
    if (s.weight === requested.weight && s.italic === requested.italic) return s.key
  }
  return null
}

/**
 * JS 侧字体字节默认预算：安全气囊式上限（原 50MB 常态逐出会放大逐出-重载循环，
 * 复测轮实证）。日常用量远低于此值，逐出仅作收割闲置键的兜底动作，不作常态治理；
 * CanvasKit 无法注销已注册 typeface，WASM 侧残留 2-10MB 属预期；逐出键会联动
 * fontResolver.reset（见 onFontEvicted），下次引用时经 demand 链重载。
 */
export const DEFAULT_FONT_MEMORY_BUDGET = 512 * 1024 * 1024

/**
 * 分片 alias 分隔符（T40 修复）：CanvasKit TypefaceFontProvider 对同一
 * family 名只保留单个 style 匹配 typeface，互斥覆盖的分片挂同名会塌缩成「只有一片有字形」。
 * 每片各持别名注册，排版时经 fontFamilies 回退链合流（probe 实证：18/18 glyph、0 notdef）。
 */
const FONT_ALIAS_SEPARATOR = '\u001F'

interface RenderAliasEntry {
  url: string
  alias: string
  data: ArrayBuffer
}

export class FontManager {
  private loadedFamilies = new Map<string, ArrayBuffer>()
  private loadedFamilySources = new Map<string, FontLoadedSource>()
  private supplementalFamilyData = new Map<string, ArrayBuffer[]>()
  private remoteCoverage = new Map<string, Set<string>>()
  private instanceVariations = new WeakMap<ArrayBuffer, Map<string, FontVariation[] | null>>()
  private blockedNodeIds = new Set<string>()
  private fontProvider: TypefaceFontProvider | null = null
  private fontProviders = new Set<TypefaceFontProvider>()
  private providerCanvasKits = new WeakMap<TypefaceFontProvider, CanvasKit>()
  private registrationGeneration = 0
  private providerRegistrations = new WeakMap<TypefaceFontProvider, Map<string, Set<ArrayBuffer>>>()
  /** 同一 ArrayBuffer 的内容哈希缓存（fontContentHash 的快路径） */
  private fontDataHashes = new WeakMap<ArrayBuffer, string>()
  /** 按 provider × 家族的内容哈希注册表——逐出→重载同字节的复用判据（见 registerFontInProvider） */
  private providerRegistrationHashes = new WeakMap<TypefaceFontProvider, Map<string, Set<string>>>()
  private cjkFallbackFamilies: string[] = []
  private cjkFallbackPromise: Promise<string[]> | null = null
  private arabicFallbackFamilies: string[] = []
  private arabicFallbackPromise: Promise<string[]> | null = null
  private readonly fontMemory = new FontMemoryLedger()
  private fontMemoryBudget = DEFAULT_FONT_MEMORY_BUDGET
  private fontEvictions = 0
  private browserFontFaces = new Map<string, FontFace[]>()
  private fontEvictListener: ((family: string, style: string) => void) | null = null
  /** 分片 alias 注册表：键 = 'Family|Style'（与 FontManager 注册键一致），条目按
   * 注册顺序（alias 序即回退链序）。用户安装 subset-collection 路径
   * （readSubsetPieces）共用同一张表——user 键同样登记 alias。 */
  private renderAliasFamilies = new Map<string, RenderAliasEntry[]>()
  /** T41：VF 入账跟踪——键级 fvar 嗅探（woff2 压缩流读不出区间时记 null，用全区间兜底） */
  private variableFontKeys = new Set<string>()
  private variableWeightRanges = new Map<string, WeightRange | null>()
  /**
   * 应用字体库（用户安装）提供者：list/read 注入；core 域不直接访问 HTTP，
   * 由 app 层把 client-fonts 适配为该接口。注入时机晚于构造（首调 list/read
   * 时读快照），便于 app 启动时按需绑定。
   */
  private userFontProvider: UserFontProvider | null = null

  attachProvider(canvasKit: CanvasKit, provider: TypefaceFontProvider): void {
    this.fontProviders.add(provider)
    this.providerCanvasKits.set(provider, canvasKit)
    this.fontProvider = provider
    this.providerRegistrations.set(provider, new Map())
    this.registrationGeneration++
    for (const [cacheKey, data] of this.loadedFamilies) {
      const separator = cacheKey.indexOf('|')
      const family = cacheKey.slice(0, separator)
      this.registerFontInProvider(provider, family, data)
      const aliases = this.renderAliasFamilies.get(cacheKey)
      if (aliases) {
        // 分片键：补充片（互斥覆盖的分片）挂同名会塌缩，只回放 alias 注册
        for (const entry of aliases) this.registerFontInProvider(provider, entry.alias, entry.data)
        continue
      }
      for (const supplemental of this.supplementalFamilyData.get(cacheKey) ?? []) {
        this.registerFontInProvider(provider, family, supplemental)
      }
    }
  }

  detachProvider(provider?: TypefaceFontProvider | null): void {
    if (!provider) {
      this.fontProviders.clear()
      this.fontProvider = null
      this.providerRegistrations = new WeakMap()
      this.providerRegistrationHashes = new WeakMap()
      return
    }
    this.fontProviders.delete(provider)
    this.providerRegistrations.delete(provider)
    this.providerRegistrationHashes.delete(provider)
    if (this.fontProvider === provider) {
      this.fontProvider = Array.from(this.fontProviders).at(-1) ?? null
    }
  }

  provider(): TypefaceFontProvider | null {
    return this.fontProvider
  }

  /** The latest attached provider made by `canvasKit`; another build's provider cannot shape with it. */
  providerFor(canvasKit: CanvasKit): TypefaceFontProvider | null {
    return (
      Array.from(this.fontProviders)
        .reverse()
        .find((provider) => this.providerCanvasKits.get(provider) === canvasKit) ?? null
    )
  }

  generation(): number {
    return this.registrationGeneration
  }

  /** WASM 侧注册字节合计（跨全部 provider）——逐出只释放 JS 侧，注册进 provider 的字节不卸载；测试与诊断的观测口。 */
  providerRegisteredBytes(): number {
    return this.collectProviderRegistrationTotals().bytes
  }

  private collectProviderRegistrationTotals(): { families: number; pieces: number; bytes: number } {
    let families = 0
    let pieces = 0
    let bytes = 0
    for (const provider of this.fontProviders) {
      const registrations = this.providerRegistrations.get(provider)
      if (!registrations) continue
      for (const dataSet of registrations.values()) {
        families++
        for (const data of dataSet) {
          pieces++
          bytes += data.byteLength
        }
      }
    }
    return { families, pieces, bytes }
  }

  blockNodesUntilFontsResolve(nodeIds: readonly string[]): void {
    for (const nodeId of nodeIds) this.blockedNodeIds.add(nodeId)
  }

  unblockNodes(nodeIds: readonly string[]): void {
    for (const nodeId of nodeIds) this.blockedNodeIds.delete(nodeId)
  }

  isNodeBlocked(nodeId: string): boolean {
    return this.blockedNodeIds.has(nodeId)
  }

  setFontMemoryBudget(bytes: number): void {
    this.fontMemoryBudget = Math.max(0, Math.floor(bytes))
    this.enforceFontMemoryBudget()
  }

  /** 逐出联动挂钩（T40 S1）：由 resolver/index.ts 注册，逐出时复位对应 demand 键。 */
  onFontEvicted(listener: ((family: string, style: string) => void) | null): void {
    this.fontEvictListener = listener
  }

  fontMemoryStats(): FontMemoryStats {
    return {
      budgetBytes: this.fontMemoryBudget,
      loadedBytes: this.fontMemory.totalBytes(),
      entries: this.fontMemory.size(),
      evictions: this.fontEvictions,
      overBudgetKeys: this.fontMemory.overBudgetKeys(this.fontMemoryBudget)
    }
  }

  /** 手动逐出某家族字重（释放 JS 引用；下次引用时经 demand 链重载）。 */
  evictFont(family: string, style = 'Regular'): boolean {
    const key = `${family}|${style}`
    if (!this.loadedFamilies.has(key)) return false
    this.evictFontKey(key)
    return true
  }

  /**
   * 注入应用字体库（用户安装）提供者；null = 关停该来源。
   * 与其他 set* 注入惯例一致——构造期不接 IO，app 层启动时按需绑定。
   */
  setUserFontProvider(provider: UserFontProvider | null): void {
    this.userFontProvider = provider
  }

  // —— T41 可变字体（D-b 收口）——

  /** 家族是否已加载可变字体（canvas/text 排版期 wght 轴注入的判定依据） */
  isVariableFamily(family: string): boolean {
    for (const key of this.variableFontKeys) {
      if (key.startsWith(`${family}|`)) return true
    }
    return false
  }

  /** VF 家族 wght 轴区间；非 VF 返回 null；fvar 读不出区间（woff2 压缩流）回全区间 */
  variableWeightRange(family: string): WeightRange | null {
    if (!this.isVariableFamily(family)) return null
    for (const key of this.variableFontKeys) {
      if (!key.startsWith(`${family}|`)) continue
      return (
        this.variableWeightRanges.get(key) ?? {
          min: FULL_WEIGHT_RANGE.min,
          max: FULL_WEIGHT_RANGE.max
        }
      )
    }
    return { min: FULL_WEIGHT_RANGE.min, max: FULL_WEIGHT_RANGE.max }
  }

  async listFamilies(): Promise<string[]> {
    const options = await this.listFamilyOptions()
    return options.map((option) => option.family)
  }

  async listFamilyOptions(): Promise<FontFamilyOption[]> {
    const byFamily = new Map<string, FontFamilyOption>()
    this.collectRegistryOptions(byFamily)
    await this.collectUserFontProviderOptions(byFamily)
    return [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family))
  }

  /**
   * bundled 家族枚举：FONT_REGISTRY 中 source='bundled' 的族。CDN 段随中文网字计划
   * 整面退役一并消失（4b 后中网族经商店落地为 user 源，fonts.ts 不再枚举 cdn）。
   */
  private collectRegistryOptions(byFamily: Map<string, FontFamilyOption>): void {
    for (const entry of FONT_REGISTRY) {
      if (entry.source !== 'bundled') continue
      byFamily.set(entry.family, { family: entry.family, source: 'bundled' })
    }
  }

  async fetchBundledFont(url: string): Promise<ArrayBuffer | null> {
    if (IS_BROWSER) {
      const response = await fetch(url)
      return response.arrayBuffer()
    }
    const { readFile } = await import(/* @vite-ignore */ 'node:fs/promises')
    const { resolve, dirname } = await import(/* @vite-ignore */ 'node:path')
    const { fileURLToPath } = await import(/* @vite-ignore */ 'node:url')
    const packageJSONURL = import.meta.resolve('@open-pencil/core/package.json')
    const packageRoot = dirname(fileURLToPath(packageJSONURL))
    const assetPath = resolve(packageRoot, `assets${url}`)
    const buf = await readFile(assetPath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }

  async loadLocalFont(
    family: string,
    style = 'Regular',
    characters = ''
  ): Promise<ArrayBuffer | null> {
    const cacheKey = `${family}|${style}`
    const loaded = this.loadedFamilies.get(cacheKey)
    if (loaded) {
      this.registerFontInCanvasKit(family, loaded)
      return loaded
    }

    // 应用字体库（用户安装）段：注入存在时按 style 键匹配取字节。失败静默——不阻断
    // bundled 兜底链路。subset-collection 族走专属通路（read 端点返 501；本段优先试
    // readSubsetPieces 端点侧 pieces/piece 通路）。
    if (this.userFontProvider) {
      const userBuffer = await this.tryLoadFromUserFontProvider(family, style, characters)
      if (userBuffer) return userBuffer
    }

    const bundledURL = BUNDLED_FONTS[cacheKey]
    if (!bundledURL) return null
    if (!isBundledFamilyAllowed(family)) {
      console.warn(`Bundled font "${family}" is not in the font registry allowlist`)
      return null
    }
    try {
      // T41 D-b：bundled 不再排除可变字体（fvar 嗅探在 registerAndCache 入账时完成）
      const buffer = await this.fetchBundledFont(bundledURL)
      return buffer ? this.registerAndCache(family, style, buffer, 'bundled') : null
    } catch (e) {
      console.warn(`Bundled font load failed for "${family}" ${style}:`, e)
      return null
    }
  }

  async loadFont(
    family: string,
    style = 'Regular',
    characters = '',
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    signal?.throwIfAborted()
    const loaded = this.loadedData(family, style)
    if (loaded) {
      this.registerFontInCanvasKit(family, loaded)
      // 增量补片：用户安装 subset 族的 remoteCoverage 账缺请求字符时，重跑用户
      // 分片链（registerCnFontPieces 按 url 去重，仅未拉过的片真正入网）。
      const coverage = this.remoteCoverage.get(`${family}|${style}`)
      const missingCoverage = Boolean(
        characters &&
        coverage &&
        Array.from(characters).some((character) => !coverage.has(character))
      )
      if (!missingCoverage) return loaded
      return (await this.tryLoadFromUserFontProvider(family, style, characters)) ?? loaded
    }

    return this.loadLocalFont(family, style, characters)
  }

  async ensureNodeFont(family: string, weight: number): Promise<void> {
    await this.loadFont(family, weightToStyle(weight))
  }

  markLoaded(
    family: string,
    style: string,
    data: ArrayBuffer,
    source: FontLoadedSource = 'registered'
  ): void {
    this.registerAndCache(family, style, data, source)
  }

  loadedFontSource(family: string, style: string): FontLoadedSource | null {
    return this.loadedFamilySources.get(`${family}|${style}`) ?? null
  }

  isLoaded(family: string): boolean {
    return [...this.loadedFamilies.keys()].some((k) => k.startsWith(`${family}|`))
  }

  isStyleLoaded(family: string, style: string): boolean {
    const key = `${family}|${style}`
    const loaded = this.loadedFamilies.has(key)
    if (loaded) this.fontMemory.touch(key)
    return loaded
  }

  remoteStyleNeedsCoverage(family: string, style: string, characters: readonly string[]): boolean {
    const coverage = this.remoteCoverage.get(`${family}|${style}`)
    return !!coverage && characters.some((character) => !coverage.has(character))
  }

  loadedData(family: string, style: string): ArrayBuffer | null {
    const key = `${family}|${style}`
    const data = this.loadedFamilies.get(key) ?? null
    if (data) this.fontMemory.touch(key)
    return data
  }

  /** Axis coordinates for `style` when the loaded face is a variable font, otherwise `null`. */
  namedInstanceVariations(family: string, style: string): FontVariation[] | null {
    const data = this.loadedData(family, style)
    if (!data) return null
    let byStyle = this.instanceVariations.get(data)
    if (!byStyle) {
      byStyle = new Map()
      this.instanceVariations.set(data, byStyle)
    }
    if (!byStyle.has(style)) byStyle.set(style, namedInstanceVariations(data, style))
    return byStyle.get(style) ?? null
  }

  renderFamily(family: string, _style: string): string {
    // CanvasKit can shape metrics but paint no glyphs for some CJK/Arabic faces registered under a
    // synthetic alias. Keep every shard under the font's source family.
    // 例外：互斥分片不挂本名（同名塌缩），每片各持 alias，由 renderFamilyAliases
    // 经段落 fontFamilies 回退链合流——本名 primary 仍在回退链首位提供度量。
    return family
  }

  collectFontKeys(graph: SceneGraph, nodeIds: string[]): Array<[string, string]> {
    return collectGraphFontKeys(graph, nodeIds)
  }

  async ensureCJKFallback(): Promise<string[]> {
    if (this.cjkFallbackFamilies.length > 0) return this.cjkFallbackFamilies
    if (this.cjkFallbackPromise) return this.cjkFallbackPromise

    this.cjkFallbackPromise = (async () => {
      // T84：bundled PuHuiTi 前插 CJK 回退链，离线/无系统字体权限时仍能命中中文字形
      await this.prependBundledCJK(this.cjkFallbackFamilies)
      return this.cjkFallbackFamilies
    })()
    return this.cjkFallbackPromise
  }

  getCJKFallbackFamilies(): string[] {
    return this.cjkFallbackFamilies
  }

  setCJKFallbackFamily(family: string): void {
    if (!this.cjkFallbackFamilies.includes(family)) {
      this.cjkFallbackFamilies.push(family)
    }
  }

  async ensureArabicFallback(): Promise<string[]> {
    if (this.arabicFallbackFamilies.length > 0) return this.arabicFallbackFamilies
    if (this.arabicFallbackPromise) return this.arabicFallbackPromise

    this.arabicFallbackPromise = Promise.resolve([...this.arabicFallbackFamilies])
    return this.arabicFallbackPromise
  }

  async ensureFallbackPack(
    scripts: FontFallbackScript[] = ['cjk', 'arabic'],
    _characters = '',
    signal?: AbortSignal
  ): Promise<Partial<Record<FontFallbackScript, string[]>>> {
    signal?.throwIfAborted()
    const result: Partial<Record<FontFallbackScript, string[]>> = {}
    await Promise.all(
      scripts.map(async (script) => {
        signal?.throwIfAborted()
        if (script === 'cjk') {
          result.cjk = await this.ensureCJKFallback()
        } else if (script === 'arabic') {
          result.arabic = await this.ensureArabicFallback()
        }
      })
    )
    signal?.throwIfAborted()
    return result
  }

  getArabicFallbackFamilies(): string[] {
    return this.arabicFallbackFamilies
  }

  setArabicFallbackFamily(family: string): void {
    if (!this.arabicFallbackFamilies.includes(family)) {
      this.arabicFallbackFamilies.push(family)
    }
  }

  /**
   * bundled PuHuiTi 前插 CJK 回退链（T84）：断网/无系统字体权限场景下仍能让
   * CJK 字符命中字形；幂等，loadFont 失败时不抛（降级到原有本地/远端链）。
   */
  private async prependBundledCJK(targetFamilies: string[]): Promise<void> {
    const family = 'Alibaba PuHuiTi'
    if (targetFamilies.includes(family)) return
    const buffer = await this.loadFont(family, 'Regular')
    if (buffer && !targetFamilies.includes(family)) {
      targetFamilies.unshift(family)
    }
  }

  /**
   * 从 userFontProvider 拉取本地安装族字节。subset-collection 族走 pieces/piece
   * 通路（list 端点不返 artifact 字段，需经 read 501 后回退到 readSubsetPieces）。
   * 失败静默——不阻断 bundled 兜底链。返回 null = 需继续往下试。
   *
   * style 是请求侧（FontManager 注册键 = family|style 缓存键），与 key（list
   * 端点 styles[].key = 安装清单真值）分离：read 全量路径用 key，subset 路径
   * 传 (key, style) 让 loader 按 key 精确选片、按 style 入注册键。
   */
  private async tryLoadFromUserFontProvider(
    family: string,
    style: string,
    characters: string
  ): Promise<ArrayBuffer | null> {
    const provider = this.userFontProvider
    if (!provider) return null
    try {
      const views = await provider.list()
      const view = views.find((v) => v.family === family)
      if (!view) return null
      const key = matchUserStyleKey(view, style)
      if (!key) return null
      // subset-collection 族按 list 视图 artifact 直走分片通路——read 端点对其
      // 按设计返 501，先探测只会白刷一条浏览器级 resource error
      const styleArtifact = view.styles.find((s) => s.key === key)?.artifact
      if (styleArtifact !== 'subset-collection') {
        const buffer = await provider.read(family, key)
        if (buffer) return this.registerAndCache(family, style, buffer, 'user')
      }
      if (provider.readSubsetPieces) {
        const subsetBuffer = await this.loadInstalledCnFontPieces(family, key, style, characters)
        if (subsetBuffer) return subsetBuffer
      }
    } catch (e) {
      console.warn(`User font provider load failed for "${family}" (${style}):`, e)
    }
    return null
  }

  /**
   * 应用字体库族枚举写入 byFamily。注入存在时拉取 list；失败静默。同名族
   * 不覆盖既有键——bundled 段先写键，user 仅补漏。
   */
  private async collectUserFontProviderOptions(
    byFamily: Map<string, FontFamilyOption>
  ): Promise<void> {
    if (!this.userFontProvider) return
    try {
      const userViews = await this.userFontProvider.list()
      for (const view of userViews) {
        if (!byFamily.has(view.family))
          byFamily.set(view.family, { family: view.family, source: 'user' })
      }
    } catch (e) {
      console.warn('User font provider list failed:', e)
    }
  }

  /**
   * 注册分片集合到 FontManager（共享 helper）：首片 registerAndCache real-name
   * primary、后续 trackSupplementalData、每片 CanvasKit alias 防同名塌缩。
   * 渲染期用户安装 subset-collection 路径（loadInstalledCnFontPieces）使用。
   */
  private registerCnFontPieces(
    family: string,
    style: string,
    pieces: Array<{ url: string; buffer: ArrayBuffer; ranges: Array<[number, number]> }>,
    coveredCharacters: readonly string[]
  ): ArrayBuffer | null {
    const key = `${family}|${style}`
    const aliases = this.renderAliasFamilies.get(key) ?? []
    const seenURLs = new Set(aliases.map((entry) => entry.url))
    let primary = this.loadedFamilies.get(key) ?? null

    for (const piece of pieces) {
      if (seenURLs.has(piece.url)) continue
      const unicodeRange = formatUnicodeRanges(piece.ranges)
      if (primary) {
        this.trackSupplementalData(family, style, piece.buffer)
        this.registerFontInBrowser(family, style, piece.buffer, unicodeRange)
      } else {
        primary = this.registerAndCache(family, style, piece.buffer, 'user', unicodeRange)
      }
      const alias = `${family}${FONT_ALIAS_SEPARATOR}${aliases.length}`
      aliases.push({ url: piece.url, alias, data: piece.buffer })
      seenURLs.add(piece.url)
      this.registerFontInCanvasKit(alias, piece.buffer)
    }
    this.renderAliasFamilies.set(key, aliases)

    const loadedCoverage = this.remoteCoverage.get(key) ?? new Set<string>()
    for (const character of coveredCharacters) loadedCoverage.add(character)
    this.remoteCoverage.set(key, loadedCoverage)
    return primary
  }

  /**
   * 渲染期用户安装 subset-collection 族加载：注入 userFontProvider.readPieces
   * 失败返 null（与 loadCnFontSubset 同语义——回退 bundled 兜底链）。
   * shared alias helper 保证两源同名分片策略一致（首片 real-name + 后续 alias）。
   *
   * 参数对（styleKey, style）：
   *  - styleKey = list 端点 styles[].key（安装清单真值，cn-piece-loader 按它精确选片）
   *  - style = 请求侧（FontManager 注册键；与 family|style 缓存键一致）
   */
  private async loadInstalledCnFontPieces(
    family: string,
    styleKey: string,
    style: string,
    characters: string
  ): Promise<ArrayBuffer | null> {
    if (!this.userFontProvider?.readSubsetPieces) return null
    const result = await this.userFontProvider.readSubsetPieces({
      family,
      styleKey,
      style,
      characters
    })
    if (!result) return null
    return this.registerCnFontPieces(
      family,
      style,
      [
        { url: result.primary.hash, buffer: result.primary.buffer, ranges: result.primary.ranges },
        ...result.supplemental.map((s) => ({
          url: s.hash,
          buffer: s.buffer,
          ranges: s.ranges
        }))
      ],
      result.coveredCharacters
    )
  }

  /** 分片键的 alias 名（排版 fontFamilies 回退链用；非分片键恒为空数组） */
  renderFamilyAliases(family: string, style: string): string[] {
    return (this.renderAliasFamilies.get(`${family}|${style}`) ?? []).map((entry) => entry.alias)
  }

  /** 补充片记账（不含注册）：返回 false 表示该 buffer 已在账上（调用方应跳过重注册） */
  private trackSupplementalData(family: string, style: string, buffer: ArrayBuffer): boolean {
    const key = `${family}|${style}`
    const supplemental = this.supplementalFamilyData.get(key) ?? []
    if (supplemental.includes(buffer)) return false
    supplemental.push(buffer)
    this.supplementalFamilyData.set(key, supplemental)
    this.trackVariableFont(key, buffer)
    this.recountFontMemory(key)
    this.enforceFontMemoryBudget(key)
    return true
  }

  /** T41：入账时嗅探 fvar（三容器，见 font/variable.ts），登记键级 VF 身份与 wght 区间 */
  private trackVariableFont(key: string, buffer: ArrayBuffer): void {
    const info = sniffVariableFont(buffer)
    if (!info.variable) return
    this.variableFontKeys.add(key)
    this.variableWeightRanges.set(
      key,
      info.wght ? { min: info.wght.min, max: info.wght.max } : null
    )
  }

  private registerSupplemental(family: string, style: string, buffer: ArrayBuffer): void {
    if (!this.trackSupplementalData(family, style, buffer)) return
    this.registerFontInCanvasKit(family, buffer)
    this.registerFontInBrowser(family, style, buffer)
  }

  /**
   * 重述某键的账本字节数（primary + 全部补充片）。重述而非增量：
   * registerAndCache 替换 primary 时会把旧 primary 降级为补充片，总字节不变，
   * 增量记账在此场景必然漂移（T40 S1）。
   */
  private recountFontMemory(key: string): void {
    const primary = this.loadedFamilies.get(key)
    if (!primary) {
      this.fontMemory.remove(key)
      return
    }
    let bytes = primary.byteLength
    for (const supplemental of this.supplementalFamilyData.get(key) ?? []) {
      bytes += supplemental.byteLength
    }
    this.fontMemory.set(key, bytes)
  }

  private enforceFontMemoryBudget(excludeKey?: string): void {
    const over = this.fontMemory.totalBytes() - this.fontMemoryBudget
    if (over <= 0) return
    const exclude = new Set(excludeKey ? [excludeKey] : [])
    for (const victim of this.fontMemory.lruVictims(over, exclude, this.fontMemoryBudget)) {
      this.evictFontKey(victim)
    }
  }

  private evictFontKey(key: string): void {
    const separator = key.indexOf('|')
    const family = key.slice(0, separator)
    const style = key.slice(separator + 1)
    // 先复位 resolver 再删引用：resolver 残留 'loaded' 快照会让 demand 直接返回旧
    // promise、字体被逐出后永不重载（T40 S1）；在途 load 完成后重新入账视为复活。
    this.fontEvictListener?.(family, style)
    this.loadedFamilies.delete(key)
    this.supplementalFamilyData.delete(key)
    this.remoteCoverage.delete(key)
    this.loadedFamilySources.delete(key)
    this.renderAliasFamilies.delete(key)
    this.variableFontKeys.delete(key)
    this.variableWeightRanges.delete(key)
    const faces = this.browserFontFaces.get(key)
    if (faces) {
      for (const face of faces) {
        try {
          document.fonts.delete(face)
        } catch (error) {
          // document.fonts 不可用时忽略——JS 引用随 map 清除即释放
          console.warn(`Font face removal failed for "${family}" (${style}):`, error)
        }
      }
      this.browserFontFaces.delete(key)
    }
    this.fontMemory.remove(key)
    this.fontEvictions++
  }

  private registerAndCache(
    family: string,
    style: string,
    buffer: ArrayBuffer,
    source?: FontLoadedSource,
    unicodeRange?: string
  ): ArrayBuffer | null {
    const key = `${family}|${style}`
    const existing = this.loadedFamilies.get(key)
    if (existing === buffer) {
      if (source) this.loadedFamilySources.set(key, source)
      this.registerFontInCanvasKit(family, buffer)
      this.fontMemory.touch(key)
      return buffer
    }
    if (existing) this.registerSupplemental(family, style, existing)
    this.loadedFamilies.set(key, buffer)
    if (source) this.loadedFamilySources.set(key, source)
    this.registerFontInCanvasKit(family, buffer)
    this.registerFontInBrowser(family, style, buffer, unicodeRange)
    this.trackVariableFont(key, buffer)
    this.recountFontMemory(key)
    this.enforceFontMemoryBudget(key)
    return buffer
  }

  private registerFontInCanvasKit(family: string, data: ArrayBuffer): boolean {
    let registered = false
    for (const provider of this.fontProviders) {
      registered = this.registerFontInProvider(provider, family, data) || registered
    }
    return registered
  }

  private registerFontInProvider(
    provider: TypefaceFontProvider,
    family: string,
    data: ArrayBuffer
  ): boolean {
    if (data.byteLength < 4) return false
    const registrations = this.providerRegistrations.get(provider) ?? new Map()
    const registeredData = registrations.get(family)
    if (registeredData?.has(data)) return true
    // 内容去重：逐出只释放 JS 侧，provider 里的同字节注册仍在册（无 unregister）
    // ——重载拿到新 ArrayBuffer 身份会绕过上面的按 buffer 去重，这正是逐出/重载
    // 泵的 WASM 泄漏本体（复测轮 10：注册台账 1.75GB 里 ~2/3 是同字节重复副本）。
    // 按内容哈希命中即复用旧注册，零新增 WASM 副本；台账不双计。
    const hash = this.fontContentHash(data)
    const providerHashes = this.providerRegistrationHashes.get(provider) ?? new Map()
    const familyHashes = providerHashes.get(family)
    if (familyHashes?.has(hash)) return true
    try {
      provider.registerFont(data, family)
      const familyRegistrations = registeredData ?? new Set<ArrayBuffer>()
      familyRegistrations.add(data)
      registrations.set(family, familyRegistrations)
      this.providerRegistrations.set(provider, registrations)
      const newFamilyHashes = familyHashes ?? new Set<string>()
      newFamilyHashes.add(hash)
      providerHashes.set(family, newFamilyHashes)
      this.providerRegistrationHashes.set(provider, providerHashes)
      this.registrationGeneration++
      return true
    } catch {
      return false
    }
  }

  /** 同一 ArrayBuffer 的内容哈希缓存——龟键全量 FNV 每个 buffer 只算一次 */
  private fontContentHash(data: ArrayBuffer): string {
    const cached = this.fontDataHashes.get(data)
    if (cached) return cached
    const bytes = new Uint8Array(data)
    let h1 = 0x811c9dc5
    let h2 = 0x85ebca6b
    for (const byte of bytes) {
      h1 = Math.imul(h1 ^ byte, 0x01000193)
      h2 = Math.imul(h2 ^ byte, 0x27d4eb2f)
    }
    const hash = `${data.byteLength}:${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`
    this.fontDataHashes.set(data, hash)
    return hash
  }

  /** Makes a face available to the page's own text, such as fields over canvas labels. */
  registerFontInBrowser(family: string, style: string, data: ArrayBuffer, unicodeRange?: string) {
    // 以真实能力为准：测试环境可能 mock window（IS_BROWSER 为真）却无 FontFace 实现
    if (!IS_BROWSER || typeof FontFace === 'undefined') return
    const italic = style.toLowerCase().includes('italic') ? 'italic' : 'normal'
    // T41：可变字体的 weight descriptor 必须是区间（CSS 字重匹配才能命中全档）；
    // fvar 直读失败（woff2 压缩流）按 CSS 合法全区间兜底
    const info = sniffVariableFont(data)
    const weight = info.variable
      ? `${info.wght?.min ?? FULL_WEIGHT_RANGE.min} ${info.wght?.max ?? FULL_WEIGHT_RANGE.max}`
      : String(styleToWeight(style))
    const face = new FontFace(family, data, {
      weight,
      style: italic,
      ...(unicodeRange ? { unicodeRange } : {})
    })
    // 按键跟踪 FontFace 实例，逐出时 document.fonts.delete 真正释放浏览器侧内存（T40 S1）
    const key = `${family}|${style}`
    const faces = this.browserFontFaces.get(key) ?? []
    faces.push(face)
    this.browserFontFaces.set(key, faces)
    face
      .load()
      .then(() => document.fonts.add(face))
      .catch(() => {
        console.warn(`Failed to load font "${family}" (${style})`)
      })
  }
}

export const fontManager = new FontManager()
