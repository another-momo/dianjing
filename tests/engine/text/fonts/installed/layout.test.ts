/**
 * layout 路径推导测试。
 *
 * 覆盖：
 *  - resolveFontsRoot 拼接 rootDir + fonts/v1
 *  - fullFontRelativePath 路径 = <prefix>/<hash>.<ext>
 *  - subsetPieceRelativePath 路径 = <slug>/<pieceHash>.ttf
 *  - subsetFamilyRelativeDir slug 推导
 *  - layoutFor 全量 / 分片双形态（family 必填检查）
 *  - slugifyFamilyName 大小写归一 / 非 ASCII 字符替换 / 折叠连字符 / 兜底
 *  - hashBytesToHex 截前缀 32 字符
 */
import { describe, expect, test } from 'bun:test'

import {
  FONTS_ROOT_SUBDIR,
  FONTS_SCHEMA_VERSION,
  fullFontRelativePath,
  hashBytesToHex,
  layoutFor,
  resolveFontsRoot,
  subsetFamilyRelativeDir,
  subsetPieceRelativePath,
  slugifyFamilyName
} from '#core/text/font/installed/layout'

const HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

describe('resolveFontsRoot', () => {
  test('拼 rootDir + fonts/v1', () => {
    expect(resolveFontsRoot('/tmp/state')).toBe('/tmp/state/fonts/v1')
  })

  test('rootDir 尾随 / 折叠', () => {
    expect(resolveFontsRoot('/tmp/state///')).toBe('/tmp/state/fonts/v1')
  })

  test('rootDir 不带尾 / 时正常', () => {
    expect(resolveFontsRoot('/var/data')).toBe('/var/data/fonts/v1')
  })

  test('常量稳定', () => {
    expect(FONTS_ROOT_SUBDIR).toBe('fonts')
    expect(FONTS_SCHEMA_VERSION).toBe('v1')
  })
})

describe('fullFontRelativePath', () => {
  test('路径 = <前两 hex>/<hash>.<ext>', () => {
    expect(fullFontRelativePath(HASH, 'ttf')).toBe('a1/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.ttf')
    expect(fullFontRelativePath(HASH, 'woff2')).toBe('a1/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.woff2')
  })

  test('hash 前两字符作为子目录', () => {
    const other = 'ff'.padEnd(32, 'f')
    expect(fullFontRelativePath(other, 'otf')).toBe(`ff/${other}.otf`)
  })
})

describe('subsetPieceRelativePath', () => {
  test('族名 + 片 hash → <slug>/<hash>.ttf', () => {
    expect(subsetPieceRelativePath('Source Han Serif CN', HASH)).toBe(
      `source-han-serif-cn/${HASH}.ttf`
    )
  })

  test('族名带空格 → slug 折叠', () => {
    expect(subsetPieceRelativePath('Noto Sans SC VF', HASH)).toBe(`noto-sans-sc-vf/${HASH}.ttf`)
  })

  test('族名含非 ASCII → slug UTF-8 字节编码（可逆、唯一）', () => {
    const a = subsetPieceRelativePath('思源黑体', HASH)
    const b = subsetPieceRelativePath('平方江西黑', HASH)
    // 两个不同 CJK 族不得坍缩到同一目录
    expect(a).not.toBe(b)
    expect(a.startsWith('family/')).toBe(false)
    // 编码形态：~xNN 序列，仅含目录安全字符
    expect(a).toMatch(/^[a-z0-9\-_~]+\//)
  })
})

describe('subsetFamilyRelativeDir', () => {
  test('族目录 = 族名 slug', () => {
    expect(subsetFamilyRelativeDir('Roboto')).toBe('roboto')
    expect(subsetFamilyRelativeDir('Noto Sans SC')).toBe('noto-sans-sc')
  })

  test('空族名兜底 family', () => {
    expect(subsetFamilyRelativeDir('')).toBe('family')
  })
})

describe('layoutFor', () => {
  test('full artifact：full 字段填，subsetFamilyDir null', () => {
    const layout = layoutFor('full', HASH)
    expect(layout.full).toBe(`a1/${HASH}.ttf`)
    expect(layout.subsetFamilyDir).toBe(null)
  })

  test('subset-collection artifact：family 必填（缺则 throw）', () => {
    expect(() => layoutFor('subset-collection', HASH)).toThrow(/requires non-empty family/)
  })

  test('subset-collection artifact：subsetFamilyDir = slug，full null', () => {
    const layout = layoutFor('subset-collection', HASH, 'Source Han Serif CN')
    expect(layout.subsetFamilyDir).toBe('source-han-serif-cn')
    expect(layout.full).toBe(null)
  })
})

describe('slugifyFamilyName', () => {
  test('基础：保持小写 + 字母数字 + 连字符下划线', () => {
    expect(slugifyFamilyName('Roboto')).toBe('roboto')
    expect(slugifyFamilyName('roboto-mono')).toBe('roboto-mono')
    expect(slugifyFamilyName('a_b_c')).toBe('a_b_c')
  })

  test('大小写归一', () => {
    expect(slugifyFamilyName('Inter')).toBe('inter')
    expect(slugifyFamilyName('INTER')).toBe('inter')
    expect(slugifyFamilyName('Inter Display')).toBe('inter-display')
  })

  test('非 ASCII 字符处理：CJK 编码、空白/标点归连字符', () => {
    // CJK 族名 ~xNN 编码：不坍缩、各族唯一
    const a = slugifyFamilyName('思源黑体')
    const b = slugifyFamilyName('平方江西黑')
    expect(a).not.toBe('family')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[a-z0-9_~-]+$/)
    // 拉丁 + 空白混合：空白归连字符（原语义）
    expect(slugifyFamilyName('LXGW WenKai')).toBe('lxgw-wenkai')
    expect(slugifyFamilyName('foo/bar')).toBe('foo-bar')
  })

  test('连续连字符折叠', () => {
    expect(slugifyFamilyName('foo   bar')).toBe('foo-bar')
    expect(slugifyFamilyName('foo---bar')).toBe('foo-bar')
    expect(slugifyFamilyName('foo!@#bar')).toBe('foo-bar')
  })

  test('头尾连字符剥', () => {
    expect(slugifyFamilyName('-foo-')).toBe('foo')
    expect(slugifyFamilyName('!!!')).toBe('family')
  })

  test('空字符串 → family', () => {
    expect(slugifyFamilyName('')).toBe('family')
  })
})

describe('hashBytesToHex', () => {
  test('截前缀 32 字符', () => {
    const full = 'abcdef0123456789'.repeat(4) // 64 字符
    const hasher = (): string => full
    const bytes = new Uint8Array([1])
    expect(hashBytesToHex(bytes, hasher)).toBe(full.slice(0, 32))
  })

  test('短摘要也截前 32', () => {
    const short = '1234'
    const hasher = (): string => short
    const bytes = new Uint8Array([1])
    expect(hashBytesToHex(bytes, hasher)).toBe(short)
  })

  test('字节流过 hasher 一致', () => {
    const calls: Uint8Array[] = []
    const hasher = (bytes: Uint8Array): string => {
      calls.push(bytes)
      return 'abcd'.repeat(8)
    }
    const bytes = new Uint8Array([1, 2, 3])
    hashBytesToHex(bytes, hasher)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(bytes)
  })
})
