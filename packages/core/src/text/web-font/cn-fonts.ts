/**
 * 中文网字计划 result.css 解析纯函数（cn-piece-loader 等共享）。
 *
 * cn-fonts.ts 拆分自 T40 时期的 CDN 远程半面。cn-piece-loader（font/installed/cn-piece-loader.ts）
 * 走本地分片（用户安装的 subset-collection artifact），与 CDN 解耦；它复用这里的
 * selectCnFontPieces / parseCnFontResultCSS / parseUnicodeRanges，pin 共享 helper。
 */

import { parse, walk } from 'css-tree'

export type { CnFontCdnDescriptor } from '#core/text/font/registry'

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

/** 把解析后的 ranges 还原为 CSS unicode-range 描述符串（FontFace 注册用） */
export function formatUnicodeRanges(ranges: ReadonlyArray<readonly [number, number]>): string {
  const hex = (value: number) => value.toString(16).toUpperCase()
  return ranges
    .map(([low, high]) => (low === high ? `U+${hex(low)}` : `U+${hex(low)}-${hex(high)}`))
    .join(', ')
}

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
