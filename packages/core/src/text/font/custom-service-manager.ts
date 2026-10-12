import type { WebFontFetch } from '#core/text/web-fonts'

import {
  customServiceCatalogURL,
  normalizeCustomServiceBase,
  parseCustomServiceCatalog
} from './custom-service'
import type { CustomFontServiceCatalogEntry, CustomFontServiceConfig } from './custom-service'
import { normalizeFontFamily } from './style'

/** 依赖注入：FontManager 透传可变的 fetcher / 超时 / 非专属族 allowlist 兜底 */
export interface CustomServiceManagerDeps {
  getWebFontFetch: () => WebFontFetch | null
  getWebFontListTimeoutMs: () => number
  isEnabledByAllowlist: (family: string) => boolean
}

/**
 * 专属字体服务（外部分发服务，运行时可配置 provider）状态与目录懒加载。
 *
 * FontManager 委托接线：本类不反向引用 FontManager；依赖以回调形式注入
 * （fetcher getter、timeout getter、allowlist.isEnabled 兜底）。
 *
 * 状态字段 = FontManager 旧 customService 块（config / catalog Map / in-flight
 * promise / epoch / 专属族关停集合），职责 = 拉取 / 解析 / 缓存 / 逐族关停 /
 * 加载门控。配置变更清缓存 + epoch++（与白名单 revision 同形，picker 失效信号）。
 */
export class CustomServiceManager {
  private config: CustomFontServiceConfig | null = null
  private catalog = new Map<string, CustomFontServiceCatalogEntry>()
  private catalogPromise: Promise<CustomFontServiceCatalogEntry[]> | null = null
  private epoch = 0
  private disabledFamilies = new Set<string>()

  constructor(private readonly deps: CustomServiceManagerDeps) {}

  getConfig(): CustomFontServiceConfig | null {
    return this.config
  }

  getCatalog(): ReadonlyMap<string, CustomFontServiceCatalogEntry> {
    return this.catalog
  }

  getEpoch(): number {
    return this.epoch
  }

  /**
   * 配置专属字体服务：存归一化配置、清目录缓存与 in-flight、递增 epoch
   * （picker 依赖 fontAllowlistRevision 重挂载）。null = 关停/未配置。
   */
  setConfig(config: CustomFontServiceConfig | null): void {
    this.config = config ? { ...config, baseURL: normalizeCustomServiceBase(config.baseURL) } : null
    this.catalog.clear()
    this.catalogPromise = null
    this.epoch++
  }

  /**
   * 目录懒加载（familiesPromises 同款模式）：有启用配置时经注入 fetcher 取
   * catalog.json，沿用 webFontListTimeoutMs 超时 + 失败 → 空清单不 throw 的
   * 既有降级；config 变更即清缓存重拉（setConfig）。
   */
  async familyOptions(): Promise<CustomFontServiceCatalogEntry[]> {
    const config = this.config
    if (!config?.enabled || !config.baseURL || !config.token) return []
    if (this.catalog.size > 0) return [...this.catalog.values()]
    if (!this.catalogPromise) {
      this.catalogPromise = this.loadCatalog(config)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.catalogPromise,
        new Promise<CustomFontServiceCatalogEntry[]>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('custom font service catalog timeout')),
            this.deps.getWebFontListTimeoutMs()
          )
        })
      ])
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  /** 拉取并解析 catalog（防御式，任何失败 → 空清单）；成功后按 family 建索引 */
  private async loadCatalog(
    config: CustomFontServiceConfig
  ): Promise<CustomFontServiceCatalogEntry[]> {
    try {
      const fetcher: WebFontFetch = this.deps.getWebFontFetch() ?? ((url, init) => fetch(url, init))
      const response = await fetcher(customServiceCatalogURL(config))
      if (!response.ok) return []
      const parsed: unknown = await response.json()
      // config 同一性守卫：拉取期间 config 被切换/清空时丢弃本次结果，
      // 防止旧配置目录条目经后台 promise 写入缓存（后续 size>0 短路会返回旧族）
      if (this.config !== config) return []
      const entries = parseCustomServiceCatalog(parsed)
      this.catalog.clear()
      for (const entry of entries) this.catalog.set(entry.family, entry)
      return entries
    } catch (e) {
      console.warn('Custom font service catalog load failed:', e)
      return []
    }
  }

  /** 专属服务目录族判定：原始名 + normalizeFontFamily 名双查（与 cnFontDescriptor 同口径） */
  isCustomServiceFamily(family: string): boolean {
    if (this.catalog.has(family)) return true
    const normalized = normalizeFontFamily(family)
    return normalized !== family && this.catalog.has(normalized)
  }

  /** 专属族关停判定：原始名 + normalizeFontFamily 名双查（与 isCustomServiceFamily 同口径） */
  isCustomFamilyDisabled(family: string): boolean {
    if (this.disabledFamilies.has(family)) return true
    const normalized = normalizeFontFamily(family)
    return normalized !== family && this.disabledFamilies.has(normalized)
  }

  /**
   * 加载门控：专属目录族查专属逐族开关（服务整体 opt-in 默认开，用户可在面板逐族
   * 关停）；共享 disabled 集合不参与专属族判定——它混有 web 目录默认关停的同名
   * 条目，参与会让撞名族加载被无关条目静默拒绝。非专属族维持 allowlist 判定。
   * 门控前确保目录已拉取：文档打开直加载可能先于 picker 枚举，不等待会让自定义族
   * 落入 registry/catalog/unifont 错源并被 loadedData 缓存粘住。
   */
  async isCustomOrAllowed(family: string): Promise<boolean> {
    if (this.config?.enabled && this.catalog.size === 0) {
      await this.familyOptions()
    }
    if (this.isCustomServiceFamily(family)) return !this.isCustomFamilyDisabled(family)
    return this.deps.isEnabledByAllowlist(family)
  }

  /**
   * 专属族逐族开关：null 返回 = 非专属族（caller 应回退 allowlist 判定）；
   * 已开再开 / 已关再关同态不空转，epoch 不递增。
   * 双删/双写策略：开 = raw + 归一名一并删（持久化恢复的历史条目可能存归一名），
   * 关 = 写原始名（双查口径下归一名查询同样命中）。
   */
  setFamilyEnabled(family: string, enabled: boolean): true | null {
    if (!this.isCustomServiceFamily(family)) return null
    const wasDisabled = this.isCustomFamilyDisabled(family)
    if (enabled && !wasDisabled) return true
    if (!enabled && wasDisabled) return true
    if (enabled) {
      this.disabledFamilies.delete(family)
      const normalized = normalizeFontFamily(family)
      if (normalized !== family) this.disabledFamilies.delete(normalized)
    } else {
      this.disabledFamilies.add(family)
    }
    this.epoch++
    return true
  }

  /** 专属族关停集合清单（面板回写持久化用） */
  listDisabledFamilies(): string[] {
    return [...this.disabledFamilies]
  }

  /**
   * 批量同步专属族关停集合：全量替换 + 同态不空转（与 allowlist commit 同守卫）。
   * 变化经 epoch 并入 fontAllowlistRevision，picker 等一次性缓存消费方监听重挂载。
   */
  setDisabledFamilies(families: string[]): void {
    const next = new Set(families)
    if (
      next.size === this.disabledFamilies.size &&
      [...next].every((family) => this.disabledFamilies.has(family))
    ) {
      return
    }
    this.disabledFamilies = next
    this.epoch++
  }
}
