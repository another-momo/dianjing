/**
 * 字体商店三适配器纯逻辑测试。
 *
 * 覆盖：
 *  - Fontsource：单族小响应样例（id/family/subsets/weights/styles/defSubset/variable/lastModified/license/version）
 *    → 合成 CDN URL（subset 优先级 defSubset→latin→latin-ext→[0]；静态族 weights×styles
 *      笛卡尔积；variable 族发 :vf 包 wght 轴条目，wghtRange 由 weights 数组派生）
 *  - Standard：catalog.json → 直序字段；坏条目（缺 fileURL/format/weight/style）跳过
 *  - gf-api：variant 字符串解析（regular/italic/700/700italic）、license 缺失 → undefined
 */

import { describe, expect, test } from 'bun:test'

import { cnFontsAdapter } from '#core/text/font/store/adapters/cn-fonts'
import { fontsourceAdapter } from '#core/text/font/store/adapters/fontsource'
import { createGoogleFontsAdapter } from '#core/text/font/store/adapters/gf-api'
import { createStandardAdapter } from '#core/text/font/store/adapters/standard'
import type { FetchLike } from '#core/text/font/store/types'

import { must } from '#tests/helpers/json'

/** 桩 fetch 实现 → FetchLike 的单点断言出口（桩响应与 Response 无结构重叠，集中转型） */
function asFetchLike(impl: unknown): FetchLike {
  return impl as FetchLike
}

function fakeFetch(payload: unknown): FetchLike {
  return asFetchLike(async () => ({
    ok: true,
    status: 200,
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    }
  }))
}

