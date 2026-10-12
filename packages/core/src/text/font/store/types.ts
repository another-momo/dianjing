/**
 * 字体商店域类型定义。
 *
 * 形态：纯类型 + 共享常量（无 fs / 无 DOM）。三种服务 kind 各对应一个适配器；
 * 商店面板的「服务清单 → 目录浏览 → 安装任务」全链数据均自此出口。
 */

/** 单 style = 一个 (weight, style) 字形文件 */
export interface StoreCatalogStyle {
  /** 渲染期 style 字符串，如 'Regular' / 'Bold Italic' */
  style: string
  weight: number
  italic: boolean
  /** 字节直链（适配器层拼装的最终可拉取 URL） */
  fileURL: string
  /** 容器格式——端点侧据此决定是否走 woff2 转码 */
  format: 'ttf' | 'otf' | 'woff2'
  /** VF 标记；true 时 wghtRange 必填 */
  variable?: boolean
  /** VF wght 区间（min/max）。Fontsource 上游不显式提供，由 weights 数组派生 */
  wghtRange?: { min: number; max: number }
}

/** 一族 = 一个字体家族的目录条目 */
export interface StoreCatalogFamily {
  /** 身份键（适配器归一化产物；Fontsource 走 id，其他走 family 字串） */
  family: string
  /** UI 展示名（可选） */
  displayName?: string
  /** 授权标记（缺失 = 状态未知，UI 端展示「授权状态未知」不拦截） */
  license?: string
  /** 服务商侧版本号（选填；Fontsource 响应 'version'） */
  version?: string
  /** 服务商侧最后更新（选填；Fontsource 响应 'lastModified'） */
  lastModified?: string
  styles: StoreCatalogStyle[]
}

/** 服务 kind 白名单——注册表单的 kind 选项据此枚举 */
export type StoreServiceKind = 'fontsource' | 'standard' | 'gf-api'

/** 服务描述子 = 服务清单视图的最小单元 */
export interface StoreServiceDescriptor {
  /** 内置 = 'preset:fontsource'；自定义 = 'custom:' + slugify(name) */
  id: string
  name: string
  kind: StoreServiceKind
  /** baseURL：Fontsource 接 https://api.fontsource.org；custom 走用户填的根 */
  baseURL: string
  /** gf-api 用；内置预设无 */
  apiKey?: string
  /** 内置（不可删）= true；custom = false */
  builtin: boolean
}

/** 适配器层 fetch 注入形态——便于单测替换 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

/** 适配器契约：拉一份服务的全量目录 */
export interface StoreAdapter {
  /** 拉目录 → StoreCatalogFamily[]；失败抛 Error（调用方 try/catch 兜） */
  fetchCatalog(fetchImpl: FetchLike): Promise<StoreCatalogFamily[]>
}

/** 标准契约适配器（kind='standard'）的 catalog.json 形态 */
export interface StandardCatalogFile {
  families: StoreCatalogFamily[]
}

/** Google Fonts 兼容 API（kind='gf-api'）的单族 item 形态 */
export interface GoogleFontsItem {
  family: string
  /** variant 字符串数组，如 ['regular','italic','700','700italic'] */
  variants?: string[]
  /** variant → url 映射 */
  files?: Record<string, string>
  /** axes 可选，含 'wght' 时为 VF */
  axes?: Array<{
    tag: string
    start: number
    end: number
  }>
}

/** Google Fonts 兼容 API 响应形态 */
export interface GoogleFontsResponse {
  kind: string
  items: GoogleFontsItem[]
}
