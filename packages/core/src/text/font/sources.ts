import type { WebFontProviderId } from '#core/text/web-fonts'

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
 */
export interface UserFontProvider {
  list(): Promise<
    {
      family: string
      styles: { key: string; weight: number; italic: boolean; variable: boolean }[]
    }[]
  >
  read(family: string, styleKey: string): Promise<ArrayBuffer | null>
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
