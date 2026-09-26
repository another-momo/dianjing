/**
 * 2026-09-26 load_image URL 直连支持：fetch-image-url —— 把 http/https/
 * data: URL 收敛到与本地路径同形态的 {bytes, fileName, contentType}，
 * URL 取字节后入嗅探/桥管线（与本地路径同一套 magic 验证 + 字节上限），
 * load_image 工具据此免「bash 先下载再 load」绕路。
 *
 * 设计取舍（显式记述）：
 *  - SSRF 闸定位防误用，非对抗性防御：hostname 字面量级（不做 DNS 解析
 *    级防御——工具代理本来就有 shell 通路可主动拉，对手阈值远超字面名单）。
 *  - data: URL 仅 base64 形态——URL-encoded 形态解码后仍要走同一套
 *    嗅探闸，无增益，简化拒。
 *  - 整链总超时 AbortController 而非每跳独立——总预算封顶，恶意慢吐
 *    无法靠重定向续命（含流读阶段，超时统一落 timeout 文案）。
 *  - 重定向目标仅放行 http/https（data: 等不得借 3xx 进入取字节通路）；
 *    https→http 降级放行——防误用闸不做协议升降裁决。
 *  - Content-Length 预检 + 流式累计双闸——前者挡诚实大头、后者挡说谎头。
 */

import { decodeBase64 } from '@open-pencil/core/bytes'

export interface FetchImageFromURLOptions {
  /** 字节上限（必填；生产调用点显式传 LOAD_IMAGE_MAX_BYTES，模块内不复制常量） */
  maxBytes: number
  /** 整链（含重定向跳）总预算 ms——缺省 30000 */
  timeoutMs?: number
  /** 测试注入；缺省 globalThis.fetch */
  fetchImpl?: typeof fetch
}

export type FetchImageResult =
  | { ok: true; bytes: Uint8Array; fileName: string; contentType: string | null }
  | { ok: false; error: string }

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// ── SSRF 主机名单（hostname 字面量级，防误用而非对抗性防御） ──

function stripIPv6Brackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1)
  return host
}

/** IPv4 点分判定：首段 0/127/10 全拒；172.16–172.31、192.168、169.254 */
function isDeniedIPv4Literal(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false
  const parts = host.split('.').map(Number)
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 127 || a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** IPv6 字面量判定：::1 / :: 全拒；fc/fd（ULA）、fe80::/10（link-local）；
 *  ::ffff: IPv4-mapped 抽出 v4 段复查。 */
function isDeniedIPv6Literal(host: string): boolean {
  if (host === '::1' || host === '::') return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true
  if (/^fe[89ab][0-9a-f]?:/i.test(host)) return true
  const mappedV4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]
  if (mappedV4) return isDeniedIPv4Literal(mappedV4)
  return false
}

/** SSRF 主机名单：true = 拒 */
function isDeniedHost(hostname: string): boolean {
  if (!hostname) return false
  const host = stripIPv6Brackets(hostname).toLowerCase()
  if (host === 'localhost') return true
  if (host.endsWith('.localhost')) return true
  if (host.includes(':')) return isDeniedIPv6Literal(host)
  return isDeniedIPv4Literal(host)
}

// ── fileName 提取（最终 URL pathname 最后一段，decodeURIComponent） ──

function extractFileName(url: URL): string {
  const segs = url.pathname.split('/').filter((s) => s.length > 0)
  const last = segs[segs.length - 1]
  if (!last) return 'image'
  try {
    // 解码后再取一次 basename——%2F/%5C 解码回路径分隔符，不入节点名
    const base = decodeURIComponent(last).split(/[\\/]/).pop()
    return base || 'image'
  } catch {
    return last
  }
}

/** 错误文案用 URL 形态——只留 origin+pathname，userinfo/query 不进文案 */
function displayURL(url: URL): string {
  return `${url.origin}${url.pathname}`
}

// ── data: URL 分支 ──

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s

function fetchDataURL(rawURL: string, maxBytes: number): FetchImageResult {
  const m = DATA_URL_RE.exec(rawURL)
  if (!m) {
    return {
      ok: false,
      error: 'Unsupported data: URL — only base64 data: URLs are supported.'
    }
  }
  const mime = m[1] ?? ''
  const payload = m[2] ?? ''
  if (!mime || !payload) {
    return { ok: false, error: 'Invalid data: URL — missing MIME or payload.' }
  }
  // base64 按 4/3 膨胀率解码前早拒（对齐流路径「读前预检」哲学）
  const approxBytes = Math.ceil((payload.length * 3) / 4)
  if (approxBytes > maxBytes) {
    return { ok: false, error: sizeError(approxBytes, maxBytes) }
  }
  let bytes: Uint8Array
  try {
    bytes = decodeBase64(payload)
  } catch {
    return { ok: false, error: 'Invalid base64 payload in data: URL.' }
  }
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      error: `Image too large (${Math.ceil(bytes.byteLength / 1024 / 1024)}MB). Maximum supported size is ${Math.ceil(maxBytes / 1024 / 1024)}MB.`
    }
  }
  return { ok: true, bytes, fileName: 'image', contentType: mime.toLowerCase() }
}