describe('Fontsource adapter', () => {
  test('单族响应合成 CDN URL：subset 选择 + variable 族发 :vf 包 VF 条目', async () => {
    const fetchImpl = fakeFetch([
      {
        id: 'inter',
        family: 'Inter',
        subsets: ['cyrillic', 'latin', 'latin-ext'],
        weights: [400, 700],
        styles: ['normal', 'italic'],
        defSubset: 'latin-ext',
        variable: true,
        lastModified: '2025-09-10',
        license: 'OFL-1.1',
        version: 'v20'
      }
    ])
    const families = await fontsourceAdapter.fetchCatalog(fetchImpl)
    expect(families).toHaveLength(1)
    const family = families[0]
    expect(family.family).toBe('Inter')
    expect(family.license).toBe('OFL-1.1')
    expect(family.version).toBe('v20')
    expect(family.lastModified).toBe('2025-09-10')
    // variable 族：per-weight 路径是静态实例文件（标 wghtRange 会让静态文件被当 VF
    // 用）——只发每 styleFlag 一条 :vf 包 wght 轴条目
    expect(family.styles.length).toBe(2)

    // defSubset='latin-ext' 在 subsets 中 → 用 latin-ext；非 latin
    const normal = family.styles.find((s) => s.italic === false)
    expect(normal).toBeDefined()
    expect(must(normal).fileURL).toBe(
      'https://cdn.jsdelivr.net/fontsource/fonts/inter:vf@latest/latin-ext-wght-normal.woff2'
    )
    expect(must(normal).format).toBe('woff2')
    expect(must(normal).variable).toBe(true)
    expect(must(normal).wghtRange).toEqual({ min: 400, max: 700 })
    expect(must(normal).style).toBe('Variable')

    const italic = family.styles.find((s) => s.italic === true)
    expect(italic).toBeDefined()
    expect(must(italic).fileURL).toBe(
      'https://cdn.jsdelivr.net/fontsource/fonts/inter:vf@latest/latin-ext-wght-italic.woff2'
    )
    expect(must(italic).style).toBe('Variable Italic')
  })

  test('静态族：weights×styles 笛卡尔积 + per-weight 静态路径（不带 variable 标记）', async () => {
    const fetchImpl = fakeFetch([
      {
        id: 'roboto',
        family: 'Roboto',
        subsets: ['latin'],
        weights: [400, 700],
        styles: ['normal', 'italic'],
        variable: false
      }
    ])
    const families = await fontsourceAdapter.fetchCatalog(fetchImpl)
    expect(families).toHaveLength(1)
    const styles = families[0].styles
    expect(styles).toHaveLength(4) // 2 weights × 2 styles
    for (const style of styles) {
      expect(style.variable).toBeUndefined()
      expect(style.wghtRange).toBeUndefined()
    }
    const boldItalic = styles.find((s) => s.weight === 700 && s.italic === true)
    expect(boldItalic).toBeDefined()
    expect(must(boldItalic).style).toBe('Bold Italic')
    expect(must(boldItalic).fileURL).toBe(
      'https://cdn.jsdelivr.net/fontsource/fonts/roboto@latest/latin-700-italic.woff2'
    )
  })

  test('缺 defSubset 时 fallback 到 latin（subset 含 latin）', async () => {
    const fetchImpl = fakeFetch([
      {
        id: 'abeezee',
        family: 'ABeeZee',
        subsets: ['latin', 'latin-ext'],
        weights: [400],
        styles: ['normal'],
        variable: false,
        license: 'OFL-1.1'
      }
    ])
    const families = await fontsourceAdapter.fetchCatalog(fetchImpl)
    expect(families[0].styles[0].fileURL).toContain('/latin-400-normal.woff2')
  })

  test('无 latin 时 fallback 到 subsets[0]', async () => {
    const fetchImpl = fakeFetch([
      {
        id: 'korean-only',
        family: 'Korean',
        subsets: ['korean'],
        weights: [400],
        styles: ['normal'],
        variable: false
      }
    ])
    const families = await fontsourceAdapter.fetchCatalog(fetchImpl)
    expect(families[0].styles[0].fileURL).toContain('/korean-400-normal.woff2')
  })

  test('license 缺失 → undefined（UI 端展示「授权状态未知」）', async () => {
    const fetchImpl = fakeFetch([
      {
        id: 'nolicense',
        family: 'No License',
        subsets: ['latin'],
        weights: [400],
        styles: ['normal'],
        variable: false
      }
    ])
    const families = await fontsourceAdapter.fetchCatalog(fetchImpl)
    expect(families[0].license).toBeUndefined()
  })

  test('坏族（缺 id / weights / styles）跳过不抛', async () => {
    const fetchImpl = fakeFetch([
      {
        id: 'ok',
        family: 'OK',
        subsets: ['latin'],
        weights: [400],
        styles: ['normal'],
        variable: false
      },
      { family: 'NoId', subsets: ['latin'], weights: [400], styles: ['normal'], variable: false },
      {
        id: 'no-weights',
        family: 'NW',
        subsets: ['latin'],
        weights: [],
        styles: ['normal'],
        variable: false
      },
      {
        id: 'no-styles',
        family: 'NS',
        subsets: ['latin'],
        weights: [400],
        styles: [],
        variable: false
      }
    ])
    const families = await fontsourceAdapter.fetchCatalog(fetchImpl)
    expect(families).toHaveLength(1)
    expect(families[0].family).toBe('OK')
  })

  test('非数组响应抛错', async () => {
    const fetchImpl = fakeFetch({ unexpected: true })
    await expect(fontsourceAdapter.fetchCatalog(fetchImpl)).rejects.toThrow()
  })

  test('HTTP 非 2xx 抛错', async () => {
    const fetchImpl: FetchLike = asFetchLike(async () => ({
      ok: false,
      status: 503,
      async json() {
        return {}
      },
      async text() {
        return ''
      }
    }))
    await expect(fontsourceAdapter.fetchCatalog(fetchImpl)).rejects.toThrow(/503/)
  })
})

