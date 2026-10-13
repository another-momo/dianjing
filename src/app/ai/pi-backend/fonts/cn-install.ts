/**
 * cn-fonts 商店分片集合安装实现。
 *
 * 抽离自 store-routes.ts 以控制行数（owner：单文件 ≤ 600 行）。
 * 调度入口 `scheduleSubsetInstall`；单 style 装入 `installOneStylePieces`。
 *
 * 全部成功才落盘（片 + index.json + manifest）；任一 style 全片失败记
 * failures；部分失败 → done + failures。取消 / 全失败时**不**写 manifest。
 */

import type { ServerResponse } from 'node:http'

import { upsertStyle, type StyleEntry } from '@open-pencil/core/text/font/installed/manifest'
import { detectContainer, validateFontBytes } from '@open-pencil/core/text/font/installed/validate'
import { transcodeWoff2ToSfnt } from '@open-pencil/core/text/font/installed/woff2'
import type { CnFontCdnDescriptor } from '@open-pencil/core/text/font/registry'
import type {
  StoreCatalogFamily,
  StoreCatalogStyle,
  StoreServiceDescriptor
} from '@open-pencil/core/text/font/store/types'
import { pickCnFontSubfamily, parseCnFontResultCSS } from '@open-pencil/core/text/web-font/cn-fonts'

import { mapRejectionToText, sendJSON } from './http-helpers'
import type { StoreRouteDeps } from './store-routes'
import { fetchStyleBytes, isAborted } from './stream-helpers'

/** result.css 拉取上限（与目录同档——8MB；css-tree 解析对超长 css 也会爆栈） */
const CSS_FETCH_MAX_BYTES = 8 * 1024 * 1024
/** result.css 拉取超时 */
const CSS_FETCH_TIMEOUT_MS = 60_000
/** 单片字节拉取上限——8MB 兼容单片约 2-100KB 实证 + 异常包结构爆片防护 */
const PIECE_FETCH_MAX_BYTES = 8 * 1024 * 1024
/** 单片拉取超时 */
const PIECE_FETCH_TIMEOUT_MS = 30_000
/** 单 style 内片下载并发上限（写死常量；上调会撞 PIECE_FETCH_MAX_BYTES 单连接流） */
const PIECE_CONCURRENCY = 4

/**
 * 调度分片集合安装。任务 total = style 数；每个 style 装入完成后才递增
 * done（与 store-routes.ts installOneStyle 路径同语义——按 style 步进而非
 * 按片步进，否则 done 会远超 total，UI 比率失真）。
 */
