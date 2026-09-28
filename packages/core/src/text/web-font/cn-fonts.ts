/**
 * 中文网字计划 CDN 子集解析器（T40 S3，13 册 §4.3）。
 *
 * 数据面（2026-08-30 jsdelivr 实测，以 @chinese-fonts/lxgwwenkai@3.0.0 为例）：
 * - `dist/index.json`：子族目录名数组，如 ["LXGWWenKai-Light","LXGWWenKai-Regular",...]；
 * - `dist/{子族}/result.css`：cn-font-split 生成的压缩 @font-face 块序列，每块带
 *   `font-weight` / `font-style` / `unicode-range`（单值、区间、通配 U+4?? 三种形态）
 *   与相对路径 `./{hash}.woff2` 分片（每片 2-100KB）；
 * - 按需加载 = 用 demand 字符的码位命中 unicode-range 区间选片，只下载覆盖片。
 *
 * 防御边界（13 册 §4.3 / T40 D-g）：全程不 throw——任何一步失败返回 null，由
 * FontManager 回退 unifont provider 链；选片数超阈值（包结构变异信号）告警并放弃，
 * 避免异常包拉爆内存。
 */

import { parse, walk } from 'css-tree'

import type { CnFontCdnDescriptor } from '#core/text/font/registry'
import { styleToWeight } from '#core/text/font/style'
import type { WebFontFetch } from '#core/text/web-fonts'

export type { CnFontCdnDescriptor } from '#core/text/font/registry'

/** piece 级磁盘缓存接缝（D-c：URL 内容寻址，浏览器侧 IndexedDB 实现见 S5） */
export interface CnFontPieceCache {
  read(url: string): Promise<ArrayBuffer | null>
  write(url: string, data: ArrayBuffer): Promise<void>
}

export interface CnFontFacePiece {
  url: string
  weight: number
  /** 可变字体分片的字重区间上限（T41）：`font-weight: 250 900` 区间形态；静态片缺省 */
  weightMax?: number
  italic: boolean
  ranges: Array<[number, number]>
}

/** 取回的分片：url 供跨调用去重（增量请求会重选已注册片），ranges 供 FontFace unicode-range */
export interface CnFontFetchedPiece {
  url: string
  buffer: ArrayBuffer
  ranges: Array<[number, number]>
}

export interface CnFontSubsetResult {
  pieces: CnFontFetchedPiece[]
  /** 实际取到且被所选片覆盖的请求字符（供 remoteCoverage 精确记账） */
  coveredCharacters: string[]
}

/** 把解析后的 ranges 还原为 CSS unicode-range 描述符串（FontFace 注册用） */
export function formatUnicodeRanges(ranges: ReadonlyArray<readonly [number, number]>): string {
  const hex = (value: number) => value.toString(16).toUpperCase()
  return ranges
    .map(([low, high]) => (low === high ? `U+${hex(low)}` : `U+${hex(low)}-${hex(high)}`))
    .join(', ')
}

const CDN_BASE = 'https://cdn.jsdelivr.net/npm'
/** 单次请求选片上限：正常按需只有个位数片，超此阈值视为包结构变异（T40 D-g） */
export const CN_FONT_MAX_PIECES_PER_REQUEST = 200

/** 字重目录后缀词表：长词在前，避免 'ExtraLight' 被 'light' 抢先命中 */
const WEIGHT_TOKENS: ReadonlyArray<readonly [number, string]> = [
  [200, 'extralight'],
  [200, 'ultralight'],
  [600, 'semibold'],
  [600, 'demibold'],
  [800, 'extrabold'],
  [800, 'ultrabold'],
  [100, 'thin'],
  [300, 'light'],
  [400, 'regular'],
  [400, 'normal'],
  [500, 'medium'],
  [700, 'bold'],
  [900, 'black'],
  [900, 'heavy']
]

/** 从子族目录名推断字重（'LXGWWenKaiMono-Light' → 300）；无法推断返回 null */
export function subfamilyDirWeight(dir: string): number | null {
  const lowered = dir.toLowerCase()
  for (const [weight, token] of WEIGHT_TOKENS) {
    if (lowered.endsWith(`-${token}`) || lowered.endsWith(token)) return weight
  }
  return null
}

