/**
 * 专属字体服务（外部分发服务）运行时 provider 纯函数。
 *
 * 服务数据面与 @chinese-fonts 静态包布局兼容：
 * - `{BASE}/{PACKAGE}@{VERSION}/dist/index.json` → 子族目录名数组；
 * - `{BASE}/{PACKAGE}@{VERSION}/dist/{SUBFAMILY}/result.css` → @font-face 分片
 *   （unicode-range + 相对路径 `./{hash}.woff2`）——与 jsdelivr 同构，目录条目
 *   经 CnFontCdnDescriptor.baseURL 透传后由既有 CN 分片管线按需加载；
 * - `{BASE}/catalog.json`（公开目录）→ 家族清单，运行时拉取枚举进 picker。
 *
 * 防御边界：catalog 解析全程不 throw（非数组/坏条目跳过或返回空清单），
 * 由调用方按「失败 → 空清单」降级，不阻塞 picker。
 */

import type { WebFontFetch } from '#core/text/web-fonts'

export interface CustomFontServiceConfig {
  baseURL: string
  token: string
  enabled: boolean
}

/** catalog.json 条目：package/family/latestVersion 必填，其余可选（防御式解析后仍缺省） */
export interface CustomFontServiceCatalogEntry {
  family: string
  package: string
  latestVersion: string
  displayName?: string
  license?: string
  weights?: string[]
  variable?: boolean
}

const CATALOG_PATH = '/catalog.json'
/**
 * 响应体积上限：与 src/app/editor/fonts/browser-fetch.ts 的 web 字体 8MB 口径一致
 * （content-length 与实读双查）。browser-fetch.ts 供体文件冻结，本文件独立实现同款守卫。
 */
const MAX_CUSTOM_SERVICE_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * 归一化服务地址：trim → 去尾部 `/` → 用户把 catalog 地址整个粘进来时
 * （以 `/catalog.json` 结尾）剥掉该后缀，得到 `{BASE}` 本体。
 */
export function normalizeCustomServiceBase(base: string): string {
  let normalized = base.trim().replace(/\/+$/, '')
  if (normalized.endsWith(CATALOG_PATH)) {
    normalized = normalized.slice(0, normalized.length - CATALOG_PATH.length)
  }
  return normalized
}

/** catalog 拉取地址：`{归一化 base}/catalog.json` */
export function customServiceCatalogURL(config: CustomFontServiceConfig): string {
  return `${normalizeCustomServiceBase(config.baseURL)}${CATALOG_PATH}`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * 防御式解析 catalog.json：整体非数组返回 `[]`；仅收 package/family/latestVersion
 * 均为非空 string 的条目；可选字段类型不符时视同缺省，绝不 throw。
 */
export function parseCustomServiceCatalog(json: unknown): CustomFontServiceCatalogEntry[] {
  if (!Array.isArray(json)) return []
  const entries: CustomFontServiceCatalogEntry[] = []
  for (const item of json) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const pkg = record['package']
    const family = record['family']
    const latestVersion = record['latestVersion']
    if (!isNonEmptyString(pkg) || !isNonEmptyString(family) || !isNonEmptyString(latestVersion)) {
      continue
    }
    const displayName = record['displayName']
    const license = record['license']
    const weights = record['weights']
    const variable = record['variable']
    entries.push({
      package: pkg,
      family,
      latestVersion,
      ...(typeof displayName === 'string' ? { displayName } : {}),
      ...(typeof license === 'string' ? { license } : {}),
      ...(isStringArray(weights) ? { weights } : {}),
      ...(typeof variable === 'boolean' ? { variable } : {})
    })
  }
  return entries
}

/**
 * Scoped fetch 包装：URL 以归一化 base 开头的请求改走 direct——https 校验 +
 * 响应 8MB 上限（content-length 与实读双查，口径同 browser-fetch.ts，见上注）+
 * 合并注入 `Authorization: Bearer <token>`（`new Headers(init?.headers)` 归一后
 * append，不清空既有头）；其余 URL 原样透传 inner，头与体积均不动。
 */
export function scopeBearerFetch(
  base: string,
  token: string,
  direct: WebFontFetch,
  inner: WebFontFetch
): WebFontFetch {
  const prefix = normalizeCustomServiceBase(base)
  return async (url, init) => {
    // '/' 边界防止同主机兄弟路径前缀误中（base `https://h/f-cdn` 不应命中
    // `https://h/f-cdn-evil/...`，否则 Bearer 会泄漏给兄弟路径服务）
    if (!prefix || !url.startsWith(`${prefix}/`)) return inner(url, init)
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
      throw new Error(`Custom font service requires https: ${parsed.protocol}`)
    }
    const headers = new Headers(init?.headers)
    headers.append('Authorization', `Bearer ${token}`)
    const response = await direct(url, { ...init, headers })
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > MAX_CUSTOM_SERVICE_RESPONSE_BYTES) {
      throw new Error('Custom font service response exceeds the size limit')
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_CUSTOM_SERVICE_RESPONSE_BYTES) {
      throw new Error('Custom font service response exceeds the size limit')
    }
    const bounded = new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
    Object.defineProperty(bounded, 'url', { value: response.url })
    return bounded
  }
}
