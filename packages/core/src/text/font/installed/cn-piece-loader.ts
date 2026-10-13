/**
 * 渲染期本地分片加载器（subset-collection artifact）。
 *
 * 形态：纯逻辑 + 注入 fetch——core 域不依赖 HTTP；renderer 侧把
 * pi-backend 的两个端点适配为 PieceFetchLike 后注入。
 *
 * 数据流（与 cn-fonts.ts resolver.fetch 对齐）：
 *  1) pieces index 端点 → SubsetIndex（styleKey/weight/italic/hash/size/ranges）
 *  2) 按 styleKey 精确过滤该 style 的所有片条目（VF 族走单 variable 条目，
 *     weight 恒 400；按 weight/italic 推断会过滤为零导致静默回退——这里用
 *     安装清单里已解析出的真值 styleKey 选片，与 userFontProvider.list() →
 *     matchUserStyleKey 解析的 key 一致）
 *  3) 按 characters 命中 ranges 选片（selectCnFontPieces 复用既有语义；
 *     喂入 weight/italic 取首条目值——与 install 时 style 入 manifest 的
 *     weight/italic 字段对齐，subset-collection 族在选片端不走变量推算）
 *  4) 并发 4 拉片字节（piece 端点）
 *  5) 拼出 { primary, supplemental[] }——首片为 primary（与 fonts.ts CDN 路径同）
 *
 * 失败语义：全程不 throw——任一环节失败返 null（与 cnFontSubsetResolver.fetch
 * 契约一致），调用方回退 unifont 链。
 */

import {
  selectCnFontPieces,
  type CnFontFacePiece,
  type CnFontFetchedPiece
} from '#core/text/web-font/cn-fonts'

/** 端点侧 pieces/piece 端点契约最小化——便于注入替换 */
export interface PieceFetchLike {
  /** 拉族分片索引（GET .../pieces?family=） */
  fetchIndex(family: string): Promise<SubsetIndexPayload | null>
  /** 拉单片字节（GET .../piece?family=&hash=） */
  fetchPiece(family: string, hash: string): Promise<ArrayBuffer | null>
}

/** SubsetIndex 端点返回 JSON 形态（与 pi-backend store.ts SubsetIndex 一致） */
export interface SubsetIndexPayload {
  family: string
  styles: SubsetIndexEntryPayload[]
}

export interface SubsetIndexEntryPayload {
  styleKey: string
  weight: number
  italic: boolean
  hash: string
  size: number
  ranges: Array<[number, number]>
}

/** 选片 + 取片结果——primary 必有，supplemental 可空（与 cnFontSubsetResult 对齐） */
export interface LoadedPieces {
  primary: CnFontFetchedPiece
  supplemental: CnFontFetchedPiece[]
  /** 实际被覆盖的字符（与 cnFontSubsetResolver 同语义，供 remoteCoverage 精确记账） */
  coveredCharacters: string[]
}

function rangeCovers(ranges: ReadonlyArray<readonly [number, number]>, codePoint: number): boolean {
  return ranges.some(([low, high]) => codePoint >= low && codePoint <= high)
}

/**
 * 给定 family/styleKey/characters → 拉本地分片。失败返 null。
 * 并发拉片上限 4（与安装管线对齐，避免大量请求压垮 pi-backend）。
 *
 * styleKey 是安装清单里已解析出的真值 key（list 端点 styles[].key）——
 * 用它精确匹配 index 条目；不要在 loader 内对 style 字符串做 weight/italic
 * 推断（VF 族 weight 恒 400，按 weight 推必过滤为零）。
 */
export async function loadInstalledSubsetPieces(
  family: string,
  styleKey: string,
  characters: string,
  fetchImpl: PieceFetchLike
): Promise<LoadedPieces | null> {
  try {
    const index = await fetchImpl.fetchIndex(family)
    if (!index) return null
    // 按 styleKey 精确匹配该 style 的所有片条目（range 选片需要 piece-level 视角）
    const styleEntries = index.styles.filter((s) => s.styleKey === styleKey)
    if (styleEntries.length === 0) return null
    // weight/italic 取首条目值喂 selectCnFontPieces（与 install 写入 manifest
    // 的 weight/italic 字段对齐——subset-collection 族在选片端不走变量推算）
    const firstEntry = styleEntries[0]
    const weight = firstEntry.weight
    const italic = firstEntry.italic
    // 构造 CnFontFacePiece[]（url 字段填 piece 端点 URL 字符串 + styleKey
    // 派生族内去重键）
    const pieces: CnFontFacePiece[] = styleEntries.map((s) => ({
      url: `${family}|${s.hash}`,
      weight: s.weight,
      italic: s.italic,
      ranges: s.ranges
    }))
    // 复用 selectCnFontPieces：按字符命中 ranges 选片（去重 key = url）
    const selected = selectCnFontPieces(pieces, characters, weight, italic)
    if (selected.length === 0) return null
    // 按 url 找回原始 SubsetIndexEntry（selected 顺序 = 命中顺序）
    const lookup = new Map(selected.map((p) => [p.url, p]))
    const targets: SubsetIndexEntryPayload[] = []
    for (const entry of styleEntries) {
      const url = `${family}|${entry.hash}`
      if (lookup.has(url)) targets.push(entry)
    }
    if (targets.length === 0) return null
    // 并发 4 拉片
    const limit = Math.min(4, targets.length)
    const fetched: CnFontFetchedPiece[] = []
    const errors: string[] = []
    let cursor = 0
    await Promise.all(
      Array.from({ length: limit }, async () => {
        for (;;) {
          const idx = cursor++
          if (idx >= targets.length) return
          const target = targets[idx]
          try {
            const buffer = await fetchImpl.fetchPiece(family, target.hash)
            if (!buffer) {
              errors.push(`piece fetch returned null: ${target.hash}`)
              continue
            }
            fetched.push({ url: target.hash, buffer, ranges: target.ranges })
          } catch (error) {
            errors.push(
              `piece ${target.hash}: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
      })
    )
    if (fetched.length === 0) return null
    // coveredCharacters：被至少一片覆盖的请求字符
    const covered: string[] = []
    for (const character of new Set(characters)) {
      const codePoint = character.codePointAt(0)
      if (codePoint === undefined) continue
      if (fetched.some((f) => rangeCovers(f.ranges, codePoint))) covered.push(character)
    }
    const [primary, ...supplemental] = fetched
    return { primary, supplemental, coveredCharacters: covered }
  } catch {
    return null
  }
}
