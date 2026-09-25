/**
 * T42 S1 生成目录契约单测：cn-catalog.ts 是 tools/cn-font-catalog/src/build.mjs 的
 * 提交产物（运行时零枚举，D-b）。钉住结构契约 + 字重聚合契约（LEGACY 别名表 + 两函数
 * 别名兜底 + 简繁/直排变体独立），防手改/再生成漂移；重跑管线更新目录后本文件断言须同步复核。
 */
import { describe, expect, test } from 'bun:test'

import {
  CN_FONT_CATALOG,
  LEGACY_CN_FAMILY_ALIAS,
  cnCatalogEntry,
  isCnCatalogFamily
} from '#core/text/font/cn-catalog'
import { FONT_REGISTRY } from '#core/text/font/registry'

describe('CN_FONT_CATALOG 结构契约（T42 S1 生成物）', () => {
  test('必填字段齐全：family/package/version/license/weights 非空，variable 为布尔', () => {
    expect(CN_FONT_CATALOG.length).toBeGreaterThan(0)
    for (const entry of CN_FONT_CATALOG) {
      expect(entry.family.length).toBeGreaterThan(0)
      expect(entry.package.startsWith('@chinese-fonts/')).toBe(true)
      expect(entry.version.length).toBeGreaterThan(0)
      expect(entry.license.length).toBeGreaterThan(0)
      expect(typeof entry.variable).toBe('boolean')
      expect(entry.weights.length).toBeGreaterThan(0)
    }
  })

  test('weights 升序且为正整数；VF 族恰为区间端点两枚', () => {
    for (const entry of CN_FONT_CATALOG) {
      expect(entry.weights).toEqual([...entry.weights].sort((a, b) => a - b))
      for (const weight of entry.weights) {
        expect(Number.isInteger(weight)).toBe(true)
        expect(weight).toBeGreaterThan(0)
      }
      if (entry.variable) expect(entry.weights).toHaveLength(2)
    }
  })

  test('family 全局唯一；cnCatalogEntry/isCnCatalogFamily 命中一致', () => {
    expect(new Set(CN_FONT_CATALOG.map((entry) => entry.family)).size).toBe(CN_FONT_CATALOG.length)
    for (const entry of CN_FONT_CATALOG) {
      expect(cnCatalogEntry(entry.family)).toBe(entry)
      expect(isCnCatalogFamily(entry.family)).toBe(true)
    }
    expect(cnCatalogEntry('Inter')).toBeUndefined()
    expect(isCnCatalogFamily('不存在的字体')).toBe(false)
  })

  test('registry 精选 6 包的家族不入 catalog（精选层优先，D-b 分层）', () => {
    const registryPackages = new Set(
      FONT_REGISTRY.filter((entry) => entry.source === 'cdn').map((entry) => entry.cdn?.package)
    )
    expect(registryPackages.size).toBeGreaterThan(0)
    for (const entry of CN_FONT_CATALOG) {
      expect(registryPackages.has(entry.package)).toBe(false)
    }
  })

  test('registry cdn 家族不被 catalog 遮蔽（isCnCatalogFamily 恒假）', () => {
    for (const entry of FONT_REGISTRY) {
      if (entry.source !== 'cdn') continue
      expect(isCnCatalogFamily(entry.family)).toBe(false)
    }
  })

  test('全量目录零 base 回退（2026-09-06 复测 jsdelivr 已支持非 ASCII 路径）', () => {
    // 2026-08-30 构建时 37 族因 jsdelivr 非 ASCII 目录全边缘 404 带 base=unpkg；
    // 2026-09-06 复测 37/37 族全部子族目录在 jsdelivr 可达（含非 ASCII 目录名，
    // 与运行时同款原样拼接 URL），回退全量移除。管线 unpkg 探针已删除，
    // 再生成不会复活 base——钉 === 0 防僵尸漂移。
    const withBase = CN_FONT_CATALOG.filter((entry) => entry.base !== undefined)
    expect(withBase).toEqual([])
  })

  test('收录族含 VF（小禾简化 VF 区间字重 250-900，xiaohe-simplify@2.0.0）', () => {
    const variable = CN_FONT_CATALOG.filter((entry) => entry.variable)
    expect(variable.length).toBeGreaterThan(0)
    for (const entry of variable) {
      expect(entry.weights[0]).toBeLessThan(entry.weights[1])
    }
  })

  test('displayName：凡带 displayName 的条目，displayName 非空、含 CJK、且不等于 family', () => {
    for (const entry of CN_FONT_CATALOG) {
      if (entry.displayName === undefined) continue
      expect(entry.displayName.length).toBeGreaterThan(0)
      expect(/[\u4e00-\u9fff]/.test(entry.displayName)).toBe(true)
      expect(entry.displayName).not.toBe(entry.family)
    }
  })
})

describe('LEGACY_CN_FAMILY_ALIAS（字重聚合）', () => {
  test('别名表存在且每个值都指向现役族名', () => {
    const families = new Set(CN_FONT_CATALOG.map((entry) => entry.family))
    for (const [legacy, target] of Object.entries(LEGACY_CN_FAMILY_ALIAS)) {
      expect(families.has(target)).toBe(true)
      expect(legacy).not.toBe(target)
    }
  })

  test('别名键不在现役目录里（旧名真的从 CN_FONT_CATALOG 退出）', () => {
    const families = new Set(CN_FONT_CATALOG.map((entry) => entry.family))
    for (const legacy of Object.keys(LEGACY_CN_FAMILY_ALIAS)) {
      expect(families.has(legacy)).toBe(false)
    }
  })

  test('合并条目 weights 升序且无重复', () => {
    for (const entry of CN_FONT_CATALOG) {
      const deduped = [...new Set(entry.weights)]
      expect(entry.weights).toEqual(deduped)
      expect(entry.weights).toEqual([...entry.weights].sort((a, b) => a - b))
    }
  })

  test('GuanKiapTsingKhai 10 个简繁/直排变体俱在且独立（契约：字重聚合不收）', () => {
    const gtkk = CN_FONT_CATALOG.filter((entry) => entry.family.startsWith('GuanKiapTsingKhai'))
    const expected = [
      'GuanKiapTsingKhai',
      'GuanKiapTsingKhai-90',
      'GuanKiapTsingKhai-S',
      'GuanKiapTsingKhai-S-90',
      'GuanKiapTsingKhai-T',
      'GuanKiapTsingKhai-T-90',
      'GuanKiapTsingKhai-TW',
      'GuanKiapTsingKhai-TW-90',
      'GuanKiapTsingKhai-W',
      'GuanKiapTsingKhai-W-90'
    ]
    expect(gtkk.map((entry) => entry.family).sort()).toEqual([...expected].sort())
    expect(new Set(gtkk.map((entry) => entry.family)).size).toBe(expected.length)
  })

  test('cnCatalogEntry/isCnCatalogFamily 命中旧名跳别名指向合并条目', () => {
    for (const [legacy, target] of Object.entries(LEGACY_CN_FAMILY_ALIAS)) {
      const targetEntry = cnCatalogEntry(target)
      expect(targetEntry).toBeDefined()
      expect(cnCatalogEntry(legacy)).toBe(targetEntry)
      expect(isCnCatalogFamily(legacy)).toBe(true)
    }
  })
})
