import { describe, expect, test } from 'bun:test'

import type { CanvasKit, TypefaceFontProvider } from 'canvaskit-wasm'

import { FontManager } from '@open-pencil/core/text'

import {
  CN_FONT_MAX_PIECES_PER_REQUEST,
  CnFontSubsetResolver,
  formatUnicodeRanges,
  parseCnFontResultCSS,
  parseUnicodeRanges,
  pickCnFontSubfamily,
  selectCnFontPieces,
  subfamilyDirWeight,
  type CnFontPieceCache
} from '#core/text/web-font/cn-fonts'

const CSS_URL =
  'https://cdn.jsdelivr.net/npm/@chinese-fonts/mock@latest/dist/Mock-Regular/result.css'

const FIXTURE_CSS = `
@font-face{font-family:"Mock Kai";src:local("Mock Kai"),url("./aaaa1111.woff2")format("woff2");font-style:normal;font-display:swap;font-weight:400;unicode-range:U+4E00-4E7F,U+FF0C;}
@font-face{font-family:"Mock Kai";src:url("./bbbb2222.woff2")format("woff2");font-style:normal;font-weight:400;unicode-range:U+4E80-4FFF;}
@font-face{font-family:"Mock Kai";src:url("./cccc3333.woff2")format("woff2");font-style:normal;font-weight:700;unicode-range:U+4E00-4FFF;}
@font-face{font-family:"Mock Kai";src:url("./dddd4444.woff2")format("woff2");font-style:italic;font-weight:400;unicode-range:U+41-5A,U+4??;}
@font-face{font-family:"Mock Kai";src:url("./eeee5555.woff2")format("woff2");font-style:normal;font-weight:400;unicode-range:U+5900-59FF;}
`

function pieceURL(name: string): string {
  return `https://cdn.jsdelivr.net/npm/@chinese-fonts/mock@latest/dist/Mock-Regular/${name}`
}

describe('parseUnicodeRanges', () => {
  test('parses single values, intervals and wildcards', () => {
    expect(parseUnicodeRanges('U+4E2D')).toEqual([[0x4e2d, 0x4e2d]])
    expect(parseUnicodeRanges('U+4E00-9FFF')).toEqual([[0x4e00, 0x9fff]])
    expect(parseUnicodeRanges('U+4??')).toEqual([[0x400, 0x4ff]])
    expect(parseUnicodeRanges('U+30F5F,U+30F7C-30F7D, U+FF0C')).toEqual([
      [0x30f5f, 0x30f5f],
      [0x30f7c, 0x30f7d],
      [0xff0c, 0xff0c]
    ])
    expect(parseUnicodeRanges('garbage')).toEqual([])
  })

  test('formatUnicodeRanges round-trips parsed ranges for FontFace descriptors', () => {
    expect(
      formatUnicodeRanges([
        [0x4e00, 0x9fff],
        [0xff0c, 0xff0c]
      ])
    ).toBe('U+4E00-9FFF, U+FF0C')
  })
})

describe('subfamilyDirWeight / pickCnFontSubfamily', () => {
  test('infers weight from directory suffix, longest token first', () => {
    expect(subfamilyDirWeight('LXGWWenKaiMono-Light')).toBe(300)
    expect(subfamilyDirWeight('Yozai-ExtraBold')).toBe(800)
    expect(subfamilyDirWeight('ChillRoundFBold')).toBe(700)
    expect(subfamilyDirWeight('SourceHanSerifCN')).toBeNull()
  })

  test('picks exact weight, then nearest, excluding mono for proportional families', () => {
    const dirs = [
      'LXGWWenKai-Light',
      'LXGWWenKai-Medium',
      'LXGWWenKai-Regular',
      'LXGWWenKaiMono-Light',
      'LXGWWenKaiMono-Regular'
    ]
    expect(pickCnFontSubfamily(dirs, 400, 'LXGW WenKai')).toBe('LXGWWenKai-Regular')
    expect(pickCnFontSubfamily(dirs, 500, 'LXGW WenKai')).toBe('LXGWWenKai-Medium')
    // 请求 600（SemiBold）无精确命中 → 最近邻 Medium(500)，且不得选 Mono
    expect(pickCnFontSubfamily(dirs, 600, 'LXGW WenKai')).toBe('LXGWWenKai-Medium')
    expect(pickCnFontSubfamily(dirs, 300, 'LXGW WenKai Mono')).toBe('LXGWWenKaiMono-Light')
    // 无字重后缀的单字重包：回退第一个候选
    expect(pickCnFontSubfamily(['SourceHanSerifCN'], 400, 'Source Han Serif CN')).toBe(
      'SourceHanSerifCN'
    )
    expect(pickCnFontSubfamily([], 400, 'X')).toBeNull()
  })
})

