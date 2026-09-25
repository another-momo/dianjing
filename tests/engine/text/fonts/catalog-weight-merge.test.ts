/**
 * 字重聚合地面真值单测：钉住 10 组合并 base / 成员旧名 / 别名表键值 / 合并 weights，
 * 防 build.mjs / merge.mjs 规则漂移（长词优先、displayName 优先级、简繁独立等）。
 */
import { describe, expect, test } from 'bun:test'

import {
  CN_FONT_CATALOG,
  LEGACY_CN_FAMILY_ALIAS,
  cnCatalogEntry,
  isCnCatalogFamily
} from '#core/text/font/cn-catalog'

interface MergeGroup {
  base: string
  weights: number[]
  /** 组成员旧名（base 不在内；无 plain base 时全部成员都计入） */
  legacyNames: string[]
}

/** 10 组地面真值（base / weights 并集 / 组成员旧名）——与现役目录实跑分组一致。 */
const MERGE_GROUPS: MergeGroup[] = [
  {
    base: '极影毁片文宋',
    weights: [500],
    legacyNames: ['极影毁片文宋 Medium']
  },
  {
    base: 'LXGW Bright',
    weights: [300, 400, 500],
    legacyNames: ['LXGW Bright Light', 'LXGW Bright Medium']
  },
  {
    base: 'Maple Mono CN',
    weights: [100, 200, 300, 400, 500, 600, 700, 800],
    legacyNames: [
      'Maple Mono CN Thin',
      'Maple Mono CN ExtraLight',
      'Maple Mono CN Light',
      'Maple Mono CN Medium',
      'Maple Mono CN SemiBold',
      'Maple Mono CN ExtraBold'
    ]
  },
  {
    base: 'Moon Stars Kai',
    weights: [300, 400, 700],
    legacyNames: ['Moon Stars Kai Light']
  },
  {
    base: 'Moon Stars Kai HW',
    weights: [300, 400, 700],
    legacyNames: ['Moon Stars Kai HW Light']
  },
  {
    base: 'Moon Stars Kai T',
    weights: [300, 400, 700],
    legacyNames: ['Moon Stars Kai T Light']
  },
  {
    base: 'Moon Stars Kai T HW',
    weights: [300, 400, 700],
    legacyNames: ['Moon Stars Kai T HW Light']
  },
  {
    base: 'STDongGuanTi',
    weights: [300, 400],
    legacyNames: ['STDongGuanTi Light']
  },
  {
    base: 'ToneOZ-Pinyin-WenKai',
    weights: [300, 400, 500],
    legacyNames: [
      'ToneOZ-Pinyin-WenKai-Regular',
      'ToneOZ-Pinyin-WenKai-Light',
      'ToneOZ-Pinyin-WenKai-Medium'
    ]
  },
  {
    base: 'YuFanXinYu',
    weights: [300, 400, 500, 700],
    legacyNames: ['YuFanXinYu-Light', 'YuFanXinYu-Medium']
  }
]

describe('字重聚合地面真值', () => {
  test('10 组 base 全部在目录里、成员旧名全部不在目录', () => {
    const families = new Set(CN_FONT_CATALOG.map((entry) => entry.family))
    for (const group of MERGE_GROUPS) {
      expect(families.has(group.base)).toBe(true)
      for (const legacy of group.legacyNames) {
        expect(families.has(legacy)).toBe(false)
      }
    }
  })

  test('合并条目 weights = 组成员并集升序', () => {
    for (const group of MERGE_GROUPS) {
      const entry = cnCatalogEntry(group.base)
      expect(entry).toBeDefined()
      expect(entry?.weights).toEqual(group.weights)
    }
  })

  test('合并条目非 VF（static 档）—— 与地面真值一致', () => {
    for (const group of MERGE_GROUPS) {
      const entry = cnCatalogEntry(group.base)
      expect(entry?.variable).toBe(false)
    }
  })

  test('别名表键值与地面真值一致（每个旧名 → 对应 base）', () => {
    for (const group of MERGE_GROUPS) {
      for (const legacy of group.legacyNames) {
        expect(LEGACY_CN_FAMILY_ALIAS[legacy]).toBe(group.base)
      }
    }
  })

  test('别名表完整覆盖（条数 == 地面真值 legacyNames 总和 = 19）', () => {
    const expected = MERGE_GROUPS.reduce((sum, group) => sum + group.legacyNames.length, 0)
    expect(Object.keys(LEGACY_CN_FAMILY_ALIAS)).toHaveLength(expected)
  })

  test('cnCatalogEntry / isCnCatalogFamily 旧名跳别名指向合并条目', () => {
    for (const group of MERGE_GROUPS) {
      const target = cnCatalogEntry(group.base)
      expect(target).toBeDefined()
      for (const legacy of group.legacyNames) {
        expect(cnCatalogEntry(legacy)).toBe(target)
        expect(isCnCatalogFamily(legacy)).toBe(true)
      }
    }
  })

  test('极影毁片文宋 纯改名组：family 与原 displayName 同字 → 丢弃冗余 displayName', () => {
    const entry = cnCatalogEntry('极影毁片文宋')
    expect(entry?.displayName).toBeUndefined()
  })

  test('STDongGuanTi 合并后 displayName = 原 plain 成员（即 base 自有）', () => {
    const entry = cnCatalogEntry('STDongGuanTi')
    expect(entry?.displayName).toBe('上图东观体-常规')
  })
})

/**
 * 别名迁移（enabledCatalogFamilies 持久化恢复）单测：复用同源 sanitize 函数逻辑。
 * 这里只验证 sanitize 纯函数契约——picker 端到端链路（localStorage → fontManager）
 * 由浏览器实测覆盖。
 */
import { sanitizeLegacyCatalogFamilies } from '@/app/editor/fonts/sanitize-legacy-catalog-families'

describe('sanitizeLegacyCatalogFamilies（picker 持久化迁移纯函数）', () => {
  test('旧名映射到 base 并去重', () => {
    const input = [
      'LXGW Bright Light',
      'LXGW Bright Medium',
      'LXGW Bright',
      'LXGW Bright Light' // 重复
    ]
    const out = sanitizeLegacyCatalogFamilies(input)
    expect(out).toEqual(['LXGW Bright'])
  })

  test('多个组的旧名混合后各自映射到对应 base', () => {
    const input = [
      'Maple Mono CN Light',
      'LXGW Bright Medium',
      'STDongGuanTi Light',
      'YuFanXinYu-Medium',
      'YuFanXinYu-Light'
    ]
    const out = sanitizeLegacyCatalogFamilies(input)
    expect(out).toEqual(['Maple Mono CN', 'LXGW Bright', 'STDongGuanTi', 'YuFanXinYu'])
  })

  test('现役 base 名原样保留', () => {
    const input = ['LXGW Bright', 'Maple Mono CN']
    expect(sanitizeLegacyCatalogFamilies(input)).toEqual(['LXGW Bright', 'Maple Mono CN'])
  })

  test('空数组返回空', () => {
    expect(sanitizeLegacyCatalogFamilies([])).toEqual([])
  })
})