/** 解析 unicode-range 值：单值 U+4E2D、区间 U+4E00-9FFF、通配 U+4?? 三种形态 */
export function parseUnicodeRanges(value: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const part of value.split(',')) {
    const token = part.trim()
    const match = /^U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?$/i.exec(token)
    if (!match) continue
    const [, start, end] = match
    if (start.includes('?')) {
      // 通配形态：U+4?? → [0x400, 0x4FF]
      const prefix = start.replace(/\?/g, '')
      const wildcards = start.length - prefix.length
      const low = Number.parseInt(prefix || '0', 16) << (4 * wildcards)
      ranges.push([low, low + (1 << (4 * wildcards)) - 1])
      continue
    }
    const low = Number.parseInt(start, 16)
    const high = end ? Number.parseInt(end, 16) : low
    if (Number.isFinite(low) && Number.isFinite(high) && high >= low) ranges.push([low, high])
  }
  return ranges
}

/** 解析 result.css 为分片清单；baseURL 用于把相对 src 解析为绝对 URL（piece 缓存键） */
export function parseCnFontResultCSS(css: string, baseURL: string): CnFontFacePiece[] {
  const pieces: CnFontFacePiece[] = []
  const ast = parse(css, { positions: false, parseValue: false })
  walk(ast, {
    visit: 'Atrule',
    enter(node) {
      if (node.name !== 'font-face' || !node.block) return
      // 用对象属性收集：闭包内赋值后局部变量的窄化在 walk() 调用点即失效，
      // 标量 let 会被 TS 误判「永远 null」
      const face: {
        url: string | null
        weight: number
        weightMax: number | undefined
        italic: boolean
        ranges: Array<[number, number]>
      } = { url: null, weight: 400, weightMax: undefined, italic: false, ranges: [] }
      walk(node.block, {
        visit: 'Declaration',
        enter(declaration) {
          const value = declaration.value
          if (declaration.property === 'src' && value.type === 'Raw') {
            const match = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(value.value)
            if (match) face.url = new URL(match[1], baseURL).toString()
          } else if (declaration.property === 'font-weight' && value.type === 'Raw') {
            // 单值（400）与可变区间（250 900）双形态（T41 syst 实测）
            const numbers = value.value
              .trim()
              .split(/\s+/)
              .map((token) => Number.parseInt(token, 10))
              .filter((n) => Number.isFinite(n))
            if (numbers.length >= 2) {
              face.weight = numbers[0]
              face.weightMax = numbers[1]
            } else if (numbers.length === 1) {
              face.weight = numbers[0]
            }
          } else if (declaration.property === 'font-style' && value.type === 'Raw') {
            face.italic = value.value.trim().toLowerCase() === 'italic'
          } else if (declaration.property === 'unicode-range' && value.type === 'Raw') {
            face.ranges = parseUnicodeRanges(value.value)
          }
        }
      })
      if (face.url && face.ranges.length > 0) {
        pieces.push({
          url: face.url,
          weight: face.weight,
          weightMax: face.weightMax,
          italic: face.italic,
          ranges: face.ranges
        })
      }
    }
  })
  return pieces
}

function rangeCovers(ranges: ReadonlyArray<readonly [number, number]>, codePoint: number): boolean {
  return ranges.some(([low, high]) => codePoint >= low && codePoint <= high)
}

/** 按需字符选片：每个去重字符找覆盖它的片，结果按 URL 去重 */
export function selectCnFontPieces(
  pieces: readonly CnFontFacePiece[],
  characters: string,
  weight: number,
  italic: boolean
): CnFontFacePiece[] {
  // 字重匹配：静态片单值相等；可变片（weightMax）区间包含（T41）
  const weightMatches = (piece: CnFontFacePiece) =>
    piece.weightMax !== undefined
      ? piece.weight <= weight && weight <= piece.weightMax
      : piece.weight === weight
  const weighted = pieces.filter((piece) => weightMatches(piece) && piece.italic === italic)
  const pool = weighted.length > 0 ? weighted : pieces
  const selected = new Map<string, CnFontFacePiece>()
  for (const character of new Set(characters)) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    for (const piece of pool) {
      if (rangeCovers(piece.ranges, codePoint) && !selected.has(piece.url)) {
        selected.set(piece.url, piece)
        break
      }
    }
  }
  return [...selected.values()]
}