describe('parseCnFontResultCSS / selectCnFontPieces', () => {
  const pieces = parseCnFontResultCSS(FIXTURE_CSS, CSS_URL)

  test('parses font-face blocks with absolute piece URLs', () => {
    expect(pieces).toHaveLength(5)
    expect(pieces[0].url).toBe(pieceURL('aaaa1111.woff2'))
    expect(pieces[0].weight).toBe(400)
    expect(pieces[0].italic).toBe(false)
    expect(pieces[3].italic).toBe(true)
  })

  test('selects covering pieces per character with weight and italic filtering', () => {
    // 你 U+4F60 → bbbb（400）；中 U+4E2D → aaaa；，U+FF0C → aaaa
    expect(selectCnFontPieces(pieces, '你中，', 400, false).map((p) => p.url)).toEqual([
      pieceURL('bbbb2222.woff2'),
      pieceURL('aaaa1111.woff2')
    ])
    // Bold 你 → cccc（700 片覆盖全区间）
    expect(selectCnFontPieces(pieces, '你', 700, false).map((p) => p.url)).toEqual([
      pieceURL('cccc3333.woff2')
    ])
    // italic A → dddd（U+41-5A + 通配 U+4??）
    expect(selectCnFontPieces(pieces, 'A', 400, true).map((p) => p.url)).toEqual([
      pieceURL('dddd4444.woff2')
    ])
    // 无覆盖字符 → 空
    expect(selectCnFontPieces(pieces, '✈', 400, false)).toEqual([])
  })
})

interface MockFetch {
  calls: string[]
  fetcher: (url: string) => Promise<Response>
}

/**
 * unifont provider 初始化会拉 fonts.google.com/metadata/fonts 与
 * api.fontsource.org/v1/fonts，失败时内部按 1s 退避重试 3 次（单测会超时）。
 * mock 直接回空清单让其快速初始化成功；其余未知 URL 一律 404。
 */
function createMockFetch(
  options: { failWoff2?: boolean; css?: string; packages?: string[]; dirs?: string[] } = {}
): MockFetch {
  const calls: string[] = []
  const css = options.css ?? FIXTURE_CSS
  const packages = options.packages ?? ['@chinese-fonts/mock']
  const dirs = options.dirs ?? ['Mock-Regular']
  return {
    calls,
    fetcher: async (url: string) => {
      calls.push(url)
      if (url.includes('fonts.google.com/metadata/fonts')) {
        return new Response(JSON.stringify({ familyMetadataList: [] }), {
          status: 200
        })
      }
      if (url.includes('api.fontsource.org/v1/fonts')) {
        return new Response('[]', { status: 200 })
      }
      // unifont resolveFont 的 css2/单族 API 返回空 200：避免 404 触发 1s×3 退避重试
      if (url.includes('fonts.googleapis.com/css2')) return new Response('', { status: 200 })
      if (url.includes('api.fontsource.org')) return new Response('{}', { status: 200 })
      if (packages.some((name) => url.includes(`/npm/${name}@`))) {
        if (url.endsWith('/dist/index.json')) {
          return new Response(JSON.stringify(dirs), {
            status: 200
          })
        }
        if (url.endsWith('/result.css')) return new Response(css, { status: 200 })
        if (url.endsWith('.woff2')) {
          if (options.failWoff2) return new Response('nope', { status: 404 })
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
        }
      }
      return new Response('not found', { status: 404 })
    }
  }
}

