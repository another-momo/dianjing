import { describe, expect, test } from 'bun:test'

import { scopeBearerFetch, WebFontResolver, type WebFontFetch } from '@open-pencil/core/text'

const SERVICE_BASE = 'https://custom-svc.example.com'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/**
 * font-fetch-proxy 回归钉扎。
 *
 * 背景：WebFontResolver 的 fetch 代理窗口（withFetchProxy）在 unifont 操作期间把
 * globalThis.fetch 临时换成代理版，代理版把一切 http(s) 请求路由回 remoteFetch。
 * 专属字体服务启用时 remoteFetch = scopeBearerFetch(base, token, direct, inner)：
 * 专属前缀 URL 走 direct，其余走 inner（baseFontFetch）。若 direct 晚绑定全局
 * fetch（修复前 `(url, init) => fetch(url, init)` 形态），窗口期内解析到的是
 * 代理版 → 请求被重新路由回 remoteFetch → 再命中 direct → 同步无限递归，
 * 以 RangeError: Maximum call stack size exceeded 告终。
 *
 * 因此 direct fetcher 必须持有模块加载时捕获的原始 fetch 引用（急绑定先例：
 * browser-fetch.ts 的 browserWebFontFetch 正是为此在模块顶层 bind）。本文件用
 * 真实 WebFontResolver + 真实 scopeBearerFetch 钉三条约束：
 * 1. 晚绑定裸 fetch 在窗口期内确实同步递归（深度上限防真死循环）——机制证据；
 * 2. 急绑定 direct 在窗口期内零重入：恰好一次网络调用、Bearer 恰好注入一次；
 * 3. 窗口内 http(s) fetch 仍全部路由进 remoteFetch（白名单守卫语义不变），
 *    窗口关闭后全局 fetch 还原。
 *
 * 生产 customDirectFetch 所在的 app 模块带 localStorage/IndexedDB 顶层副作用，
 * 测试进程不可整体导入，故以同形态替身钉扎接线模式；生产侧改动为两行（捕获 +
 * 引用替换），随 diff review，并由末条源码形态钉扎用例防回退。
 */
describe('font fetch proxy window recursion', () => {
  interface WindowFixture {
    scoped: WebFontFetch
    enumeration: Promise<string[]>
    innerStarted: Promise<void>
    releaseInner: () => void
  }

  /**
   * 打开一个真实代理窗口并按住不放：resolver 走真实 unifont 枚举，其首个
   * http(s) fetch 经代理层路由进 inner 后阻塞——inner 阻塞期间窗口必然开着
   * （操作未 settle，finally 不会还原 fetch），此时对 scoped fetcher 的直取
   * 与生产 fonts.ts 目录枚举通路（直接调 webFontFetch）同形态。
   */
  function openWindow(direct: WebFontFetch, inner: WebFontFetch): WindowFixture {
    let release: (() => void) | null = null
    const innerReleased = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    let entered: (() => void) | null = null
    const innerStarted = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blockingInner: WebFontFetch = async (url, init) => {
      entered?.()
      await innerReleased
      return inner(url, init)
    }
    const scoped = scopeBearerFetch(SERVICE_BASE, 'tok', direct, blockingInner)
    const resolver = new WebFontResolver()
    resolver.setEnabled({ fontsource: true })
    resolver.setRemoteFetch(scoped)
    return {
      scoped,
      enumeration: resolver.listFamilies('fontsource'),
      innerStarted,
      releaseInner: () => release?.()
    }
  }

  test('a late-bound bare fetch inside direct re-enters the open proxy window and recurses', async () => {
    const windowFetch = globalThis.fetch
    const recursionDepthCap = 32
    let depth = 0
    // 修复前 customDirectFetch 的晚绑定形态：调用时才解析全局 fetch，
    // 窗口期内解析到代理版 → 重入 remoteFetch → 同步递归
    const lateBoundDirect: WebFontFetch = (url, init) => {
      depth++
      if (depth > recursionDepthCap) {
        throw new Error(
          `expected the direct fetch to stay outside the proxy window, but it re-entered and recursed past the depth cap of ${recursionDepthCap}`
        )
      }
      return fetch(url, init)
    }
    const { scoped, enumeration, innerStarted, releaseInner } = openWindow(
      lateBoundDirect,
      async () => jsonResponse(['StubFamily'])
    )

    try {
      await innerStarted
      await expect(scoped(`${SERVICE_BASE}/catalog.json`)).rejects.toThrow(
        /recursed past the depth cap/
      )
      // 递归真实发生（每圈恰好一次 direct 调用），而非单次失败
      expect(depth).toBe(recursionDepthCap + 1)
    } finally {
      releaseInner()
      await enumeration
      expect(globalThis.fetch).toBe(windowFetch)
    }
  })

  test('an eagerly bound direct fetch stays outside the open proxy window with a single bearer injection', async () => {
    const windowFetch = globalThis.fetch
    // 模拟网络层：修复后的 customDirectFetch 在模块加载时捕获的正是这个引用
    let networkCalls = 0
    const seenAuth: Array<string | null> = []
    const networkFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      networkCalls++
      seenAuth.push(new Headers(init?.headers).get('authorization'))
      return jsonResponse(['StubFamily'])
    }) as typeof fetch
    globalThis.fetch = networkFetch

    try {
      // 修复后 customDirectFetch 形态：急绑定（捕获窗口开启前的全局 fetch 引用）
      const eagerBoundDirect: WebFontFetch = (url, init) => networkFetch(url, init)
      const { scoped, enumeration, innerStarted, releaseInner } = openWindow(
        eagerBoundDirect,
        async () => jsonResponse(['StubFamily'])
      )

      try {
        await innerStarted
        const response = await scoped(`${SERVICE_BASE}/catalog.json`)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(['StubFamily'])
        expect(networkCalls).toBe(1)
        expect(seenAuth).toEqual(['Bearer tok'])
      } finally {
        releaseInner()
        await enumeration
        expect(globalThis.fetch).toBe(networkFetch)
      }
    } finally {
      globalThis.fetch = windowFetch
    }
  })

  test('http(s) fetches inside the window still route through remoteFetch and the window closes cleanly', async () => {
    const windowFetch = globalThis.fetch
    const routed: string[] = []
    const { enumeration, releaseInner } = openWindow(
      async () => {
        throw new Error('direct must not be called for non-scoped font provider URLs')
      },
      async (url) => {
        routed.push(url)
        return jsonResponse(['StubFamily'])
      }
    )

    try {
      releaseInner()
      await enumeration
      // 窗口内 unifont 的 http(s) fetch 全部经代理层路由进 remoteFetch（守卫语义不变）
      expect(routed.length).toBeGreaterThan(0)
      expect(globalThis.fetch).toBe(windowFetch)
    } finally {
      releaseInner()
      globalThis.fetch = windowFetch
    }
  })

  test('production customDirectFetch keeps using the eagerly bound browser fetch', async () => {
    // 源码形态钉扎：替身用例钉不住生产侧回退（机制测试对晚绑定回归不翻红），
    // 此处直接断言生产定义引用急绑定捕获、不再内联晚绑定裸 fetch
    const source = await Bun.file('src/app/editor/fonts/index.ts').text()
    const match = /const customDirectFetch[\s\S]{0,300}/.exec(source)
    expect(match).not.toBeNull()
    expect(match![0]).toContain('browserDirectFetch')
    expect(match![0]).not.toMatch(/\(\s*url[^)]*\)\s*=>\s*fetch\(/)
  })
})