// ── HTTP(S) 主体 ──

function parseContentLength(headers: Headers): number | null {
  const v = headers.get('content-length')
  if (!v) return null
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

function formatMb(n: number): number {
  return Math.ceil(n / 1024 / 1024)
}

function sizeError(actualBytes: number, maxBytes: number): string {
  return `Image too large (${formatMb(actualBytes)}MB). Maximum supported size is ${formatMb(maxBytes)}MB.`
}

async function streamWithCap(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const body = response.body
  if (!body) return { ok: false, error: 'Empty response body.' }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (signal.aborted) return { ok: false, error: 'Fetch aborted.' }
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // 取消失败非致命——abort 信号会跟着生效
          return { ok: false, error: sizeError(total, maxBytes) }
        }
        return { ok: false, error: sizeError(total, maxBytes) }
      }
      chunks.push(value)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Failed to read response: ${reason}` }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return { ok: true, bytes: merged }
}

/** 重定向环产出：终态响应 + 终态 URL（fileName 取此处） */
interface ResolvedResponse {
  response: Response
  finalURL: URL
}

/** 重定向环（manual，最多 MAX_REDIRECTS 跳；每跳 fetch 前都查 SSRF 名单） */
async function resolveFinalResponse(
  start: URL,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<ResolvedResponse | { error: string }> {
  let current = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // 每跳复查（重定向目标也在内）：scheme 只放行 http/https + SSRF 主机名单
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return { error: `Redirect to unsupported URL scheme: ${current.protocol.replace(':', '')}.` }
    }
    if (isDeniedHost(current.hostname)) {
      return {
        error: `Refusing to fetch ${current.hostname}: loopback, link-local or private network addresses are not allowed.`
      }
    }
    let response: Response
    try {
      response = await fetchImpl(current, { signal, redirect: 'manual' })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { error: `Failed to fetch ${displayURL(current)}: ${reason}` }
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        return { error: `Redirect from ${displayURL(current)} missing Location header.` }
      }
      try {
        current = new URL(location, current)
      } catch {
        return { error: `Invalid redirect Location: ${location}` }
      }
      // 中间响应体丢弃前显式取消（连接不留 GC 兜底）
      await response.body?.cancel().catch(() => undefined)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined)
      return { error: `HTTP ${response.status} while fetching ${displayURL(current)}.` }
    }
    return { response, finalURL: current }
  }
  return { error: `Too many redirects (>${MAX_REDIRECTS} hops).` }
}

export async function fetchImageFromURL(
  rawURL: string,
  options: FetchImageFromURLOptions
): Promise<FetchImageResult> {
  const { maxBytes } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)

  // 1. 解析 + scheme 闸
  let url: URL
  try {
    url = new URL(rawURL)
  } catch {
    return { ok: false, error: `Invalid URL: ${rawURL}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'data:') {
    return { ok: false, error: `Unsupported URL scheme: ${url.protocol.replace(':', '')}.` }
  }

  // 2. data: 分支（不进网络，直接解码）
  if (url.protocol === 'data:') {
    return fetchDataURL(rawURL, maxBytes)
  }

  // 3. 整链 AbortController + setTimeout（总预算封顶，含全部重定向跳）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 4. 重定向环取终态响应
    const resolved = await resolveFinalResponse(url, fetchImpl, controller.signal)
    if ('error' in resolved) {
      // abort 触发的 fetch 失败统一落超时文案
      if (controller.signal.aborted) {
        return { ok: false, error: `Request timed out after ${timeoutMs}ms.` }
      }
      return { ok: false, error: resolved.error }
    }
    const { response, finalURL } = resolved

    // 5. 字节上限：Content-Length 预检 + 流式累计双闸
    const declared = parseContentLength(response.headers)
    if (declared !== null && declared > maxBytes) {
      try {
        await response.body?.cancel()
      } catch {
        // 取消失败非致命——字节本就在响应头已拒
        return { ok: false, error: sizeError(declared, maxBytes) }
      }
      return { ok: false, error: sizeError(declared, maxBytes) }
    }
    const streamed = await streamWithCap(response, maxBytes, controller.signal)
    if (!streamed.ok) {
      // 流阶段 abort 同样落超时文案——总预算含流读，诊断不断点
      if (controller.signal.aborted) {
        return { ok: false, error: `Request timed out after ${timeoutMs}ms.` }
      }
      return streamed
    }
    return {
      ok: true,
      bytes: streamed.bytes,
      fileName: extractFileName(finalURL),
      contentType: response.headers.get('content-type')?.toLowerCase() ?? null
    }
  } finally {
    clearTimeout(timer)
  }
}
