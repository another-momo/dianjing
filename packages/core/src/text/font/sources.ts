import { WEB_FONT_PROVIDER_IDS, type WebFontProviderId } from '#core/text/web-fonts'

export interface FontInfo {
  family: string
  fullName: string
  style: string
  postscriptName: string
}

export type LocalFontAccessState = 'unsupported' | 'prompt' | 'granted' | 'denied'
export type FontFamilySource =
  | 'local'
  | 'bundled'
  | 'cdn'
  | 'custom'
  | 'user'
  | 'fallback'
  | WebFontProviderId

/**
 * Sources whose picker rows support an on-demand preview load via `loadFont`.
 * The picker triggers `@vue:mounted` font fetch only when the row's source is in
 * this set — list-driven routes (CDN / catalog / custom / local) are loaded
 * through their own pipelines and would double-fetch or hit permission walls
 * if preloaded here.
 */
export const PREVIEWABLE_FONT_SOURCES: readonly FontFamilySource[] = [
  ...WEB_FONT_PROVIDER_IDS,
  'user',
  'bundled'
] as const
export type FontLoadedSource = FontFamilySource | 'cache' | 'registered'

export interface FontFamilyOption {
  family: string
  source: FontFamilySource
  /** 专属字体服务族的自定义显示名（custom-service catalog 条目携带；展示用，family 身份不变） */
  displayName?: string
  /** T42：中文网字计划全量目录族（cn-catalog.ts，默认停用 opt-in；区别于 registry 精选 CDN 族） */
  catalog?: boolean
}

export interface DownloadedFontCache {
  read(family: string, style: string, characters?: string): Promise<ArrayBuffer | null>
  write(family: string, style: string, data: ArrayBuffer, characters?: string): Promise<void>
}

export type HostFontLoader = (family: string, style: string) => Promise<ArrayBuffer | null>

/**
 * 应用字体库（用户安装）提供者：list 返 FamilyView 聚合视图，read 返指定
 * 族内 style 的字节（FamilyView.styles[].key）。core 域不依赖 HTTP——app 层
 * 把 client-fonts 适配成该接口后注入。
 *
 * readSubsetPieces（可选）：subset-collection artifact 族的渲染期加载——按
 * 字符选片 + 拉片字节。返回主片（首片）+ 补充片（同名 alias 防塌缩）形态。
 * 未实现时 subset-collection 族走 read 端点会被服务端 501 拒，本方法也返 null。
 */
export interface UserFontProvider {
  list(): Promise<
    {
      family: string
      styles: { key: string; weight: number; italic: boolean; variable: boolean }[]
    }[]
  >
  read(family: string, styleKey: string): Promise<ArrayBuffer | null>
  readSubsetPieces?(args: {
    family: string
    /** 请求侧 style 字符串（FontManager 注册键；与 family|style 缓存键一致） */
    style: string
    /** 已解析的真值 styleKey——list 端点 styles[].key 之一。选片按它精确匹配，
     *  解决 VF 族 index 条目 weight 恒 400（adapter 用单 variable 条目）时按
     *  weight/italic 推断会过滤为零的回退问题 */
    styleKey: string
    characters: string
  }): Promise<{
    primary: { hash: string; buffer: ArrayBuffer; ranges: Array<[number, number]> }
    supplemental: Array<{ hash: string; buffer: ArrayBuffer; ranges: Array<[number, number]> }>
    coveredCharacters: string[]
  } | null>
}

/** Why an installed face could not be loaded, when the host can tell. */
export type FontUnavailableReason = 'unsupported-format'

/** Thrown by a {@link HostFontLoader} for an installed face whose outlines cannot be drawn. */
export class UnsupportedFontFormatError extends Error {
  readonly reason: FontUnavailableReason = 'unsupported-format'

  constructor(family: string, style: string) {
    super(`Font outlines are in an unsupported format: ${family} ${style}`)
    this.name = 'UnsupportedFontFormatError'
  }
}