describe('Standard adapter', () => {
  test('catalog.json 直序字段：style/fileURL/format/weight/italic 完整', async () => {
    const fetchImpl = fakeFetch({
      families: [
        {
          family: 'Demo Serif',
          displayName: 'Demo Serif Pro',
          license: 'OFL-1.1',
          version: '1.0',
          styles: [
            {
              style: 'Regular',
              weight: 400,
              italic: false,
              fileURL: 'https://x/r.ttf',
              format: 'ttf'
            },
            {
              style: 'Bold',
              weight: 700,
              italic: false,
              fileURL: 'https://x/b.otf',
              format: 'otf'
            },
            {
              style: 'Variable',
              weight: 400,
              italic: false,
              fileURL: 'https://x/v.woff2',
              format: 'woff2',
              variable: true,
              wghtRange: { min: 200, max: 900 }
            }
          ]
        }
      ]
    })
    const adapter = createStandardAdapter('https://example.com')
    const families = await adapter.fetchCatalog(fetchImpl)
    expect(families).toHaveLength(1)
    const family = families[0]
    expect(family.displayName).toBe('Demo Serif Pro')
    expect(family.license).toBe('OFL-1.1')
    expect(family.styles).toHaveLength(3)
    const variable = family.styles.find((s) => s.variable)
    expect(variable).toBeDefined()
    expect(must(variable).wghtRange).toEqual({ min: 200, max: 900 })
  })

  test('坏条目跳过：缺 fileURL/format/weight/style 任一即跳过', async () => {
    const fetchImpl = fakeFetch({
      families: [
        {
          family: 'Mixed',
          styles: [
            {
              style: 'Regular',
              weight: 400,
              italic: false,
              fileURL: 'https://x/r.ttf',
              format: 'ttf'
            },
            { style: 'Bad1', weight: 400, italic: false, fileURL: '', format: 'ttf' },
            {
              style: 'Bad2',
              weight: 400,
              italic: false,
              fileURL: 'https://x/b.ttf',
              format: 'xyz' as 'ttf'
            },
            { style: 'Bad3', italic: false, fileURL: 'https://x/c.ttf', format: 'ttf' }
          ]
        }
      ]
    })
    const adapter = createStandardAdapter('https://example.com')
    const families = await adapter.fetchCatalog(fetchImpl)
    expect(families).toHaveLength(1)
    expect(families[0].styles).toHaveLength(1)
    expect(families[0].styles[0].style).toBe('Regular')
  })

  test('顶层非对象 / families 非数组 → 返 []', async () => {
    const fetchImpl = fakeFetch({ notFamilies: true })
    const adapter = createStandardAdapter('https://example.com')
    const families = await adapter.fetchCatalog(fetchImpl)
    expect(families).toEqual([])
  })

  test('单族空 styles → 跳过该族', async () => {
    const fetchImpl = fakeFetch({
      families: [
        { family: 'Empty', styles: [] },
        {
          family: 'Good',
          styles: [
            {
              style: 'Regular',
              weight: 400,
              italic: false,
              fileURL: 'https://x/r.ttf',
              format: 'ttf'
            }
          ]
        }
      ]
    })
    const adapter = createStandardAdapter('https://example.com')
    const families = await adapter.fetchCatalog(fetchImpl)
    expect(families).toHaveLength(1)
    expect(families[0].family).toBe('Good')
  })
})

describe('gf-api adapter', () => {
  test('variant 解析 + format 推断；axes 不消费（files 全是静态实例，不标 variable）', async () => {
    const fetchImpl = fakeFetch({
      kind: 'webfonts#webfontList',
      items: [
        {
          family: 'Roboto',
          variants: ['regular', 'italic', '700', '700italic'],
          files: {
            regular: 'https://fonts.gstatic.com/s/roboto/v1/regular.ttf',
            italic: 'https://fonts.gstatic.com/s/roboto/v1/italic.ttf',
            '700': 'https://fonts.gstatic.com/s/roboto/v1/700.ttf',
            '700italic': 'https://fonts.gstatic.com/s/roboto/v1/700i.ttf'
          },
          axes: [{ tag: 'wght', start: 100, end: 900 }]
        }
      ]
    })
    const adapter = createGoogleFontsAdapter('https://fonts.googleapis.com', 'TEST-KEY')
    const families = await adapter.fetchCatalog(fetchImpl)
    expect(families).toHaveLength(1)
    const family = families[0]
    expect(family.family).toBe('Roboto')
    expect(family.license).toBeUndefined()
    expect(family.styles.length).toBe(4)

    // axes 含 wght 也不标 variable——files map 里是静态实例文件，标了会让
    // App 按 VF 用静态文件（VF 文件要走 css2 API 另取，当前不支持）
    for (const style of family.styles) {
      expect(style.variable).toBeUndefined()
      expect(style.wghtRange).toBeUndefined()
    }

    const regular = family.styles.find((s) => s.weight === 400 && !s.italic)
    expect(regular).toBeDefined()
    expect(must(regular).fileURL).toBe('https://fonts.gstatic.com/s/roboto/v1/regular.ttf')
    expect(must(regular).format).toBe('ttf')
    expect(must(regular).style).toBe('Regular')

    const bold = family.styles.find((s) => s.weight === 700 && !s.italic)
    expect(bold).toBeDefined()
    expect(must(bold).style).toBe('Bold')

    const boldItalic = family.styles.find((s) => s.weight === 700 && s.italic)
    expect(boldItalic).toBeDefined()
    expect(must(boldItalic).style).toBe('Bold Italic')
  })

  test('variant 解析失败（如 "unknown"）跳过该 style', async () => {
    const fetchImpl = fakeFetch({
      items: [
        {
          family: 'Foo',
          variants: ['regular', 'unknown'],
          files: {
            regular: 'https://fonts.gstatic.com/s/foo/regular.ttf',
            unknown: 'https://fonts.gstatic.com/s/foo/unknown.ttf'
          }
        }
      ]
    })
    const adapter = createGoogleFontsAdapter('https://fonts.googleapis.com', 'K')
    const families = await adapter.fetchCatalog(fetchImpl)
    expect(families[0].styles).toHaveLength(1)
    expect(families[0].styles[0].weight).toBe(400)
  })

  test('woff2 扩展名推断', async () => {
    const fetchImpl = fakeFetch({
      items: [
        {
          family: 'Bar',
          variants: ['regular'],
          files: { regular: 'https://example.com/foo.woff2' }
        }
      ]
    })
    const adapter = createGoogleFontsAdapter('https://example.com', 'K')
    const families = await adapter.fetchCatalog(fetchImpl)
    expect(families[0].styles[0].format).toBe('woff2')
  })

  test('缺 variants/files 跳过该族', async () => {
    const fetchImpl = fakeFetch({
      items: [
        { family: 'NoVariants', files: {} },
        { family: 'NoFiles', variants: ['regular'] }
      ]
    })
    const adapter = createGoogleFontsAdapter('https://example.com', 'K')
    const families = await adapter.fetchCatalog(fetchImpl)
    expect(families).toEqual([])
  })
})

