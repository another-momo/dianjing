/**
 * manifest round-trip + 校验测试。
 *
 * 覆盖：
 *  - serialize → parse round-trip 等价性（含 VF 族 / displayName）
 *  - 校验拒绝矩阵（坏 version / 缺字段 / 类型错 / 域超界）
 *  - upsert/remove 行为（同 family + 同 key 覆盖 / 新增追加 / 删空族清壳）
 *  - toFamilyViews 聚合（总大小 = 各 style 之和 / 最新 installedAt）
 *  - 跨语言 / 多族多 style 入账
 */
import { describe, expect, test } from 'bun:test'

import {
  type FamilyEntry,
  type ManifestFile,
  type StyleEntry,
  MANIFEST_VERSION,
  emptyManifest,
  findFamilyIndex,
  findStyleIndex,
  parseManifest,
  removeFamily,
  removeStyle,
  serializeManifest,
  toFamilyViews,
  upsertStyle,
  validateManifest
} from '#core/text/font/installed/manifest'

function makeStyle(overrides: Partial<StyleEntry> = {}): StyleEntry {
  return {
    key: 'Regular',
    weight: 400,
    italic: false,
    variable: false,
    hash: 'a'.repeat(32),
    size: 1024,
    artifact: 'full',
    source: 'local-file',
    installedAt: 1700000000000,
    ...overrides
  }
}

function makeManifest(families: FamilyEntry[] = [], updatedAt = 1700000000000): ManifestFile {
  return { version: MANIFEST_VERSION, updatedAt, families }
}

describe('manifest.serialize + parse round-trip', () => {
  test('style.ext 字段 round-trip（缺省时省略字段）', () => {
    const withExt = makeManifest([{ family: 'F', styles: [makeStyle({ ext: 'otf' })] }])
    const parsed = parseManifest(serializeManifest(withExt))
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.manifest.families[0].styles[0].ext).toBe('otf')
    const withoutExt = makeManifest([{ family: 'F', styles: [makeStyle()] }])
    const parsed2 = parseManifest(serializeManifest(withoutExt))
    if (!parsed2.ok) throw new Error('expected ok')
    expect(parsed2.manifest.families[0].styles[0].ext).toBeUndefined()
  })

  test('style.ext 非法值拒收', () => {
    const raw = JSON.parse(
      serializeManifest(makeManifest([{ family: 'F', styles: [makeStyle()] }]))
    )
    raw.families[0].styles[0].ext = 'woff2'
    const parsed = parseManifest(JSON.stringify(raw))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected reject')
    expect(parsed.reason).toBe('bad-entry')
  })

  test('空 manifest round-trip：fields preserved', () => {
    const original = emptyManifest(12345)
    const parsed = parseManifest(serializeManifest(original))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.manifest).toEqual(original)
  })

  test('单族单 style round-trip：fields preserved', () => {
    const original = makeManifest([
      {
        family: 'Roboto',
        styles: [makeStyle({ key: 'Regular', weight: 400, hash: 'b'.repeat(32), size: 5000 })]
      }
    ])
    const parsed = parseManifest(serializeManifest(original))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.manifest).toEqual(original)
  })

  test('多族多 style round-trip：style 顺序保留', () => {
    const original = makeManifest([
      {
        family: 'Inter',
        displayName: 'Inter Display',
        styles: [
          makeStyle({ key: 'Regular', weight: 400 }),
          makeStyle({ key: 'Bold', weight: 700 }),
          makeStyle({ key: 'Medium Italic', weight: 500, italic: true })
        ]
      },
      {
        family: 'Noto Sans SC',
        styles: [makeStyle({ key: 'Regular', weight: 400, source: 'store' })]
      }
    ])
    const parsed = parseManifest(serializeManifest(original))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.manifest.families).toHaveLength(2)
    expect(parsed.manifest.families[0].styles).toHaveLength(3)
    expect(parsed.manifest.families[0].styles[2].italic).toBe(true)
  })

  test('VF 族 round-trip：wghtRange 完整保留', () => {
    const original = makeManifest([
      {
        family: 'Source Han Serif CN VF',
        styles: [
          makeStyle({
            key: 'Variable',
            weight: 400,
            variable: true,
            wghtRange: { min: 100, default: 400, max: 900 },
            hash: 'c'.repeat(32),
            size: 8_000_000
          })
        ]
      }
    ])
    const parsed = parseManifest(serializeManifest(original))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.manifest.families[0].styles[0].variable).toBe(true)
    expect(parsed.manifest.families[0].styles[0].wghtRange).toEqual({
      min: 100,
      default: 400,
      max: 900
    })
  })
})