describe('CnFontSubsetResolver', () => {
  const descriptor = { package: '@chinese-fonts/mock' }

  test('fetches only the pieces covering the demanded characters', async () => {
    const mock = createMockFetch()
    const resolver = new CnFontSubsetResolver({ fetcher: mock.fetcher })
    const result = await resolver.fetch('Mock Kai', descriptor, 'Regular', '你中')

    expect(result).not.toBeNull()
    expect(result?.pieces).toHaveLength(2)
    expect(result?.coveredCharacters.sort()).toEqual(['中', '你'])
    // index.json + result.css + 2 片，共 4 次网络
    expect(mock.calls).toHaveLength(4)
    expect(mock.calls.filter((url) => url.endsWith('.woff2'))).toEqual([
      pieceURL('bbbb2222.woff2'),
      pieceURL('aaaa1111.woff2')
    ])
  })

  test('incremental characters only fetch new pieces; session caches css and pieces', async () => {
    const mock = createMockFetch()
    const resolver = new CnFontSubsetResolver({ fetcher: mock.fetcher })
    await resolver.fetch('Mock Kai', descriptor, 'Regular', '你')
    const afterFirst = mock.calls.length

    // 好 U+597D → eeee 新片；你 已在 piecePromises 缓存，零网络
    const second = await resolver.fetch('Mock Kai', descriptor, 'Regular', '你好')
    expect(second?.coveredCharacters.sort()).toEqual(['你', '好'])
    const newCalls = mock.calls.slice(afterFirst)
    expect(newCalls.filter((url) => url.endsWith('.woff2'))).toEqual([pieceURL('eeee5555.woff2')])
    expect(newCalls.filter((url) => url.endsWith('result.css'))).toEqual([])
  })

  test('piece cache serves bytes without network', async () => {
    const store = new Map<string, ArrayBuffer>()
    const cache: CnFontPieceCache = {
      read: async (url) => store.get(url) ?? null,
      write: async (url, data) => void store.set(url, data)
    }
    const mock = createMockFetch()
    const first = new CnFontSubsetResolver({ fetcher: mock.fetcher, cache })
    await first.fetch('Mock Kai', descriptor, 'Regular', '你')

    // 全新 resolver（无会话缓存）+ 同一磁盘缓存：CSS 要重抓，woff2 不抓
    const fresh = new CnFontSubsetResolver({ fetcher: mock.fetcher, cache })
    const result = await fresh.fetch('Mock Kai', descriptor, 'Regular', '你')
    expect(result?.pieces).toHaveLength(1)
    const woff2Calls = mock.calls.filter((url) => url.endsWith('.woff2'))
    expect(woff2Calls).toHaveLength(1) // 仅第一次真实抓取
  })

  test('returns null when the package or coverage is missing, never throws', async () => {
    const mock = createMockFetch()
    const resolver = new CnFontSubsetResolver({ fetcher: mock.fetcher })

    expect(
      await resolver.fetch('Ghost', { package: '@chinese-fonts/ghost' }, 'Regular', '你')
    ).toBeNull()
    expect(await resolver.fetch('Mock Kai', descriptor, 'Regular', '✈')).toBeNull()

    // 全部片 404 → pieces 为空，coveredCharacters 为空
    const failing = new CnFontSubsetResolver({
      fetcher: createMockFetch({ failWoff2: true }).fetcher
    })
    const result = await failing.fetch('Mock Kai', descriptor, 'Regular', '你')
    expect(result).not.toBeNull()
    expect(result?.pieces).toEqual([])
    expect(result?.coveredCharacters).toEqual([])
  })

  test('refuses pathological piece counts above the anomaly threshold', async () => {
    const count = CN_FONT_MAX_PIECES_PER_REQUEST + 1
    const blocks: string[] = []
    let characters = ''
    for (let index = 0; index < count; index++) {
      const codePoint = 0x1000 + index
      characters += String.fromCodePoint(codePoint)
      blocks.push(
        `@font-face{font-family:"Mock Kai";src:url("./p${index}.woff2")format("woff2");font-weight:400;unicode-range:U+${codePoint.toString(16).toUpperCase()};}`
      )
    }
    const resolver = new CnFontSubsetResolver({
      fetcher: createMockFetch({ css: blocks.join('\n') }).fetcher
    })
    expect(await resolver.fetch('Mock Kai', descriptor, 'Regular', characters)).toBeNull()
  })
})