/**
 * 按请求字重挑子族目录：精确后缀命中 → 最近字重 → 第一个。
 * 家族名不含 'Mono' 时排除等宽子族（同一包内 Mono 是另一套 family）。
 */
export function pickCnFontSubfamily(
  dirs: readonly string[],
  weight: number,
  family: string
): string | null {
  const preferMono = /mono/i.test(family)
  const pool = dirs.filter((dir) => /mono/i.test(dir) === preferMono)
  const candidates = pool.length > 0 ? pool : [...dirs]
  if (candidates.length === 0) return null

  const weighted = candidates.map((dir) => [dir, subfamilyDirWeight(dir)] as const)
  const exact = weighted.find(([, w]) => w === weight)
  if (exact) return exact[0]
  const nearest = weighted
    .filter((entry): entry is readonly [string, number] => entry[1] !== null)
    .sort((a, b) => Math.abs(a[1] - weight) - Math.abs(b[1] - weight))
  return nearest.at(0)?.[0] ?? candidates[0]
}

export class CnFontSubsetResolver {
  private fetcher: WebFontFetch
  private cache: CnFontPieceCache | null
  private readonly baseURL: string
  /** 子族索引与 result.css 会话级缓存：键 = 绝对 URL */
  private readonly indexPromises = new Map<string, Promise<string[] | null>>()
  private readonly pieceListPromises = new Map<string, Promise<CnFontFacePiece[] | null>>()
  private readonly piecePromises = new Map<string, Promise<ArrayBuffer | null>>()