describe('cn-fonts 适配器目录合成', () => {
  // cn-fonts 适配器零网络——直接调 fetchCatalog
  test('registry 内多 weight 族（LXGW WenKai）每条 style 都走 piecesRef 形态', async () => {
    const families = await cnFontsAdapter.fetchCatalog(
      asFetchLike(async () => ({
        ok: true,
        status: 200,
        async json() {
          return {}
        },
        async text() {
          return '{}'
        }
      }))
    )
    const lxgw = families.find((f) => f.family === 'LXGW WenKai')
    expect(lxgw).toBeDefined()
    expect(must(lxgw).styles.length).toBeGreaterThan(0)
    for (const style of must(lxgw).styles) {
      // piecesRef 形态：fileURL 必空、format=woff2、piecesRef 定义
      expect(style.fileURL).toBe('')
      expect(style.format).toBe('woff2')
      expect(style.piecesRef).toBeDefined()
      expect(must(style.piecesRef).package.length).toBeGreaterThan(0)
    }
  })

  test('VF 族（Source Han Serif CN VF）单 variable 条目 + wghtRange 由 weights 派生', async () => {
    const families = await cnFontsAdapter.fetchCatalog(
      asFetchLike(async () => ({
        ok: true,
        status: 200,
        async json() {
          return {}
        },
        async text() {
          return '{}'
        }
      }))
    )
    const vf = families.find((f) => f.family === 'Source Han Serif CN VF')
    expect(vf).toBeDefined()
    expect(must(vf).styles.length).toBe(1)
    expect(must(vf).styles[0].variable).toBe(true)
    const wght = must(vf).styles[0].wghtRange
    expect(wght).toBeDefined()
    // weights 为空时回退单值 [400]（min === max）；非空时也按真值区间派生
    const { min, max } = must(wght)
    expect(min).toBeGreaterThanOrEqual(1)
    expect(max).toBeLessThanOrEqual(1000)
    expect(min).toBeLessThanOrEqual(max)
  })

  test('registry 撞名优先（catalog 同族名不入两次）', async () => {
    const families = await cnFontsAdapter.fetchCatalog(
      asFetchLike(async () => ({
        ok: true,
        status: 200,
        async json() {
          return {}
        },
        async text() {
          return '{}'
        }
      }))
    )
    const dupes = new Map<string, number>()
    for (const f of families) {
      dupes.set(f.family, (dupes.get(f.family) ?? 0) + 1)
    }
    for (const [name, count] of dupes) {
      expect(count).toBe(1)
      // 简易记录：非重复性硬保证
      expect(name.length).toBeGreaterThan(0)
    }
  })
})
