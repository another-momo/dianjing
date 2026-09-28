/**
 * 平台尺寸库契约测试：起始集钉扎（id / 宽高 / HUG 形态）+ 别名解析
 * （trim / 大小写 / CJK 俗名 / 比例俗名）+ 默认兜底条目显式引用（非常量
 * 数组位置约定）。
 */

import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_SIZE_PRESET,
  SIZE_PRESET_IDS,
  SIZE_PRESETS,
  resolveSizeAlias
} from '#core/tools/fork/marketing/sizes'

describe('平台尺寸库：起始集与默认兜底', () => {
  test('起始集钉扎：八条预设的 id / 宽 / 高（null = HUG 流高）', () => {
    expect(SIZE_PRESETS.map((preset) => [preset.id, preset.width, preset.height])).toEqual([
      ['long-image', 750, null],
      ['ig-square', 1080, 1080],
      ['ig-portrait', 1080, 1350],
      ['xhs-cover', 1080, 1440],
      ['wechat-cover', 900, 383],
      ['slides-16x9', 1920, 1080],
      ['x-post', 1200, 675],
      ['banner-wide', 1500, 500]
    ])
    expect(SIZE_PRESET_IDS).toEqual(SIZE_PRESETS.map((preset) => preset.id))
  })

  test('DEFAULT_SIZE_PRESET = 长图兜底条目（常量引用同一对象，非数组位置约定）', () => {
    expect(DEFAULT_SIZE_PRESET.id).toBe('long-image')
    expect(SIZE_PRESETS).toContain(DEFAULT_SIZE_PRESET)
    expect(DEFAULT_SIZE_PRESET.height).toBeNull()
  })

  test('条目形状：label 非空 + aliases 非空 + width 正数', () => {
    for (const preset of SIZE_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0)
      expect(preset.aliases.length).toBeGreaterThan(0)
      expect(preset.width).toBeGreaterThan(0)
    }
  })
})

describe('resolveSizeAlias：trim + 小写化后按 id / label / aliases 命中', () => {
  test('id 命中（大小写不敏感 + 首尾空白容忍）', () => {
    expect(resolveSizeAlias('ig-square')?.id).toBe('ig-square')
    expect(resolveSizeAlias(' IG-SQUARE ')?.id).toBe('ig-square')
  })

  test('平台俗名命中：instagram → 方形；显式竖版 → portrait（不误中方形条目）', () => {
    expect(resolveSizeAlias('instagram')?.id).toBe('ig-square')
    expect(resolveSizeAlias('Ins Portrait')?.id).toBe('ig-portrait')
    expect(resolveSizeAlias('instagram 竖版')?.id).toBe('ig-portrait')
  })

  test('CJK 别名命中：小红书 / 方形 / 横幅；label 命中：长图', () => {
    expect(resolveSizeAlias('小红书')?.id).toBe('xhs-cover')
    expect(resolveSizeAlias(' 方形')?.id).toBe('ig-square')
    expect(resolveSizeAlias('横幅')?.id).toBe('banner-wide')
    expect(resolveSizeAlias('长图')?.id).toBe('long-image')
  })

  test('比例俗名命中：3:4 / 4:5 / 16:9', () => {
    expect(resolveSizeAlias('3:4')?.id).toBe('xhs-cover')
    expect(resolveSizeAlias('4:5')?.id).toBe('ig-portrait')
    expect(resolveSizeAlias('16:9')?.id).toBe('slides-16x9')
  })

  test('未知名 / 空串 / 像素串 → null（像素串由像素解析先行，不入库）', () => {
    expect(resolveSizeAlias('myspace')).toBeNull()
    expect(resolveSizeAlias('')).toBeNull()
    expect(resolveSizeAlias('   ')).toBeNull()
    expect(resolveSizeAlias('750x')).toBeNull()
  })
})
