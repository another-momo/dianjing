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
