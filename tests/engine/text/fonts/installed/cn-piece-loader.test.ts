/**
 * cn-piece-loader 选片路由测试。
 *
 * 覆盖：
 *  - 输入字符命中某片 ranges → fetchPiece 该片 URL；未命中跳过
 *  - 多片覆盖（连续 + 不连续 ranges）按 selectCnFontPieces 命中逻辑取片
 *  - primary/supplemental 路由：characters 全部覆盖 → primary
 *  - 端点侧 null/failure → 整体 null（不抛）
 *  - styleKey 精确过滤：同族多 styleKey 条目只取匹配 key 的片
 *  - VF 族（单 variable 条目 weight 恒 400）按 styleKey='Variable' 精确命中
 */

import { describe, expect, test } from 'bun:test'

import {
  loadInstalledSubsetPieces,
  type PieceFetchLike,
  type SubsetIndexPayload
} from '@open-pencil/core/text/font/installed/cn-piece-loader'

function makeIndex(
  entries: Array<{
    key: string
    weight: number
    italic: boolean
    hash: string
    ranges: Array<[number, number]>
  }>
): SubsetIndexPayload {
  return {
    family: 'TestFamily',
    styles: entries.map((e) => ({
      styleKey: e.key,
      weight: e.weight,
      italic: e.italic,
      hash: e.hash,
      size: 1024,
      ranges: e.ranges
    }))
  }
}

function makeFetch(
  index: SubsetIndexPayload,
  bytesByHash: Map<string, Uint8Array>
): { fetch: PieceFetchLike; hits: { family: string; hash: string }[] } {
  const hits: { family: string; hash: string }[] = []
  const fetch: PieceFetchLike = {
    fetchIndex: async () => index,
    fetchPiece: async (family, hash) => {
      hits.push({ family, hash })
      const buf = bytesByHash.get(hash)
      if (!buf) return null
      // 返回 ArrayBuffer（端点契约）
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    }
  }
  return { fetch, hits }
}

