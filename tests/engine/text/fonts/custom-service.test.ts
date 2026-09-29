import { describe, expect, test } from 'bun:test'

import {
  FontManager,
  customServiceCatalogURL,
  normalizeCustomServiceBase,
  parseCustomServiceCatalog,
  scopeBearerFetch,
  type WebFontFetch
} from '@open-pencil/core/text'

const SERVICE_BASE = 'https://svc.example.com'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('normalizeCustomServiceBase', () => {
  test('trims whitespace and trailing slashes', () => {
    expect(normalizeCustomServiceBase('  https://svc.example.com  ')).toBe(SERVICE_BASE)
    expect(normalizeCustomServiceBase('https://svc.example.com/')).toBe(SERVICE_BASE)
    expect(normalizeCustomServiceBase('https://svc.example.com///')).toBe(SERVICE_BASE)
  })

  test('strips a pasted catalog.json suffix', () => {
    expect(normalizeCustomServiceBase('https://svc.example.com/catalog.json')).toBe(SERVICE_BASE)
    expect(normalizeCustomServiceBase('https://svc.example.com/catalog.json/')).toBe(SERVICE_BASE)
  })

  test('keeps a plain base untouched', () => {
    expect(normalizeCustomServiceBase('https://svc.example.com/fonts')).toBe(
      'https://svc.example.com/fonts'
    )
  })
})

describe('parseCustomServiceCatalog', () => {
  test('collects entries with required and optional fields', () => {
    const entries = parseCustomServiceCatalog([
      {
        package: '@acme/display',
        family: 'Acme Serif',
        latestVersion: '1.2.0',
        displayName: 'Acme 衬线',
        license: 'OFL-1.1',
        weights: ['400', '700'],
        variable: false
      }
    ])
    expect(entries).toEqual([
      {
        package: '@acme/display',
        family: 'Acme Serif',
        latestVersion: '1.2.0',
        displayName: 'Acme 衬线',
        license: 'OFL-1.1',
        weights: ['400', '700'],
        variable: false
      }
    ])
  })

  test('drops malformed items and non-conforming optional fields without throwing', () => {
    const entries = parseCustomServiceCatalog([
      null,
      'nope',
      42,
      { family: 'Missing Package' },
      { package: '@acme/x', family: '', latestVersion: '1.0.0' },
      { package: '@acme/x', family: 'Empty Version', latestVersion: '' },
      {
        package: '@acme/x',
        family: 'Bad Optionals',
        latestVersion: '1.0.0',
        displayName: 7,
        weights: ['400', 700],
        variable: 'yes'
      },
      { package: '@acme/x', family: 'Minimal', latestVersion: '1.0.0' }
    ])
    expect(entries).toEqual([
      { package: '@acme/x', family: 'Bad Optionals', latestVersion: '1.0.0' },
      { package: '@acme/x', family: 'Minimal', latestVersion: '1.0.0' }
    ])
  })

  test('returns an empty list for non-array payloads', () => {
    expect(parseCustomServiceCatalog({ package: '@acme/x' })).toEqual([])
    expect(parseCustomServiceCatalog('catalog')).toEqual([])
    expect(parseCustomServiceCatalog(null)).toEqual([])
  })
})

describe('customServiceCatalogURL', () => {
  test('appends catalog.json to the normalized base', () => {
    expect(
      customServiceCatalogURL({ baseURL: `${SERVICE_BASE}/`, token: 't', enabled: true })
    ).toBe(`${SERVICE_BASE}/catalog.json`)
    expect(
      customServiceCatalogURL({
        baseURL: `${SERVICE_BASE}/catalog.json`,
        token: 't',
        enabled: true
      })
    ).toBe(`${SERVICE_BASE}/catalog.json`)
  })
})