describe('FontManager cn-font routing (T40 S4 / T42 D-a 独立开关)', () => {
  test('registry CDN family loads through cn-font resolver with cdn source and coverage', async () => {
    const manager = new FontManager()
    const mock = createMockFetch({ packages: ['@chinese-fonts/lxgwwenkai'] })
    manager.setWebFontFetch(mock.fetcher)
    // 隔离应用侧 P117 接线可能装进单例 resolver 的磁盘缓存：网络行为断言只认 mock
    manager.setCnFontPieceCache(null)

    // 注册表家族 LXGW WenKai 的 descriptor 指到 @chinese-fonts/lxgwwenkai，
    // 本用例把 mock 的 index/css 挂到该包路径下验证路由本身
    const buffer = await manager.loadRemoteFont('LXGW WenKai', 'Regular', '你')
    expect(buffer).not.toBeNull()
    expect(manager.loadedFontSource('LXGW WenKai', 'Regular')).toBe('cdn')
    expect(manager.isStyleLoaded('LXGW WenKai', 'Regular')).toBe(true)
    expect(manager.remoteStyleNeedsCoverage('LXGW WenKai', 'Regular', ['你'])).toBe(false)
    expect(manager.remoteStyleNeedsCoverage('LXGW WenKai', 'Regular', ['好'])).toBe(true)
    // 路由只走 cn-font：无任何 unifont provider 请求
    expect(mock.calls.some((url) => url.includes('fonts.googleapis.com'))).toBe(false)
    manager.evictFont('LXGW WenKai', 'Regular')
  })

  test('cdn failure falls back to the unifont provider chain', async () => {
    const manager = new FontManager()
    // cn-font 片全 404 → 回本链；unifont 各 provider 拿到快速空响应 → 最终 null
    const mock = createMockFetch({
      packages: ['@chinese-fonts/lxgwwenkai'],
      failWoff2: true
    })
    manager.setWebFontFetch(mock.fetcher)
    // 隔离应用侧 P117 接线可能装进单例 resolver 的磁盘缓存：网络行为断言只认 mock
    manager.setCnFontPieceCache(null)
    // 在线 provider 默认全关（opt-in 默认值）：显式开 google/fontsource 让回退链可触
    manager.setOnlineFontProviders({ google: true, fontsource: true })

    const buffer = await manager.loadRemoteFont('LXGW WenKai', 'Regular', '你')
    expect(buffer).toBeNull()
    expect(mock.calls.some((url) => url.includes('lxgwwenkai'))).toBe(true)
    expect(
      mock.calls.some((url) => url.includes('fonts.googleapis.com') || url.includes('fontsource'))
    ).toBe(true)
  }, 15000)

  test('unreachable provider does not block the family list (T40 S2 配套)', async () => {
    const manager = new FontManager()
    manager.setWebFontListTimeout(50)
    manager.setWebFontFetch(async (url) => {
      // google 元数据永不返回（模拟不可达）；其余快速失败
      if (url.includes('fonts.google.com')) {
        return new Promise<Response>(() => {
          // 永不 resolve：模拟不可达 provider
        })
      }
      if (url.includes('api.fontsource.org/v1/fonts')) return new Response('[]', { status: 200 })
      return new Response('not found', { status: 404 })
    })

    const started = Date.now()
    const options = await manager.listFamilyOptions()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(options.some((option) => option.family === 'Inter')).toBe(true)
    expect(
      options.some((option) => option.family === 'LXGW WenKai' && option.source === 'cdn')
    ).toBe(true)
  })

  test('T42 D-a：CDN 枚举/加载改判独立开关 cnFontsEnabled，与在线 provider 解耦', async () => {
    const manager = new FontManager()
    const mock = createMockFetch({ packages: ['@chinese-fonts/lxgwwenkai'] })
    manager.setWebFontFetch(mock.fetcher)
    // 隔离应用侧 P117 接线可能装进单例 resolver 的磁盘缓存：网络行为断言只认 mock
    manager.setCnFontPieceCache(null)

    // providers 全关 + cnFontsEnabled 默认开 → CDN 家族照常枚举（T40 旧语义下会隐藏）
    manager.setOnlineFontProviders({ google: false, fontsource: false })
    const options = await manager.listFamilyOptions()
    const cdn = options.filter((option) => option.source === 'cdn').map((option) => option.family)
    expect(cdn).toEqual(
      expect.arrayContaining([
        'LXGW WenKai',
        'Xiaolai SC',
        'Yozai',
        'MaokenAssortedSans',
        '寒蝉全圆体'
      ])
    )
    expect(options.find((option) => option.family === 'Inter')?.source).toBe('bundled')

    // providers 全关下 CDN 家族加载仍走 cn 路由（不经 unifont 链）
    const loaded = await manager.loadRemoteFont('LXGW WenKai', 'Regular', '你')
    expect(loaded).not.toBeNull()
    expect(manager.loadedFontSource('LXGW WenKai', 'Regular')).toBe('cdn')
    manager.evictFont('LXGW WenKai', 'Regular')

    // cnFontsEnabled=false → CDN 家族枚举隐藏（面板 includeDisabled 路径同样隐藏：
    // 源级开关优先于行级状态），bundled 不受影响
    manager.setCnFontsEnabled(false)
    const offline = await manager.listFamilyOptions()
    expect(offline.some((option) => option.source === 'cdn')).toBe(false)
    expect(offline.some((option) => option.family === 'Inter')).toBe(true)
    const panelAll = await manager.listFamilyOptions({ includeDisabled: true })
    expect(panelAll.some((option) => option.source === 'cdn')).toBe(false)

    // CDN 开关关停时 CDN 家族 loadRemoteFont 零触网（不管 providers 状态）
    const before = mock.calls.length
    expect(await manager.loadRemoteFont('LXGW WenKai', 'Regular', '你')).toBeNull()
    expect(mock.calls.slice(before).some((url) => url.includes('lxgwwenkai'))).toBe(false)
  })

  test('T42 D-c：catalog 族默认停用（opt-in），开启后经 loadCnFontSubset 端到端加载', async () => {
    const manager = new FontManager()
    // 快看世界体 = catalog 收录族（@chinese-fonts/kksjt@3.0.0，无 unpkg 回退 base）
    const mock = createMockFetch({ packages: ['@chinese-fonts/kksjt'] })
    manager.setWebFontFetch(mock.fetcher)
    // 隔离应用侧 P117 接线可能装进单例 resolver 的磁盘缓存：网络行为断言只认 mock
    manager.setCnFontPieceCache(null)

    // 默认停用：picker 枚举不见；面板路径（includeDisabled）可见且带 catalog 标识
    expect(manager.isFontFamilyEnabled('快看世界体')).toBe(false)
    const picker = await manager.listFamilyOptions()
    expect(picker.some((option) => option.family === '快看世界体')).toBe(false)
    const panel = await manager.listFamilyOptions({ includeDisabled: true })
    const row = panel.find((option) => option.family === '快看世界体')
    expect(row?.source).toBe('cdn')
    expect(row?.catalog).toBe(true)

    // 默认停用时加载被白名单门禁短路（零触网）
    const before = mock.calls.length
    expect(await manager.loadRemoteFont('快看世界体', 'Regular', '你')).toBeNull()
    expect(mock.calls.slice(before).some((url) => url.includes('kksjt'))).toBe(false)

    // opt-in 开启 → picker 枚举出现 + 经 cn 路由加载（descriptor 来自 catalog，
    // 版本钉扎 @3.0.0 —— D-g 构建时实解）
    manager.setFontFamilyEnabled('快看世界体', true)
    const enabled = await manager.listFamilyOptions()
    expect(
      enabled.some((option) => option.family === '快看世界体' && option.catalog === true)
    ).toBe(true)
    const loaded = await manager.loadRemoteFont('快看世界体', 'Regular', '你')
    expect(loaded).not.toBeNull()
    expect(manager.loadedFontSource('快看世界体', 'Regular')).toBe('cdn')
    expect(mock.calls.some((url) => url.includes('/npm/@chinese-fonts/kksjt@3.0.0/'))).toBe(true)
    manager.evictFont('快看世界体', 'Regular')
  })
})