describe('cn-piece-loader 选片路由', () => {
  test('字符命中 → fetchPiece 该片；未命中跳过', async () => {
    const index = makeIndex([
      { key: 'Regular', weight: 400, italic: false, hash: 'aaaa', ranges: [[0x4e00, 0x4fff]] }
    ])
    const bytes = new Uint8Array([0, 1, 2, 3])
    const { fetch, hits } = makeFetch(index, new Map([['aaaa', bytes]]))

    // "中" = U+4E2D 落在 0x4E00-0x4FFF
    const result = await loadInstalledSubsetPieces('TestFamily', 'Regular', '中', fetch)
    expect(result).not.toBeNull()
    expect(result!.primary.buffer.byteLength).toBe(4)
    expect(hits.length).toBe(1)
    expect(hits[0]).toEqual({ family: 'TestFamily', hash: 'aaaa' })
  })

  test('字符未命中 ranges → 拉片 0 次，primary 空', async () => {
    const index = makeIndex([
      { key: 'Regular', weight: 400, italic: false, hash: 'aaaa', ranges: [[0x4e00, 0x4fff]] }
    ])
    const { fetch, hits } = makeFetch(index, new Map())

    // "A" = U+0041 不在 0x4E00-0x4FFF
    const result = await loadInstalledSubsetPieces('TestFamily', 'Regular', 'A', fetch)
    expect(result).toBeNull()
    expect(hits.length).toBe(0)
  })

  test('多片连续 ranges → 按 selectCnFontPieces 命中取片', async () => {
    const index = makeIndex([
      { key: 'Regular', weight: 400, italic: false, hash: 'p1', ranges: [[0x4e00, 0x4e7f]] },
      { key: 'Regular', weight: 400, italic: false, hash: 'p2', ranges: [[0x4e80, 0x4fff]] }
    ])
    const { fetch, hits } = makeFetch(
      index,
      new Map([
        ['p1', new Uint8Array([1])],
        ['p2', new Uint8Array([2])]
      ])
    )
    // "中" = 0x4E2D 命中 p1
    const result = await loadInstalledSubsetPieces('TestFamily', 'Regular', '中', fetch)
    expect(result).not.toBeNull()
    expect(hits.map((h) => h.hash)).toEqual(['p1'])
    expect(result!.primary.buffer.byteLength).toBe(1)
  })

  test('多片不连续 ranges → 取所有命中片（合并）', async () => {
    const index = makeIndex([
      { key: 'Regular', weight: 400, italic: false, hash: 'p1', ranges: [[0x4e00, 0x4e7f]] },
      { key: 'Regular', weight: 400, italic: false, hash: 'p2', ranges: [[0x5000, 0x507f]] }
    ])
    const { fetch, hits } = makeFetch(
      index,
      new Map([
        ['p1', new Uint8Array([1])],
        ['p2', new Uint8Array([2])]
      ])
    )
    // "中"=0x4E2D 命中 p1；"倀"=0x500C 命中 p2
    const result = await loadInstalledSubsetPieces('TestFamily', 'Regular', '中倀', fetch)
    expect(result).not.toBeNull()
    expect(hits.length).toBe(2)
    // primary + supplemental 合并 2 字节
    const totalBytes =
      result!.primary.buffer.byteLength +
      result!.supplemental.reduce((sum, p) => sum + p.buffer.byteLength, 0)
    expect(totalBytes).toBe(2)
  })

  test('styleKey 精确过滤：同族多 styleKey 条目只取匹配 key 的片', async () => {
    const index = makeIndex([
      { key: 'Regular', weight: 400, italic: false, hash: 'r', ranges: [[0x4e00, 0x4fff]] },
      { key: 'Bold', weight: 700, italic: false, hash: 'b', ranges: [[0x4e00, 0x4fff]] },
      { key: 'Italic', weight: 400, italic: true, hash: 'i', ranges: [[0x4e00, 0x4fff]] }
    ])
    const { fetch, hits } = makeFetch(
      index,
      new Map([
        ['r', new Uint8Array([1])],
        ['b', new Uint8Array([2])],
        ['i', new Uint8Array([3])]
      ])
    )
    const result = await loadInstalledSubsetPieces('TestFamily', 'Bold', '中', fetch)
    expect(result).not.toBeNull()
    expect(hits.map((h) => h.hash)).toEqual(['b'])
    expect(result!.primary.buffer.byteLength).toBe(1)
  })

  test('VF 族：index 单 variable 条目 weight 恒 400，styleKey=Variable 精确命中', async () => {
    // 复现 cn-fonts adapter 的 VF 族形态：list 端点只暴露单 variable 条目，
    // weight 恒 400（变量推算不在选片端走）；按 styleKey='Variable' 精确匹配
    // → 命中；旧 weight/italic 推断必过滤为零（验证静默回退已修）
    const index = makeIndex([
      { key: 'Variable', weight: 400, italic: false, hash: 'v1', ranges: [[0x4e00, 0x4e7f]] },
      { key: 'Variable', weight: 400, italic: false, hash: 'v2', ranges: [[0x5000, 0x507f]] }
    ])
    const { fetch, hits } = makeFetch(
      index,
      new Map([
        ['v1', new Uint8Array([1])],
        ['v2', new Uint8Array([2])]
      ])
    )
    // "中"=0x4E2D 命中 v1；"倀"=0x500C 命中 v2
    const result = await loadInstalledSubsetPieces('TestFamily', 'Variable', '中倀', fetch)
    expect(result).not.toBeNull()
    expect(hits.length).toBe(2)
    const totalBytes =
      result!.primary.buffer.byteLength +
      result!.supplemental.reduce((sum, p) => sum + p.buffer.byteLength, 0)
    expect(totalBytes).toBe(2)
  })

  test('VF 族：styleKey 不匹配时 → 整体 null（不静默回退）', async () => {
    const index = makeIndex([
      { key: 'Variable', weight: 400, italic: false, hash: 'v1', ranges: [[0x4e00, 0x4fff]] }
    ])
    const { fetch, hits } = makeFetch(index, new Map([['v1', new Uint8Array([1])]]))
    // 装清单里只有 Variable，请求侧误传 'Regular' → 过滤为零 → null
    const result = await loadInstalledSubsetPieces('TestFamily', 'Regular', '中', fetch)
    expect(result).toBeNull()
    expect(hits.length).toBe(0)
  })

  test('端点返 null → 整体 null（不抛）', async () => {
    const fetch: PieceFetchLike = {
      fetchIndex: async () => null,
      fetchPiece: async () => null
    }
    const result = await loadInstalledSubsetPieces('TestFamily', 'Regular', '中', fetch)
    expect(result).toBeNull()
  })

  test('fetchPiece 返 null → 整体 null（不抛）', async () => {
    const index = makeIndex([
      { key: 'Regular', weight: 400, italic: false, hash: 'aaaa', ranges: [[0x4e00, 0x4fff]] }
    ])
    const fetch: PieceFetchLike = {
      fetchIndex: async () => index,
      fetchPiece: async () => null
    }
    const result = await loadInstalledSubsetPieces('TestFamily', 'Regular', '中', fetch)
    expect(result).toBeNull()
  })

  test('空 characters → 整体 null（无需求）', async () => {
    const index = makeIndex([
      { key: 'Regular', weight: 400, italic: false, hash: 'aaaa', ranges: [[0x4e00, 0x4fff]] }
    ])
    const { fetch, hits } = makeFetch(index, new Map([['aaaa', new Uint8Array([1])]]))
    const result = await loadInstalledSubsetPieces('TestFamily', 'Regular', '', fetch)
    expect(result).toBeNull()
    expect(hits.length).toBe(0)
  })

  test('coveredCharacters 字段返回命中字符集', async () => {
    const index = makeIndex([
      { key: 'Regular', weight: 400, italic: false, hash: 'p1', ranges: [[0x4e00, 0x4e7f]] }
    ])
    const { fetch } = makeFetch(index, new Map([['p1', new Uint8Array([1])]]))
    const result = await loadInstalledSubsetPieces('TestFamily', 'Regular', '中', fetch)
    expect(result).not.toBeNull()
    expect(result!.coveredCharacters).toContain('中')
  })
})