describe('manifest.validateManifest rejection matrix', () => {
  test('version 不匹配 → bad-version', () => {
    const result = validateManifest({ version: 2, updatedAt: 0, families: [] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-version')
  })

  test('非对象 → bad-shape', () => {
    const result = validateManifest('not an object')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-shape')
  })

  test('updatedAt 不是 number → bad-shape', () => {
    const result = validateManifest({ version: MANIFEST_VERSION, updatedAt: 'oops', families: [] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-shape')
  })

  test('families 非数组 → bad-shape', () => {
    const result = validateManifest({ version: MANIFEST_VERSION, updatedAt: 0, families: 'no' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-shape')
  })

  test('family 非字符串 → bad-entry', () => {
    const result = validateManifest({
      version: MANIFEST_VERSION,
      updatedAt: 0,
      families: [{ family: 42, styles: [] }]
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-entry')
  })

  test('style 缺 key → bad-entry', () => {
    const result = validateManifest({
      version: MANIFEST_VERSION,
      updatedAt: 0,
      families: [
        {
          family: 'Foo',
          styles: [
            {
              weight: 400,
              italic: false,
              variable: false,
              hash: 'a',
              size: 1,
              artifact: 'full',
              source: 'local-file',
              installedAt: 0
            }
          ]
        }
      ]
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-entry')
  })

  test('weight 越界 → bad-entry', () => {
    const result = validateManifest({
      version: MANIFEST_VERSION,
      updatedAt: 0,
      families: [
        {
          family: 'Foo',
          styles: [makeStyle({ weight: 1500 })]
        }
      ]
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-entry')
  })

  test('VF 缺 wghtRange → bad-entry', () => {
    const result = validateManifest({
      version: MANIFEST_VERSION,
      updatedAt: 0,
      families: [{ family: 'Foo', styles: [makeStyle({ variable: true })] }]
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-entry')
  })

  test('静态字体带 wghtRange → bad-entry', () => {
    const result = validateManifest({
      version: MANIFEST_VERSION,
      updatedAt: 0,
      families: [
        {
          family: 'Foo',
          styles: [makeStyle({ variable: false, wghtRange: { min: 100, default: 400, max: 900 } })]
        }
      ]
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-entry')
  })

  test('wghtRange 不满足 min<=default<=max → bad-entry', () => {
    const result = validateManifest({
      version: MANIFEST_VERSION,
      updatedAt: 0,
      families: [
        {
          family: 'Foo',
          styles: [makeStyle({ variable: true, wghtRange: { min: 500, default: 400, max: 900 } })]
        }
      ]
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-entry')
  })

  test('artifact 非法字面量 → bad-entry', () => {
    const result = validateManifest({
      version: MANIFEST_VERSION,
      updatedAt: 0,
      families: [{ family: 'Foo', styles: [makeStyle({ artifact: 'partial' as 'full' })] }]
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-entry')
  })

  test('source 非法字面量 → bad-entry', () => {
    const result = validateManifest({
      version: MANIFEST_VERSION,
      updatedAt: 0,
      families: [{ family: 'Foo', styles: [makeStyle({ source: 'cdn' as 'local-file' })] }]
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('bad-entry')
  })

  test('parseManifest：非 JSON 串 → invalid-json', () => {
    const result = parseManifest('{this is not json')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('invalid-json')
  })
})

describe('manifest.upsertStyle / removeStyle / removeFamily', () => {
  test('upsert：新 family 追加', () => {
    const manifest = emptyManifest(0)
    upsertStyle(manifest, 'Roboto', makeStyle({ key: 'Regular' }))
    expect(manifest.families).toHaveLength(1)
    expect(manifest.families[0].family).toBe('Roboto')
    expect(manifest.families[0].styles).toHaveLength(1)
  })

  test('upsert：同 family 新 style 追加', () => {
    const manifest = makeManifest([{ family: 'Roboto', styles: [makeStyle({ key: 'Regular' })] }])
    upsertStyle(manifest, 'Roboto', makeStyle({ key: 'Bold', weight: 700 }))
    expect(manifest.families).toHaveLength(1)
    expect(manifest.families[0].styles).toHaveLength(2)
  })

  test('upsert：同 family 同 style 覆盖（hash 变化）', () => {
    const manifest = makeManifest([
      { family: 'Roboto', styles: [makeStyle({ key: 'Regular', hash: 'a'.repeat(32), size: 100 })] }
    ])
    upsertStyle(manifest, 'Roboto', makeStyle({ key: 'Regular', hash: 'b'.repeat(32), size: 200 }))
    expect(manifest.families).toHaveLength(1)
    expect(manifest.families[0].styles).toHaveLength(1)
    expect(manifest.families[0].styles[0].hash).toBe('b'.repeat(32))
    expect(manifest.families[0].styles[0].size).toBe(200)
  })

  test('removeStyle：删后族内 styles 空 → 族也删除', () => {
    const manifest = makeManifest([{ family: 'Roboto', styles: [makeStyle({ key: 'Regular' })] }])
    const removed = removeStyle(manifest, 'Roboto', 'Regular')
    expect(removed).toBe(true)
    expect(manifest.families).toHaveLength(0)
  })

  test('removeStyle：多 style 族删一个，剩余保留', () => {
    const manifest = makeManifest([
      {
        family: 'Roboto',
        styles: [makeStyle({ key: 'Regular' }), makeStyle({ key: 'Bold', weight: 700 })]
      }
    ])
    const removed = removeStyle(manifest, 'Roboto', 'Regular')
    expect(removed).toBe(true)
    expect(manifest.families).toHaveLength(1)
    expect(manifest.families[0].styles).toHaveLength(1)
    expect(manifest.families[0].styles[0].key).toBe('Bold')
  })

  test('removeStyle：不存在的 family → false', () => {
    const manifest = emptyManifest(0)
    expect(removeStyle(manifest, 'Missing', 'Regular')).toBe(false)
  })

  test('removeStyle：不存在的 style → false', () => {
    const manifest = makeManifest([{ family: 'Roboto', styles: [makeStyle()] }])
    expect(removeStyle(manifest, 'Roboto', 'Missing')).toBe(false)
  })

  test('removeFamily：整族移除', () => {
    const manifest = makeManifest([
      { family: 'Roboto', styles: [makeStyle(), makeStyle({ key: 'Bold', weight: 700 })] },
      { family: 'Inter', styles: [makeStyle()] }
    ])
    const removed = removeFamily(manifest, 'Roboto')
    expect(removed).toBe(true)
    expect(manifest.families).toHaveLength(1)
    expect(manifest.families[0].family).toBe('Inter')
  })

  test('findFamilyIndex / findStyleIndex：找到返索引，找不到返 -1', () => {
    const manifest = makeManifest([
      {
        family: 'Roboto',
        styles: [makeStyle({ key: 'Regular' }), makeStyle({ key: 'Bold' })]
      }
    ])
    expect(findFamilyIndex(manifest, 'Roboto')).toBe(0)
    expect(findFamilyIndex(manifest, 'Missing')).toBe(-1)
    expect(findStyleIndex(manifest.families[0], 'Bold')).toBe(1)
    expect(findStyleIndex(manifest.families[0], 'Missing')).toBe(-1)
  })
})

describe('manifest.toFamilyViews aggregation', () => {
  test('空 manifest → 空 Group 不含任何 view', () => {
    const views = toFamilyViews(makeManifest([]))
    expect(views).toEqual([])
  })

  test('单族聚合：totalSize = 各 style 之和；installedAt = 最新', () => {
    const views = toFamilyViews(
      makeManifest([
        {
          family: 'Inter',
          styles: [
            makeStyle({ key: 'Regular', size: 1000, installedAt: 100 }),
            makeStyle({ key: 'Bold', size: 1100, installedAt: 200 }),
            makeStyle({ key: 'Light', size: 900, installedAt: 150 })
          ]
        }
      ])
    )
    expect(views).toHaveLength(1)
    expect(views[0].family).toBe('Inter')
    expect(views[0].totalSize).toBe(3000)
    expect(views[0].installedAt).toBe(200)
  })

  test('displayName 透传；wghtRange 在 VF view 内', () => {
    const views = toFamilyViews(
      makeManifest([
        {
          family: 'Noto Sans SC VF',
          displayName: '思源黑体 SC',
          styles: [
            makeStyle({
              key: 'Variable',
              variable: true,
              wghtRange: { min: 100, default: 400, max: 900 }
            })
          ]
        }
      ])
    )
    expect(views[0].displayName).toBe('思源黑体 SC')
    expect(views[0].styles[0].variable).toBe(true)
    expect(views[0].styles[0].wghtRange).toEqual({ min: 100, default: 400, max: 900 })
  })

  test('空族不进 view 输出（manifest 内残留的空壳被过滤）', () => {
    const views = toFamilyViews(makeManifest([{ family: 'Empty', styles: [] }]))
    expect(views).toEqual([])
  })
})