export function scheduleSubsetInstall(
  deps: StoreRouteDeps,
  res: ServerResponse,
  service: StoreServiceDescriptor,
  catalogFamily: StoreCatalogFamily,
  selectedStyles: StoreCatalogStyle[]
): boolean {
  const tasks = deps.tasks
  if (tasks.countRunning() >= 8) {
    sendJSON(res, 429, { error: 'too many running install tasks', code: 'busy' })
    return true
  }
  const { task, shortCircuited } = tasks.start({
    serviceId: service.id,
    family: catalogFamily.family,
    total: selectedStyles.length,
    worker: async (signal, taskRef) => {
      const styleResults: Array<{
        style: StoreCatalogStyle
        ok: boolean
        pieces: Array<{ bytes: Uint8Array; ranges: Array<[number, number]> }>
        errorMessage?: string
      }> = []
      for (const style of selectedStyles) {
        if (signal.aborted) return
        const ref = style.piecesRef
        if (!ref) {
          styleResults.push({ style, ok: false, pieces: [], errorMessage: 'missing piecesRef' })
          taskRef.failures.push({ style: style.style, reason: 'missing piecesRef' })
          continue
        }
        try {
          const pieces = await installOneStylePieces(catalogFamily, style, ref, signal)
          styleResults.push({ style, ok: true, pieces })
          taskRef.done++
        } catch (error) {
          if (isAborted(signal)) return
          const reason = error instanceof Error ? error.message : String(error)
          styleResults.push({ style, ok: false, pieces: [], errorMessage: reason })
          taskRef.failures.push({ style: style.style, reason })
        }
      }
      if (signal.aborted) return
      const someOk = styleResults.some((r) => r.ok)
      if (!someOk) return
      const okResults = styleResults.filter((r) => r.ok)
      // 写盘前魔数复检：拉片时的校验通过 ≠ 写盘时字节仍合法（堆视图覆写实证——
      // 69 片校验全过、落盘 68 片垃圾且 hash 自洽地坏）。此处复检把静默落盘垃圾
      // 升级为任务失败，不留脏库。
      for (const r of okResults) {
        for (const p of r.pieces) {
          const container = detectContainer(p.bytes)
          if (container !== 'ttf' && container !== 'otf') {
            throw new Error(
              `refusing to persist piece with bad sfnt magic: ${container ?? 'unknown'}`
            )
          }
        }
      }
      // 同族重装前先清旧族目录（避免新旧片混杂）
      deps.store.deleteFamily(catalogFamily.family)
      const writeArgs = {
        family: catalogFamily.family,
        entries: okResults.map((r) => ({
          styleKey: r.style.style,
          weight: r.style.weight,
          italic: r.style.italic,
          pieces: r.pieces
        }))
      }
      const { indexHash } = deps.store.installSubsetPieces(writeArgs)
      const manifest = deps.store.readManifest()
      const installedAt = Date.now()
      for (const r of okResults) {
        const totalSize = r.pieces.reduce((sum, p) => sum + p.bytes.byteLength, 0)
        const styleEntry: StyleEntry = {
          key: r.style.style,
          weight: r.style.weight,
          italic: r.style.italic,
          variable: r.style.variable === true,
          // subset-collection 族的 hash 字段 = index.json 摘要（installSubsetPieces
          // 内部算的整族共享 digest），不是单片字节摘要——full 族才填字体字节摘要
          hash: indexHash,
          ext: 'ttf',
          size: totalSize,
          artifact: 'subset-collection',
          source: 'store',
          installedAt
        }
        if (r.style.wghtRange) {
          styleEntry.wghtRange = {
            min: r.style.wghtRange.min,
            default: r.style.wghtRange.min,
            max: r.style.wghtRange.max
          }
        }
        upsertStyle(manifest, catalogFamily.family, styleEntry, catalogFamily.displayName)
      }
      manifest.updatedAt = installedAt
      deps.store.writeManifest(manifest)
    }
  })
  sendJSON(res, 200, { ok: true, taskId: task.id, shortCircuited })
  return true
}

/**
 * 单 style 分片集合装入：拉 result.css + 逐片拉字节 + 转码 + 校验。
 * 全部成功才返 pieces 数组；任一片失败抛错。任务进度由调用方按 style 步进
 * （见 scheduleSubsetInstall 注释），此处不再以片为单位推进。
 */