describe('FontManager cn-font render aliases (T40 同名塌缩修复)', () => {
  function mockProvider() {
    const registrations: Array<{ family: string; bytes: number }> = []
    const provider = {
      registerFont(data: ArrayBuffer, family: string) {
        registrations.push({ family, bytes: data.byteLength })
      }
    } as TypefaceFontProvider
    return { provider, registrations }
  }

  test('each piece registers under a unique alias plus one real-name primary', async () => {
    const manager = new FontManager()
    const { provider, registrations } = mockProvider()
    manager.attachProvider({} as CanvasKit, provider)
    const mock = createMockFetch({ packages: ['@chinese-fonts/lxgwwenkai'] })
    manager.setWebFontFetch(mock.fetcher)
    // 隔离应用侧 P117 接线可能装进单例 resolver 的磁盘缓存：网络行为断言只认 mock
    manager.setCnFontPieceCache(null)

    // 你 U+4F60 → bbbb 片；中 U+4E2D → aaaa 片
    await manager.loadRemoteFont('LXGW WenKai', 'Regular', '你中')
    const aliases = manager.renderFamilyAliases('LXGW WenKai', 'Regular')
    expect(aliases).toHaveLength(2)
    expect(new Set(aliases).size).toBe(2)
    for (const alias of aliases) {
      expect(alias.startsWith('LXGW WenKai')).toBe(true)
      expect(alias).not.toBe('LXGW WenKai')
    }

    const families = registrations.map((registration) => registration.family)
    // 同名只注册一次（primary）：互斥分片挂同名会被 CanvasKit 塌缩成单 typeface
    expect(families.filter((family) => family === 'LXGW WenKai')).toHaveLength(1)
    expect(families.slice(1).sort()).toEqual([...aliases].sort())
    manager.evictFont('LXGW WenKai', 'Regular')
  })

  test('incremental loads register only new pieces; bytes account every piece once', async () => {
    const manager = new FontManager()
    const { provider, registrations } = mockProvider()
    manager.attachProvider({} as CanvasKit, provider)
    const mock = createMockFetch({ packages: ['@chinese-fonts/lxgwwenkai'] })
    manager.setWebFontFetch(mock.fetcher)
    // 隔离应用侧 P117 接线可能装进单例 resolver 的磁盘缓存：网络行为断言只认 mock
    manager.setCnFontPieceCache(null)

    await manager.loadRemoteFont('LXGW WenKai', 'Regular', '你')
    expect(manager.renderFamilyAliases('LXGW WenKai', 'Regular')).toHaveLength(1)
    expect(manager.fontMemoryStats().loadedBytes).toBe(4)
    const afterFirst = registrations.length

    // 增量 '好' → 请求合并累计覆盖（你好），bbbb 片按 url 去重不重复注册
    await manager.loadRemoteFont('LXGW WenKai', 'Regular', '好')
    expect(manager.renderFamilyAliases('LXGW WenKai', 'Regular')).toHaveLength(2)
    expect(registrations.length - afterFirst).toBe(1)
    expect(registrations.at(-1)?.family).not.toBe('LXGW WenKai')
    expect(manager.fontMemoryStats().loadedBytes).toBe(8)
    manager.evictFont('LXGW WenKai', 'Regular')
  })

  test('attachProvider replays aliases instead of real-name supplementals; eviction clears', async () => {
    const manager = new FontManager()
    const mock = createMockFetch({ packages: ['@chinese-fonts/lxgwwenkai'] })
    manager.setWebFontFetch(mock.fetcher)
    // 隔离应用侧 P117 接线可能装进单例 resolver 的磁盘缓存：网络行为断言只认 mock
    manager.setCnFontPieceCache(null)
    await manager.loadRemoteFont('LXGW WenKai', 'Regular', '你中')
    const aliases = manager.renderFamilyAliases('LXGW WenKai', 'Regular')

    const { provider: second, registrations } = mockProvider()
    manager.attachProvider({} as CanvasKit, second)
    const families = registrations.map((registration) => registration.family)
    expect(families.filter((family) => family === 'LXGW WenKai')).toHaveLength(1)
    expect(families.slice(1).sort()).toEqual([...aliases].sort())

    manager.evictFont('LXGW WenKai', 'Regular')
    expect(manager.renderFamilyAliases('LXGW WenKai', 'Regular')).toEqual([])
  })
})