describe('scopeBearerFetch', () => {
  const base = SERVICE_BASE

  test('passes non-scoped URLs through inner untouched', async () => {
    const inner: WebFontFetch = async (url, init) => {
      expect(url).toBe('https://cdn.example.org/some/font.woff2')
      expect(init?.headers).toBe(initHeaders)
      return new Response('inner')
    }
    const direct: WebFontFetch = async () => {
      throw new Error('direct must not be called')
    }
    const initHeaders = { 'x-a': '1' }
    const scoped = scopeBearerFetch(base, 'tok', direct, inner)
    const response = await scoped('https://cdn.example.org/some/font.woff2', {
      headers: initHeaders
    })
    expect(await response.text()).toBe('inner')
  })

  test('routes scoped URLs through direct with a merged bearer header', async () => {
    let seenHeaders: Headers | null = null
    const direct: WebFontFetch = async (_url, init) => {
      seenHeaders = new Headers(init?.headers)
      return new Response('direct')
    }
    const inner: WebFontFetch = async () => {
      throw new Error('inner must not be called')
    }
    const scoped = scopeBearerFetch(base, 'tok', direct, inner)
    const response = await scoped(`${base}/@acme/x@1.0.0/dist/index.json`, {
      headers: { 'x-a': '1' }
    })
    expect(await response.text()).toBe('direct')
    expect(seenHeaders?.get('authorization')).toBe('Bearer tok')
    expect(seenHeaders?.get('x-a')).toBe('1')
  })

  test('rejects non-https scoped URLs before any request', async () => {
    let called = false
    const direct: WebFontFetch = async () => {
      called = true
      return new Response('nope')
    }
    // 守卫语义：用户把 http 服务地址配进来时拒发明文 Bearer——https base 下的
    // http URL 本就不匹配 base 前缀，走 inner 透传（由既有 web 字体守卫拒绝）。
    const scoped = scopeBearerFetch('http://svc.example.com', 'tok', direct, direct)
    await expect(scoped('http://svc.example.com/catalog.json')).rejects.toThrow(/https/i)
    expect(called).toBe(false)
  })

  test('enforces the 8MB limit via content-length before reading', async () => {
    const direct: WebFontFetch = async () =>
      new Response('tiny', {
        headers: { 'content-length': String(9 * 1024 * 1024) }
      })
    const scoped = scopeBearerFetch(base, 'tok', direct, direct)
    await expect(scoped(`${base}/big.woff2`)).rejects.toThrow(/size limit/i)
  })

  test('enforces the 8MB limit via the actually-read body', async () => {
    const big = new Uint8Array(9 * 1024 * 1024)
    const direct: WebFontFetch = async () => new Response(big)
    const scoped = scopeBearerFetch(base, 'tok', direct, direct)
    await expect(scoped(`${base}/big.woff2`)).rejects.toThrow(/size limit/i)
  })

  test('returns bounded responses with status and url preserved', async () => {
    const direct: WebFontFetch = async () => {
      const upstream = new Response(JSON.stringify(['Ok']), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      })
      Object.defineProperty(upstream, 'url', { value: `${base}/catalog.json` })
      return upstream
    }
    const scoped = scopeBearerFetch(base, 'tok', direct, direct)
    const response = await scoped(`${base}/catalog.json`)
    expect(response.status).toBe(201)
    expect(response.url).toBe(`${base}/catalog.json`)
    expect(await response.json()).toEqual(['Ok'])
  })
})

/**
 * 共享 disabled 集合注入口（local-source-gate.test.ts 的 probe 模式）：私有 allowlist
 * 的 replaceDisabled 是公开方法，经结构化类型探入。漏斗改造后 setFontFamilyEnabled
 * 对专属目录族路由进专属关停集合——表达「共享集合撞名」必须直注共享集合。
 */
function injectSharedDisabled(manager: FontManager, families: string[]): void {
  const probe = manager as unknown as {
    allowlist: { replaceDisabled(families: Iterable<string>): void }
  }
  probe.allowlist.replaceDisabled(families)
}

