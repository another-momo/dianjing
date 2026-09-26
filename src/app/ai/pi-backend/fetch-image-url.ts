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
 *    无法靠重定向续命。
 *  - Content-Length 预检 + 流式累计双闸——前者挡诚实大头、后者挡说谎头。
 */

import { decodeBase64 } from '@open-pencil/core/bytes'

export interface FetchImageFromUrlOptions {
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
  if (parts.length !== 4) return false
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 127 || a === 10) return true
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
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
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped && mapped[1]) return isDeniedIPv4Literal(mapped[1])
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
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

// ── data: URL 分支 ──

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s

function fetchDataUrl(rawUrl: string, maxBytes: number): FetchImageResult {
  const m = DATA_URL_RE.exec(rawUrl)
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
      if (!value) continue
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

export async function fetchImageFromUrl(
  rawUrl: string,
  options: FetchImageFromUrlOptions
): Promise<FetchImageResult> {
  const { maxBytes } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)

  // 1. 解析 + scheme 闸
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: `Invalid URL: ${rawUrl}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'data:') {
    return { ok: false, error: `Unsupported URL scheme: ${url.protocol.replace(':', '')}.` }
  }

  // 2. data: 分支（不进网络，直接解码）
  if (url.protocol === 'data:') {
    return fetchDataUrl(rawUrl, maxBytes)
  }

  // 3. 整链 AbortController + setTimeout（每跳共用）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 4. 重定向环（最多 5 跳；每跳 fetch 前都查 SSRF）
    let currentUrl = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (controller.signal.aborted) {
        return { ok: false, error: `Request timed out after ${timeoutMs}ms.` }
      }
      if (isDeniedHost(currentUrl.hostname)) {
        return {
          ok: false,
          error: `Refusing to fetch ${currentUrl.hostname}: loopback, link-local or private network addresses are not allowed.`
        }
      }
      let response: Response
      try {
        response = await fetchImpl(currentUrl, {
          signal: controller.signal,
          redirect: 'manual'
        })
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, error: `Request timed out after ${timeoutMs}ms.` }
        }
        const reason = error instanceof Error ? error.message : String(error)
        return { ok: false, error: `Failed to fetch ${currentUrl}: ${reason}` }
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        if (!location) {
          return { ok: false, error: `Redirect from ${currentUrl} missing Location header.` }
        }
        let next: URL
        try {
          next = new URL(location, currentUrl)
        } catch {
          return { ok: false, error: `Invalid redirect Location: ${location}` }
        }
        currentUrl = next
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: `HTTP ${response.status} while fetching ${currentUrl}.` }
      }
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
      if (!streamed.ok) return streamed
      return {
        ok: true,
        bytes: streamed.bytes,
        fileName: extractFileName(currentUrl),
        contentType: response.headers.get('content-type')
      }
    }
    return { ok: false, error: `Too many redirects (>${MAX_REDIRECTS} hops).` }
  } finally {
    clearTimeout(timer)
  }
}