describe('可变字体（VF）包支持（T41 S2，syst 形态）', () => {
  const VF_CSS = `
@font-face{font-family:"Source Han Serif CN VF";src:local("Source Han Serif CN VF"),url("./vf-aaaa.woff2")format("woff2");font-style:normal;font-display:swap;font-weight:250 900;unicode-range:U+4E00-4E7F;}
@font-face{font-family:"Source Han Serif CN VF";src:url("./vf-bbbb.woff2")format("woff2");font-style:normal;font-weight:250 900;unicode-range:U+4E80-4FFF;}
`

  test('parseCnFontResultCSS 解析 font-weight 区间形态（250 900）', () => {
    const pieces = parseCnFontResultCSS(VF_CSS, 'https://cdn.example/dist/SourceHanSerifCN/')
    expect(pieces).toHaveLength(2)
    expect(pieces[0].weight).toBe(250)
    expect(pieces[0].weightMax).toBe(900)
    // 静态单值形态不产出 weightMax
    const staticPieces = parseCnFontResultCSS(FIXTURE_CSS, 'https://cdn.example/dist/Mock/')
    expect(staticPieces[0].weightMax).toBeUndefined()
  })

  test('selectCnFontPieces 区间包含匹配：任意请求字重命中 VF 片', () => {
    const pieces = parseCnFontResultCSS(VF_CSS, 'https://cdn.example/dist/SourceHanSerifCN/')
    // 你 U+4F60 在 4E80-4FFF 片；400/650/900 均应命中同一 VF 片（区间包含）
    for (const weight of [250, 400, 650, 900]) {
      expect(selectCnFontPieces(pieces, '你', weight, false).map((p) => p.url)).toEqual([
        'https://cdn.example/dist/SourceHanSerifCN/vf-bbbb.woff2'
      ])
    }
  })

  test('syst 形态端到端：单目录索引 + 区间 css + 按需取片', async () => {
    const mock = createMockFetch({
      packages: ['@chinese-fonts/syst'],
      dirs: ['SourceHanSerifCN'],
      css: VF_CSS
    })
    const resolver = new CnFontSubsetResolver({ fetcher: mock.fetcher })
    // Bold（700）请求：区间 250-900 包含命中
    const result = await resolver.fetch(
      'Source Han Serif CN VF',
      { package: '@chinese-fonts/syst' },
      'Bold',
      '中你'
    )
    expect(result).not.toBeNull()
    expect(result?.pieces).toHaveLength(2)
    expect(result?.coveredCharacters.sort()).toEqual(['中', '你'])
    expect(mock.calls.some((url) => url.includes('/dist/SourceHanSerifCN/result.css'))).toBe(true)
  })

  test('FontManager 路由：syst 注册表家族经 CDN 链加载', async () => {
    const manager = new FontManager()
    const mock = createMockFetch({
      packages: ['@chinese-fonts/syst'],
      dirs: ['SourceHanSerifCN'],
      css: VF_CSS
    })
    manager.setWebFontFetch(mock.fetcher)
    // 隔离应用侧 P117 接线可能装进单例 resolver 的磁盘缓存：网络行为断言只认 mock
    manager.setCnFontPieceCache(null)
    // T42 D-a：cn 路由不读 provider 开关——providers 全关照样经 CDN 链加载
    manager.setOnlineFontProviders({ google: false, fontsource: false })

    const loaded = await manager.loadRemoteFont('Source Han Serif CN VF', 'Bold', '中')
    expect(loaded).not.toBeNull()
    expect(manager.loadedFontSource('Source Han Serif CN VF', 'Bold')).toBe('cdn')
    expect(manager.renderFamilyAliases('Source Han Serif CN VF', 'Bold')).toHaveLength(1)
    manager.evictFont('Source Han Serif CN VF', 'Bold')
  })
})
