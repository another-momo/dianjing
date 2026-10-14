/**
 * Noto Sans SC bundled VF 钉扎（换族门槛的常设回归）：
 * ① fetchBundledFont 通路取字节 + opentype.js 解析（glyph 水位 + 中西文标点 cmap + fvar 轴）；
 * ② 生产嗅探入账（variableWeightRange 100-900）+ namedInstanceVariations 解 Bold→wght 700；
 * ③ CanvasKit 注册 + fontVariations 注入 wght 100/400/900 排版宽度递增（轴注入生效）。
 *
 * 资产由 tools/font-subset/subset-fonts.py 复跑再生（charset-cjk.txt 9031 字表）。
 */
import { describe, expect, test } from 'bun:test'

import * as opentype from 'opentype.js'

import { getCanvasKit } from '@open-pencil/core'
import { FontManager } from '@open-pencil/core/text'

const VF_URL = '/NotoSansSC-VF.ttf'
const FAMILY = 'Noto Sans SC'

describe('Noto Sans SC bundled VF', () => {
  test('① bundled 字节可取 + opentype.js 解析（glyph 水位/cmap/fvar）', async () => {
    const manager = new FontManager()
    const bytes = await manager.fetchBundledFont(VF_URL)
    expect(bytes).toBeTruthy()
    if (!bytes) return

    const font = opentype.parse(bytes.slice(0))
    expect(font.glyphs.length).toBeGreaterThan(9000)
    for (const ch of ['中', 'A', '。']) {
      expect(font.charToGlyphIndex(ch)).toBeGreaterThan(0)
    }
    const fvar = font.tables.fvar as
      | { axes?: { tag: string; minValue: number; maxValue: number }[] }
      | undefined
    const wght = fvar?.axes?.find((axis) => axis.tag === 'wght')
    expect(wght?.minValue).toBe(100)
    expect(wght?.maxValue).toBe(900)
  })

  test('② 生产嗅探入账：wght 区间 100-900 + Bold 解轴 wght=700', async () => {
    const manager = new FontManager()
    const bytes = await manager.loadFont(FAMILY, 'Bold')
    expect(bytes).toBeTruthy()

    expect(manager.variableWeightRange(FAMILY)).toEqual({ min: 100, max: 900 })
    const variations = manager.namedInstanceVariations(FAMILY, 'Bold')
    expect(variations?.find((variation) => variation.axis === 'wght')?.value).toBe(700)
  })

  test('③ CanvasKit 注册 + wght 100/400/900 排版宽度递增（轴注入生效）', async () => {
    const manager = new FontManager()
    const bytes = await manager.fetchBundledFont(VF_URL)
    expect(bytes).toBeTruthy()
    if (!bytes) return

    const ck = await getCanvasKit()
    const typeface = ck.Typeface.MakeFreeTypeFaceFromData(bytes.slice(0))
    expect(typeface).toBeTruthy()
    if (!typeface) return

    const probeFont = new ck.Font(typeface, 40)
    for (const gid of probeFont.getGlyphIDs('中A。')) {
      expect(gid).toBeGreaterThan(0)
    }

    const provider = ck.TypefaceFontProvider.Make()
    provider.registerFont(bytes.slice(0), 'NotoVFProbe')
    const widths: number[] = []
    for (const value of [100, 400, 900]) {
      const builder = ck.ParagraphBuilder.MakeFromFontProvider(
        new ck.ParagraphStyle({
          textStyle: new ck.TextStyle({
            color: ck.BLACK,
            fontFamilies: ['NotoVFProbe'],
            fontSize: 40,
            fontVariations: [{ axis: 'wght', value }]
          })
        }),
        provider
      )
      builder.addText('中文 OpenPencil 123')
      const paragraph = builder.build()
      paragraph.layout(1000)
      widths.push(paragraph.getMaxIntrinsicWidth())
      paragraph.delete()
      builder.delete()
    }
    expect(widths[0]).toBeLessThan(widths[1])
    expect(widths[1]).toBeLessThan(widths[2])
  })
})