describe('FontManager custom service integration', () => {
  function makeManager(fetcher: WebFontFetch): FontManager {
    const manager = new FontManager()
    manager.setWebFontFetch(fetcher)
    return manager
  }

  test('appends custom entries with source custom and displayName', async () => {
    let requested = ''
    const manager = makeManager(async (url) => {
      requested = url
      return jsonResponse([
        {
          package: '@acme/display',
          family: 'Acme Serif',
          latestVersion: '1.2.0',
          displayName: 'Acme 衬线'
        }
      ])
    })
    const revisionBefore = manager.fontAllowlistRevision()
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    expect(manager.fontAllowlistRevision()).toBeGreaterThan(revisionBefore)
    const options = await manager.listFamilyOptions()
    expect(requested).toBe(`${SERVICE_BASE}/catalog.json`)
    const custom = options.find((option) => option.family === 'Acme Serif')
    expect(custom?.source).toBe('custom')
    expect(custom?.displayName).toBe('Acme 衬线')
  })

  test('custom entries win enumeration collisions against builtin registry families', async () => {
    const manager = makeManager(async () =>
      jsonResponse([{ package: '@acme/x', family: 'LXGW WenKai', latestVersion: '9.9.9' }])
    )
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    const options = await manager.listFamilyOptions()
    const hits = options.filter((option) => option.family === 'LXGW WenKai')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.source).toBe('custom')
  })

  test('disabled-set entries never hide custom families (web default-off name collisions)', async () => {
    const manager = makeManager(async () =>
      jsonResponse([{ package: '@acme/x', family: 'Acme Black', latestVersion: '1.0.0' }])
    )
    // disabled 集合混有 web 目录默认关停的同名条目：自定义族豁免逐族门控
    manager.setFontFamilyEnabled('Acme Black', false)
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    const options = await manager.listFamilyOptions()
    expect(options.find((o) => o.family === 'Acme Black')?.source).toBe('custom')
    const all = await manager.listFamilyOptions({ includeDisabled: true })
    expect(all.find((option) => option.family === 'Acme Black')?.source).toBe('custom')
  })

  test('config changes clear the catalog cache and refetch', async () => {
    let version = 1
    const urls: string[] = []
    const manager = makeManager(async (url) => {
      urls.push(url)
      return jsonResponse([
        { package: '@acme/x', family: `Acme V${version}`, latestVersion: '1.0.0' }
      ])
    })
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    expect((await manager.listFamilyOptions()).some((o) => o.family === 'Acme V1')).toBe(true)
    version = 2
    manager.setCustomFontService({ baseURL: `${SERVICE_BASE}/`, token: 'tok', enabled: true })
    const options = await manager.listFamilyOptions()
    expect(options.some((o) => o.family === 'Acme V2')).toBe(true)
    expect(options.some((o) => o.family === 'Acme V1')).toBe(false)
    expect(urls.filter((url) => url === `${SERVICE_BASE}/catalog.json`)).toHaveLength(2)
  })

  test('clearing the config drops custom entries and bumps the picker revision', async () => {
    const manager = makeManager(async () =>
      jsonResponse([{ package: '@acme/x', family: 'Acme Off', latestVersion: '1.0.0' }])
    )
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    expect((await manager.listFamilyOptions()).some((o) => o.family === 'Acme Off')).toBe(true)
    const revisionBefore = manager.fontAllowlistRevision()
    manager.setCustomFontService(null)
    expect(manager.fontAllowlistRevision()).toBeGreaterThan(revisionBefore)
    expect((await manager.listFamilyOptions()).some((o) => o.family === 'Acme Off')).toBe(false)
  })

  test('catalog failures degrade to an empty custom list without throwing', async () => {
    const manager = makeManager(async () => new Response('nope', { status: 500 }))
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    const options = await manager.listFamilyOptions()
    expect(options.some((option) => option.source === 'custom')).toBe(false)
  })

  test('a hanging catalog honors the picker list timeout', async () => {
    const manager = makeManager(
      () =>
        new Promise<Response>(() => {
          // 永不 settle——本用例验证的是 picker 列表超时兜底
        })
    )
    manager.setWebFontListTimeout(20)
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    const started = Date.now()
    const options = await manager.listFamilyOptions()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(options.some((option) => option.source === 'custom')).toBe(false)
  })

  test('custom families load through the existing cn subset pipeline with scoped auth', async () => {
    const catalog = [{ package: '@acme/display', family: 'Acme Serif', latestVersion: '1.2.0' }]
    const css =
      '@font-face{font-family:"Acme Serif";font-weight:400;font-style:normal;' +
      'unicode-range:U+0000-00FF;src:url("./abc.woff2") format("woff2")}'
    const seenAuth: Array<string | null> = []
    const upstream: WebFontFetch = async (url, init) => {
      seenAuth.push(new Headers(init?.headers).get('authorization'))
      if (url.endsWith('/catalog.json')) return jsonResponse(catalog)
      if (url.endsWith('/dist/index.json')) return jsonResponse(['AcmeSerif-Regular'])
      if (url.endsWith('/result.css')) return new Response(css)
      if (url.endsWith('/abc.woff2')) return new Response(new Uint8Array([0, 1, 2, 3]))
      return new Response('not found', { status: 404 })
    }
    const manager = new FontManager()
    manager.setWebFontFetch(scopeBearerFetch(SERVICE_BASE, 'tok', upstream, upstream))
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    const options = await manager.listFamilyOptions()
    expect(options.some((option) => option.family === 'Acme Serif')).toBe(true)
    const buffer = await manager.loadRemoteFont('Acme Serif', 'Regular', 'A')
    expect(buffer).not.toBeNull()
    expect(buffer?.byteLength).toBe(4)
    expect(seenAuth.length).toBeGreaterThan(0)
    expect(seenAuth.every((header) => header === 'Bearer tok')).toBe(true)
  })

  test('direct loads auto-fetch the catalog and bypass disabled-set collisions', async () => {
    const catalog = [{ package: '@acme/display', family: 'Acme Serif', latestVersion: '1.2.0' }]
    const css =
      '@font-face{font-family:"Acme Serif";font-weight:400;font-style:normal;' +
      'unicode-range:U+0000-00FF;src:url("./abc.woff2") format("woff2")}'
    const urls: string[] = []
    const upstream: WebFontFetch = async (url) => {
      urls.push(url)
      if (url.endsWith('/catalog.json')) return jsonResponse(catalog)
      if (url.endsWith('/dist/index.json')) return jsonResponse(['AcmeSerif-Regular'])
      if (url.endsWith('/result.css')) return new Response(css)
      if (url.endsWith('/abc.woff2')) return new Response(new Uint8Array([0, 1, 2, 3]))
      return new Response('not found', { status: 404 })
    }
    const manager = new FontManager()
    manager.setWebFontFetch(scopeBearerFetch(SERVICE_BASE, 'tok', upstream, upstream))
    // 撞名 web 默认关停：共享 disabled 集合中的同名条目不得阻断自定义族加载
    // （经 probe 直注共享集合——setFontFamilyEnabled 对专属族已路由走专属集合）
    injectSharedDisabled(manager, ['Acme Serif'])
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    // 文档打开直加载路径：不经 listFamilyOptions，目录由加载门控自行拉取，
    // 否则描述符解析会在目录到达前落进 registry/catalog/unifont 错源
    const buffer = await manager.loadRemoteFont('Acme Serif', 'Regular', 'A')
    expect(buffer?.byteLength).toBe(4)
    expect(urls[0]).toBe(`${SERVICE_BASE}/catalog.json`)
    expect(urls.some((url) => url.endsWith('/abc.woff2'))).toBe(true)
  })

  test('custom families load with the CN master switch off (switches never cross-gate)', async () => {
    const catalog = [{ package: '@acme/display', family: 'Acme Serif', latestVersion: '1.2.0' }]
    const css =
      '@font-face{font-family:"Acme Serif";font-weight:400;font-style:normal;' +
      'unicode-range:U+0000-00FF;src:url("./abc.woff2") format("woff2")}'
    const urls: string[] = []
    const upstream: WebFontFetch = async (url) => {
      urls.push(url)
      if (url.endsWith('/catalog.json')) return jsonResponse(catalog)
      if (url.endsWith('/dist/index.json')) return jsonResponse(['AcmeSerif-Regular'])
      if (url.endsWith('/result.css')) return new Response(css)
      if (url.endsWith('/abc.woff2')) return new Response(new Uint8Array([0, 1, 2, 3]))
      return new Response('not found', { status: 404 })
    }
    const manager = new FontManager()
    manager.setWebFontFetch(scopeBearerFetch(SERVICE_BASE, 'tok', upstream, upstream))
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    // 中文 CDN 总开关只管内置目录：关停不得株连专属服务（两者复用同一分片管线，
    // 门控须按来源各归各的开关）
    manager.setCnFontsEnabled(false)
    const buffer = await manager.loadRemoteFont('Acme Serif', 'Regular', 'A')
    expect(buffer?.byteLength).toBe(4)
    expect(urls.some((url) => url.endsWith('/abc.woff2'))).toBe(true)
  })
})

