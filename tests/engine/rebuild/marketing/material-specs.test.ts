/**
 * 物料规格库契约测试：起始集钉扎（id / 宽高 / HUG 形态 / notes 有无）+ 别名
 * 解析（trim / 大小写 / CJK 俗名 / 比例俗名）+ 默认兜底条目显式引用（非常量
 * 数组位置约定）。
 */

import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_MATERIAL_SPEC,
  MATERIAL_SPEC_IDS,
  MATERIAL_SPECS,
  resolveMaterialAlias,
  type MaterialSpec
} from '#core/tools/fork/marketing/material-specs'

describe('物料规格库：起始集与默认兜底', () => {
  test('起始集钉扎：14 条物料的 id / 宽 / 高（null = HUG 流高）', () => {
    expect(MATERIAL_SPECS.map((spec) => [spec.id, spec.width, spec.height])).toEqual([
      ['long-image', 750, null],
      ['ig-square', 1080, 1080],
      ['ig-portrait', 1080, 1350],
      ['xhs-cover', 1080, 1440],
      ['wechat-cover', 900, 383],
      ['slides-16x9', 1920, 1080],
      ['x-post', 1200, 675],
      ['x-header', 1500, 500],
      ['story-9x16', 1080, 1920],
      ['ecommerce-main', 800, 800],
      ['youtube-thumbnail', 1280, 720],
      ['link-card', 1200, 630],
      ['bilibili-cover', 1320, 824],
      ['a4-print', 2480, 3508]
    ])
    expect(MATERIAL_SPEC_IDS).toEqual(MATERIAL_SPECS.map((spec) => spec.id))
  })

  test('DEFAULT_MATERIAL_SPEC = 长图兜底条目（常量引用同一对象，非数组位置约定）', () => {
    expect(DEFAULT_MATERIAL_SPEC.id).toBe('long-image')
    expect(MATERIAL_SPECS).toContain(DEFAULT_MATERIAL_SPEC)
    expect(DEFAULT_MATERIAL_SPEC.height).toBeNull()
  })

  test('条目形状：label 非空 + aliases 非空 + width 正数', () => {
    for (const spec of MATERIAL_SPECS) {
      expect(spec.label.length).toBeGreaterThan(0)
      expect(spec.aliases.length).toBeGreaterThan(0)
      expect(spec.width).toBeGreaterThan(0)
    }
  })
})

describe('notes 准入：仅有实证条目填；命中回执 just-in-time 投递', () => {
  test('notes 准入五条：公众号封面 / 方形 / 竖版 / 小红书 / 全屏竖屏', () => {
    const byId = new Map(MATERIAL_SPECS.map((s) => [s.id, s]))
    expect(byId.get('wechat-cover')?.notes).toBeTruthy()
    expect(byId.get('ig-square')?.notes).toBeTruthy()
    expect(byId.get('ig-portrait')?.notes).toBeTruthy()
    expect(byId.get('xhs-cover')?.notes).toBeTruthy()
    expect(byId.get('story-9x16')?.notes).toBeTruthy()
  })

  test('notes 缺席条目：无 notes 字段（不写 notes 键——诚实空着）', () => {
    const noNotesIds = [
      'long-image',
      'slides-16x9',
      'x-post',
      'x-header',
      'ecommerce-main',
      'youtube-thumbnail',
      'link-card',
      'bilibili-cover',
      'a4-print'
    ]
    for (const id of noNotesIds) {
      const spec = MATERIAL_SPECS.find((s) => s.id === id) as MaterialSpec | undefined
      expect(spec).toBeDefined()
      expect(spec?.notes).toBeUndefined()
      // keys 集合也验：notes 缺席条目绝不出现 notes 键（即便将来 with notes
      // 默认值也不污染未实证条目）
      expect(Object.keys(spec ?? {}).includes('notes')).toBe(false)
    }
  })
})

describe('resolveMaterialAlias：trim + 小写化后按 id / label / aliases 命中', () => {
  test('id 命中（大小写不敏感 + 首尾空白容忍）', () => {
    expect(resolveMaterialAlias('ig-square')?.id).toBe('ig-square')
    expect(resolveMaterialAlias(' IG-SQUARE ')?.id).toBe('ig-square')
  })

  test('平台俗名命中：instagram → 方形；显式竖版 → portrait（不误中方形条目）', () => {
    expect(resolveMaterialAlias('instagram')?.id).toBe('ig-square')
    expect(resolveMaterialAlias('Ins Portrait')?.id).toBe('ig-portrait')
    expect(resolveMaterialAlias('instagram 竖版')?.id).toBe('ig-portrait')
  })

  test('CJK 别名命中：小红书 / 方形 / 全屏竖屏；label 命中：长图', () => {
    expect(resolveMaterialAlias('小红书')?.id).toBe('xhs-cover')
    expect(resolveMaterialAlias(' 方形')?.id).toBe('ig-square')
    expect(resolveMaterialAlias('全屏竖屏')?.id).toBe('story-9x16')
    expect(resolveMaterialAlias('长图')?.id).toBe('long-image')
  })

  test('比例俗名命中：3:4 / 4:5 / 16:9 / 9:16', () => {
    expect(resolveMaterialAlias('3:4')?.id).toBe('xhs-cover')
    expect(resolveMaterialAlias('4:5')?.id).toBe('ig-portrait')
    expect(resolveMaterialAlias('16:9')?.id).toBe('slides-16x9')
    expect(resolveMaterialAlias('9:16')?.id).toBe('story-9x16')
  })

  test('改名条目命中：banner / 横幅 → x-header；banner-wide id 仍命中（库不存旧 id）', () => {
    expect(resolveMaterialAlias('banner')?.id).toBe('x-header')
    expect(resolveMaterialAlias('横幅')?.id).toBe('x-header')
    expect(resolveMaterialAlias('banner-wide')).toBeNull()
  })

  test('新增条目平台俗名命中：tiktok / 抖音 / youtube / og', () => {
    expect(resolveMaterialAlias('tiktok')?.id).toBe('story-9x16')
    expect(resolveMaterialAlias('抖音')?.id).toBe('story-9x16')
    expect(resolveMaterialAlias('youtube')?.id).toBe('youtube-thumbnail')
    expect(resolveMaterialAlias('og')?.id).toBe('link-card')
  })

  test('未知名 / 空串 / 像素串 → null（像素串由像素解析先行，不入库）', () => {
    expect(resolveMaterialAlias('myspace')).toBeNull()
    expect(resolveMaterialAlias('')).toBeNull()
    expect(resolveMaterialAlias('   ')).toBeNull()
    expect(resolveMaterialAlias('750x')).toBeNull()
  })
})