async function installOneStylePieces(
  family: StoreCatalogFamily,
  style: StoreCatalogStyle,
  ref: CnFontCdnDescriptor,
  signal: AbortSignal
): Promise<Array<{ bytes: Uint8Array; ranges: Array<[number, number]> }>> {
  const base = ref.baseURL ?? ''
  const pkg = `${ref.package}@${ref.version ?? 'latest'}`
  const cssURL = await resolveCSSURL(base, pkg, ref, family.family, style.weight, signal)
  const cssResult = await fetchText(cssURL, signal, CSS_FETCH_MAX_BYTES, CSS_FETCH_TIMEOUT_MS)
  if (!cssResult.ok) throw new Error(`result.css fetch failed: ${cssResult.error}`)
  // parseCnFontResultCSS 把 src 解析为绝对 URL，baseURL 用 cssURL（与 cn-fonts.ts 同语义）
  const pieces = parseCnFontResultCSS(cssResult.text, cssURL)
  if (pieces.length === 0) throw new Error('result.css has no @font-face pieces')
  // 选片：按 style weight 过滤
  const selected = pieces.filter((p) =>
    p.weightMax !== undefined
      ? p.weight <= style.weight && style.weight <= p.weightMax
      : p.weight === style.weight
  )
  if (selected.length === 0) throw new Error('no pieces match the requested weight')
  // 并发 4 拉片 + 转码 + 校验
  const limit = Math.min(PIECE_CONCURRENCY, selected.length)
  const collected: Array<{ bytes: Uint8Array; ranges: Array<[number, number]> }> = []
  const errors: string[] = []
  let cursor = 0
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        if (signal.aborted) return
        const idx = cursor++
        if (idx >= selected.length) return
        const piece = selected[idx]
        try {
          const fetched = await fetchAndDecodePieceWithRetry(piece.url, signal)
          collected.push({ bytes: fetched, ranges: piece.ranges })
        } catch (error) {
          errors.push(
            `piece ${piece.url}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    })
  )
  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
  return collected
}

/** 解 CSSURL：cssPath 直接拼；否则经 index.json + pickCnFontSubfamily 派生。 */
async function resolveCSSURL(
  base: string,
  pkg: string,
  ref: CnFontCdnDescriptor,
  family: string,
  weight: number,
  signal: AbortSignal
): Promise<string> {
  if (ref.cssPath) {
    return `${base}/${pkg}/${ref.cssPath}`
  }
  const indexPath = ref.indexPath ?? 'dist/index.json'
  const indexURL = `${base}/${pkg}/${indexPath}`
  const indexResult = await fetchText(indexURL, signal, CSS_FETCH_MAX_BYTES, CSS_FETCH_TIMEOUT_MS)
  if (!indexResult.ok) throw new Error(`index.json fetch failed: ${indexResult.error}`)
  let dirs: string[]
  try {
    const parsed: unknown = JSON.parse(indexResult.text)
    if (!Array.isArray(parsed)) throw new Error('index.json is not an array')
    dirs = parsed.filter((d): d is string => typeof d === 'string')
  } catch (error) {
    throw new Error(
      `index.json parse failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (dirs.length === 0) throw new Error('index.json is empty')
  const dir = pickCnFontSubfamily(dirs, weight, family)
  if (!dir) throw new Error('no matching subfamily in index.json')
  return `${base}/${pkg}/dist/${dir}/result.css`
}

async function fetchAndDecodePiece(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const fetched = await fetchStyleBytes(url, signal, PIECE_FETCH_MAX_BYTES, PIECE_FETCH_TIMEOUT_MS)
  if (!fetched.ok) throw new Error(fetched.error)
  let bytes = fetched.bytes
  if (detectContainer(bytes) === 'woff2') {
    bytes = await transcodeWoff2ToSfnt(bytes)
  }
  const validation = validateFontBytes(bytes)
  if (!validation.ok) {
    console.warn(`[fonts-store] piece rejected: ${validation.reason}: ${validation.detail}`)
    throw new Error(mapRejectionToText(validation.reason, validation.detail))
  }
  return bytes
}

/**
 * 瞬时网络错误判定（片级重试白名单）：断连/超时类可重试；HTTP 状态码
 * （'HTTP 4xx'）与字体校验拒绝（本地化文案）属确定性失败，不重试。
 * 实证：jsdelivr 边缘偶发单片挂死（同 hash curl 1s 可达、后端 30s 超时），
 * 无重试时任一片瞬时失败即整 style 报废（真实网络下必现）。
 */
function isTransientPieceError(message: string): boolean {
  return (
    message.includes('style fetch timeout') ||
    message.includes('piece watchdog timeout') ||
    message.includes('terminated') ||
    message.includes('fetch failed') ||
    message.includes('UND_ERR') ||
    message.includes('ECONNRESET') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('socket')
  )
}

/** 单 attempt 看门狗宽限——比读体超时宽一档，双保险防「abort 无响应」楔死 */
const PIECE_WATCHDOG_MS = PIECE_FETCH_TIMEOUT_MS + 15_000

/**
 * 看门狗兜底：实证出现过拉片对 abort 无响应的进程级楔死（任务永 running、
 * 零 socket 零 CPU、cancel 无效）——race 一个独立定时器保证单 attempt 有界。
 * 输家 promise 挂空 catch 防未处理拒绝。
 */
async function withPieceWatchdog<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('piece watchdog timeout')), PIECE_WATCHDOG_MS)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    void work.catch(() => {})
  }
}

/** 单片拉取 + 转码 + 校验，瞬时错误重试（任务 signal 全程生效，取消即刻停） */
async function fetchAndDecodePieceWithRetry(
  url: string,
  signal: AbortSignal,
  attempts = 3
): Promise<Uint8Array> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) throw new Error('cancelled')
    try {
      return await withPieceWatchdog(fetchAndDecodePiece(url, signal))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isTransientPieceError(message)) throw error
      lastError = error instanceof Error ? error : new Error(message)
    }
  }
  throw lastError ?? new Error('piece fetch failed')
}

async function fetchText(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
  timeoutMs: number
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const fetched = await fetchStyleBytes(url, signal, maxBytes, timeoutMs)
  if (!fetched.ok) return { ok: false, error: fetched.error }
  try {
    return { ok: true, text: Buffer.from(fetched.bytes).toString('utf8') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