describe('custom family per-family switches', () => {
  const CATALOG = [{ package: '@acme/display', family: 'Acme Serif', latestVersion: '1.2.0' }]
  const CSS =
    '@font-face{font-family:"Acme Serif";font-weight:400;font-style:normal;' +
    'unicode-range:U+0000-00FF;src:url("./abc.woff2") format("woff2")}'
  const WOFF2 = new Uint8Array([0, 1, 2, 3])

  function makeSwitchManager(catalog: unknown = CATALOG): { manager: FontManager; urls: string[] } {
    const urls: string[] = []
    const upstream: WebFontFetch = async (url) => {
      urls.push(url)
      if (url.endsWith('/catalog.json')) return jsonResponse(catalog)
      if (url.endsWith('/dist/index.json')) return jsonResponse(['AcmeSerif-Regular'])
      if (url.endsWith('/result.css')) return new Response(CSS)
      if (url.endsWith('/abc.woff2')) return new Response(WOFF2)
      return new Response('not found', { status: 404 })
    }
    const manager = new FontManager()
    manager.setWebFontFetch(scopeBearerFetch(SERVICE_BASE, 'tok', upstream, upstream))
    manager.setCustomFontService({ baseURL: SERVICE_BASE, token: 'tok', enabled: true })
    return { manager, urls }
  }

  test('custom families default to enabled on a fresh manager', async () => {
    const { manager } = makeSwitchManager()
    // 先走一次枚举把目录拉下来——isCustomServiceFamily 依目录索引判定
    await manager.listFamilyOptions()
    expect(manager.isFontFamilyEnabled('Acme Serif')).toBe(true)
  })

  test('disabling a custom family hides it from the picker, keeps it in the panel list, blocks loads', async () => {
    const { manager } = makeSwitchManager()
    expect((await manager.listFamilyOptions()).some((o) => o.family === 'Acme Serif')).toBe(true)

    manager.setFontFamilyEnabled('Acme Serif', false)

    expect(manager.isFontFamilyEnabled('Acme Serif')).toBe(false)
    // 默认滤枚举：关停族从 picker 消失
    expect((await manager.listFamilyOptions()).some((o) => o.family === 'Acme Serif')).toBe(false)
    // includeDisabled（面板路径）不过滤：关停行仍在且标 custom 源
    const all = await manager.listFamilyOptions({ includeDisabled: true })
    expect(all.find((o) => o.family === 'Acme Serif')?.source).toBe('custom')
    // 加载门控同步拒载
    expect(await manager.loadRemoteFont('Acme Serif', 'Regular', 'A')).toBeNull()
  })

  test('re-enabling a custom family restores enumeration and loading', async () => {
    const { manager } = makeSwitchManager()
    await manager.listFamilyOptions()
    manager.setFontFamilyEnabled('Acme Serif', false)
    manager.setFontFamilyEnabled('Acme Serif', true)

    expect(manager.isFontFamilyEnabled('Acme Serif')).toBe(true)
    expect((await manager.listFamilyOptions()).some((o) => o.family === 'Acme Serif')).toBe(true)
    const buffer = await manager.loadRemoteFont('Acme Serif', 'Regular', 'A')
    expect(buffer?.byteLength).toBe(WOFF2.byteLength)
  })

  test('toggling a custom family never pollutes the shared disabled set on collisions', async () => {
    // 专属目录提供 Lato（撞名 Google Lato 场景）：专属关停写专属集合，
    // 共享 disabled 集合与同名非专属语境判定均不受影响
    const { manager } = makeSwitchManager([
      { package: '@acme/x', family: 'Lato', latestVersion: '1.0.0' }
    ])
    await manager.listFamilyOptions()

    manager.setFontFamilyEnabled('Lato', false)

    expect(manager.isFontFamilyEnabled('Lato')).toBe(false)
    expect(manager.disabledFontFamilies()).toEqual([])
    const allowlist = (manager as unknown as { allowlist: { isEnabled(family: string): boolean } })
      .allowlist
    expect(allowlist.isEnabled('Lato')).toBe(true)
  })

  test('setCustomDisabledFontFamilies batch-syncs and skips identical replay', async () => {
    const { manager } = makeSwitchManager()
    await manager.listFamilyOptions()
    const before = manager.fontAllowlistRevision()

    manager.setCustomDisabledFontFamilies(['Acme Serif'])

    expect(manager.fontAllowlistRevision()).toBeGreaterThan(before)
    expect((await manager.listFamilyOptions()).some((o) => o.family === 'Acme Serif')).toBe(false)

    // 同态重放不空转（allowlist commit 同守卫）
    const synced = manager.fontAllowlistRevision()
    manager.setCustomDisabledFontFamilies(['Acme Serif'])
    expect(manager.fontAllowlistRevision()).toBe(synced)
  })
})