  constructor(
    options: {
      fetcher?: WebFontFetch
      cache?: CnFontPieceCache | null
      baseURL?: string
    } = {}
  ) {
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init))
    this.cache = options.cache ?? null
    this.baseURL = options.baseURL ?? CDN_BASE
  }

  setCache(cache: CnFontPieceCache | null): void {
    this.cache = cache
  }

  setFetcher(fetcher: WebFontFetch): void {
    this.fetcher = fetcher
    this.indexPromises.clear()
    this.pieceListPromises.clear()
    this.piecePromises.clear()
  }

  /**
   * 按需取片。返回 null = 本 provider 无力承担（包不存在/无覆盖/结构异常），
   * 调用方回退 unifont 链；返回空 pieces 同理。部分片失败不致命——
   * coveredCharacters 只记成功片，未覆盖字符下一轮重试。
   */
  async fetch(
    family: string,
    descriptor: CnFontCdnDescriptor,
    style: string,
    characters: string
  ): Promise<CnFontSubsetResult | null> {
    try {
      const weight = styleToWeight(style)
      const italic = style.toLowerCase().includes('italic')
      const cssURL = await this.resolveCSSURL(descriptor, weight, family)
      if (!cssURL) return null

      const pieces = await this.pieceList(cssURL)
      if (!pieces || pieces.length === 0) return null

      const selected = selectCnFontPieces(pieces, characters, weight, italic)
      if (selected.length === 0) return null
      if (selected.length > CN_FONT_MAX_PIECES_PER_REQUEST) {
        console.warn(
          `cn-font "${family}" requested ${selected.length} pieces in one pass ` +
            `(threshold ${CN_FONT_MAX_PIECES_PER_REQUEST}) — treating as package anomaly`
        )
        return null
      }

      const buffers = await Promise.all(selected.map((piece) => this.fetchPiece(piece.url)))
      const fetched: CnFontFetchedPiece[] = []
      for (const [index, piece] of selected.entries()) {
        const buffer = buffers[index]
        if (buffer) fetched.push({ url: piece.url, buffer, ranges: piece.ranges })
      }
      const covered: string[] = []
      for (const character of new Set(characters)) {
        const codePoint = character.codePointAt(0)
        if (codePoint === undefined) continue
        const hit = fetched.some((piece) => rangeCovers(piece.ranges, codePoint))
        if (hit) covered.push(character)
      }
      return { pieces: fetched, coveredCharacters: covered }
    } catch (error) {
      console.warn(`cn-font fetch failed for "${family}" ${style}:`, error)
      return null
    }
  }

  private packageBase(descriptor: CnFontCdnDescriptor): string {
    // T42：缺省 jsdelivr。base=unpkg 回退曾覆盖非 ASCII 子族目录名的包
    // （2026-08-30 实测 jsdelivr 全边缘 404）；2026-09-06 复测 jsdelivr 已支持
    // 非 ASCII 路径（37/37 族全绿），catalog 回退已全量移除。descriptor.baseURL
    // 透传机制保留（registry 精选层/未来回退仍可用）。
    const base = descriptor.baseURL ?? this.baseURL
    return `${base}/${descriptor.package}@${descriptor.version ?? 'latest'}`
  }

  private async resolveCSSURL(
    descriptor: CnFontCdnDescriptor,
    weight: number,
    family: string
  ): Promise<string | null> {
    const base = this.packageBase(descriptor)
    if (descriptor.cssPath) return `${base}/${descriptor.cssPath}`
    const dirs = await this.subfamilyIndex(`${base}/${descriptor.indexPath ?? 'dist/index.json'}`)
    if (!dirs || dirs.length === 0) return null
    const dir = pickCnFontSubfamily(dirs, weight, family)
    return dir ? `${base}/dist/${dir}/result.css` : null
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const response = await this.fetcher(url)
      return response.ok ? await response.text() : null
    } catch {
      return null
    }
  }

  private subfamilyIndex(url: string): Promise<string[] | null> {
    let promise = this.indexPromises.get(url)
    if (!promise) {
      promise = (async () => {
        const text = await this.fetchText(url)
        if (!text) return null
        try {
          const parsed: unknown = JSON.parse(text)
          return Array.isArray(parsed)
            ? parsed.filter((dir): dir is string => typeof dir === 'string')
            : null
        } catch {
          return null
        }
      })()
      this.indexPromises.set(url, promise)
      // 失败（null）不记忆，index/css/piece 三层同款：null 条目留在图里会让
      // 「下一轮重试」零网络命中缓存的 null 永不自愈——瞬态限流/抖动须可重试
      void promise.then((dirs) => {
        if (dirs === null) this.indexPromises.delete(url)
      })
    }
    return promise
  }

  private pieceList(cssURL: string): Promise<CnFontFacePiece[] | null> {
    let promise = this.pieceListPromises.get(cssURL)
    if (!promise) {
      promise = (async () => {
        const text = await this.fetchText(cssURL)
        if (!text) return null
        try {
          return parseCnFontResultCSS(text, cssURL)
        } catch (error) {
          console.warn(`cn-font result.css parse failed (${cssURL}):`, error)
          return null
        }
      })()
      this.pieceListPromises.set(cssURL, promise)
      void promise.then((parsed) => {
        if (parsed === null) this.pieceListPromises.delete(cssURL)
      })
    }
    return promise
  }

  private fetchPiece(url: string): Promise<ArrayBuffer | null> {
    let promise = this.piecePromises.get(url)
    if (!promise) {
      promise = (async () => {
        const cached = await this.cache?.read(url).catch(() => null)
        if (cached) return cached
        try {
          const response = await this.fetcher(url)
          if (!response.ok) return null
          const buffer = await response.arrayBuffer()
          await this.cache?.write(url, buffer).catch(() => undefined)
          return buffer
        } catch {
          return null
        }
      })()
      this.piecePromises.set(url, promise)
      void promise.then((buffer) => {
        if (buffer === null) this.piecePromises.delete(url)
      })
    }
    return promise
  }
}

export const cnFontSubsetResolver = new CnFontSubsetResolver()
