/**
 * 2026-09-26 load_image URL 直连支持：fetch-image-url 模块单测。
 *
 * 全部经注入 fetchImpl 桩，永不碰 globalThis.fetch / 永不走真实网络。
 * 夹具 URL 用假主机名（*.example.test 在所有 CI 平台都不存在，dns 黑
 * 名单保证不会意外命中真主机）。
 *
 * 覆盖（与设计规格一一对应）：
 *  - https URL happy path
 *  - data: URL base64 解码 + contentType
 *  - 非 base64 data: URL → error
 *  - scheme 闸（file://、ftp:）→ error 且未 fetch
 *  - SSRF 名单逐代表命中（127.0.0.1 / localhost / 10.* / 192.168.* /
 *    172.16.* / 169.254.* / [::1] / 0.0.0.0）→ error 且未 fetch
 *  - 重定向跟随（302 → 200）→ 成功且 fileName 取最终 URL
 *  - 重定向到被禁主机 → error
 *  - 重定向超 5 跳 → error
 *  - Content-Length 预检超限 → 不读 body 即拒
 *  - 流式中途超限 → 拒
 *  - 非 2xx（404）→ error 含状态码
 *  - 非法 URL → error
 *  - 超时：stub 在 init.signal abort 时 reject（保证终态）
 */
import { describe, expect, test } from 'bun:test'

import { fetchImageFromURL } from '@/app/ai/pi-backend/fetch-image-url'

// ── 测试桩形态 ──

/** fetchImpl 类型对位 globalThis.fetch；测试桩按需替换 */
type FetchStub = typeof fetch

/** 测试桩取 URL 字符串：fetchImpl 接 string/URL/Request 三种入参，
 *  我们关注字符串形式 URL——URL/Request 都抽 href/url 字段。 */
function inputURL(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && 'url' in input) {
    const u = (input as { url: unknown }).url
    if (typeof u === 'string') return u
  }
  return String(input)
}

/** PNG 真实 magic bytes（8 字节） */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64')

/** 构造流式响应（按需给 status / headers / chunks） */
function streamResponse(
  status: number,
  headers: Record<string, string>,
  chunks: Uint8Array[]
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    }
  })
  return new Response(body, { status, headers })
}

/** 构造简单响应（一字节体） */
function simpleResponse(status: number, headers: Record<string, string>, body = 'x'): Response {
  return new Response(body, { status, headers })
}

// ── happy path ──

describe('happy path', () => {
  test('https URL → bytes / fileName / contentType 正确', async () => {
    const stub: FetchStub = async () =>
      simpleResponse(200, { 'content-type': 'image/png' }, Buffer.from(PNG_BYTES))
    const result = await fetchImageFromURL('https://cdn.example.test/photo.png', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytes).toEqual(PNG_BYTES)
      expect(result.fileName).toBe('photo.png')
      expect(result.contentType).toBe('image/png')
    }
  })

  test('data:image/png;base64,... → 解码正确、contentType 正确', async () => {
    const result = await fetchImageFromURL(`data:image/png;base64,${PNG_B64}`, {
      maxBytes: 1024
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytes).toEqual(PNG_BYTES)
      expect(result.contentType).toBe('image/png')
      expect(result.fileName).toBe('image')
    }
  })

  test('URL 含百分号编码路径段 → fileName decode 正确', async () => {
    const stub: FetchStub = async () =>
      simpleResponse(200, { 'content-type': 'image/png' }, Buffer.from(PNG_BYTES))
    const result = await fetchImageFromURL('https://cdn.example.test/hei%C3%A9.png', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.fileName).toBe('hei\u00e9.png')
  })
})

// ── data: URL 错误面 ──

describe('data: URL 错误面', () => {
  test('非 base64 data: URL → error', async () => {
    const result = await fetchImageFromURL('data:image/png;charset=utf-8,%3Csvg%3E', {
      maxBytes: 1024
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('base64')
  })

  test('data: URL 字节超 maxBytes → too large error', async () => {
    // 100 字节 PNG 假装（base64 串长 ≈ 136 字符；设 maxBytes = 50 即拒）
    const fake = new Uint8Array(100)
    const b64 = Buffer.from(fake).toString('base64')
    const result = await fetchImageFromURL(`data:image/png;base64,${b64}`, {
      maxBytes: 50
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('too large')
      expect(result.error).toContain('Maximum supported size')
    }
  })
})

// ── scheme 闸 ──

describe('scheme 闸', () => {
  test.each(['file:///etc/passwd', 'ftp://example.com/x.png'])(
    '%s → error 且 fetchImpl 未被调用',
    async (url) => {
      let calls = 0
      const stub: FetchStub = async () => {
        calls++
        return simpleResponse(200, {})
      }
      const result = await fetchImageFromURL(url, { maxBytes: 1024, fetchImpl: stub })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('Unsupported URL scheme')
      expect(calls).toBe(0)
    }
  )

  test('非法 URL → error（不调 fetchImpl）', async () => {
    let calls = 0
    const stub: FetchStub = async () => {
      calls++
      return simpleResponse(200, {})
    }
    const result = await fetchImageFromURL('not a url at all', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Invalid URL')
    expect(calls).toBe(0)
  })
})

// ── SSRF 闸 ──

describe('SSRF 主机名单', () => {
  // 八个逐代表命中（含端口 / 子域 / 链路本地元数据 / IPv6 回环 / 全零）
  const deniedHosts = [
    'http://127.0.0.1:7600/x',
    'http://localhost/x',
    'http://api.localhost/x',
    'http://10.1.2.3/x',
    'http://192.168.0.1/x',
    'http://172.16.0.1/x',
    'http://169.254.169.254/latest',
    'http://[::1]/x',
    'http://0.0.0.0/x'
  ]

  test.each(deniedHosts)('%s → error 且 fetchImpl 未调用', async (url) => {
    let calls = 0
    const stub: FetchStub = async () => {
      calls++
      return simpleResponse(200, {})
    }
    const result = await fetchImageFromURL(url, { maxBytes: 1024, fetchImpl: stub })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('loopback, link-local or private network')
    expect(calls).toBe(0)
  })

  test('公网主机放行（sanity：避免名单误伤）', async () => {
    const stub: FetchStub = async () =>
      simpleResponse(200, { 'content-type': 'image/png' }, Buffer.from(PNG_BYTES))
    const result = await fetchImageFromURL('https://cdn.example.test/x.png', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(true)
  })
})

// ── 重定向 ──

describe('重定向', () => {
  test('302 → 最终 200 跟随成功，fileName 取最终 URL', async () => {
    const calls: string[] = []
    const stub: FetchStub = async (input) => {
      const url = inputURL(input)
      calls.push(url)
      if (url === 'https://cdn.example.test/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.test/redirected/final.png' }
        })
      }
      return simpleResponse(200, { 'content-type': 'image/png' }, Buffer.from(PNG_BYTES))
    }
    const result = await fetchImageFromURL('https://cdn.example.test/start', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.fileName).toBe('final.png')
      expect(result.bytes).toEqual(PNG_BYTES)
    }
    expect(calls).toEqual([
      'https://cdn.example.test/start',
      'https://cdn.example.test/redirected/final.png'
    ])
  })

  test('重定向到被禁主机 → error 且不发起内网 fetch', async () => {
    let calls: string[] = []
    const stub: FetchStub = async (input) => {
      const url = inputURL(input)
      calls.push(url)
      if (url === 'https://cdn.example.test/start') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:7600/x' } })
      }
      return simpleResponse(200, {})
    }
    const result = await fetchImageFromURL('https://cdn.example.test/start', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('loopback, link-local or private network')
    // 仅初次 fetch；内网目标 SSRF 闸在 fetch 前拒，未发起
    expect(calls).toEqual(['https://cdn.example.test/start'])
  })

  test('重定向 Location 缺失 → error', async () => {
    const stub: FetchStub = async () => new Response(null, { status: 302, headers: {} })
    const result = await fetchImageFromURL('https://cdn.example.test/start', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('missing Location')
  })

  test('重定向超 5 跳 → error', async () => {
    let calls = 0
    const stub: FetchStub = async () => {
      calls++
      return new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example.test/loop' }
      })
    }
    const result = await fetchImageFromURL('https://cdn.example.test/loop', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Too many redirects')
    // 6 次 fetch：初次 + 5 次重定向全部 302 触发上限
    expect(calls).toBe(6)
  })
})

// ── 字节上限 ──

describe('字节上限', () => {
  test('Content-Length 预检超限 → 不读 body 即拒', async () => {
    // 只凭 header 拒，不消费 body（Bun 引擎流内部 pull 时机不可移植，
    // 断言落在功能面——无 bytes 返回 + 错误文案准确）
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5000))
      }
    })
    const stub: FetchStub = async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '5000' }
      })
    const result = await fetchImageFromURL('https://cdn.example.test/x.png', {
      maxBytes: 1000,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('too large')
      expect(result.error).toContain('Maximum supported size is 1MB')
    }
  })

  test('流式中途超限 → cancel + 拒（流仍可写但被 reader.cancel 截断）', async () => {
    const stub: FetchStub = async () =>
      streamResponse(200, { 'content-type': 'image/png' }, [
        new Uint8Array(100),
        new Uint8Array(100)
      ])
    const result = await fetchImageFromURL('https://cdn.example.test/x.png', {
      maxBytes: 150,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('too large')
      expect(result.error).toContain('Maximum supported size is 1MB')
    }
  })

  test('Content-Length 不超但实际流超限 → 仍以累计为准拒', async () => {
    // 服务器撒谎：声明 100 字节但实际灌 300（Content-Length 是 hint，HTTP/1.1 允许）
    const stub: FetchStub = async () =>
      streamResponse(200, { 'content-type': 'image/png', 'content-length': '100' }, [
        new Uint8Array(150),
        new Uint8Array(150)
      ])
    const result = await fetchImageFromURL('https://cdn.example.test/x.png', {
      maxBytes: 200,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('too large')
  })
})

// ── HTTP 错误面 ──

describe('HTTP 错误面', () => {
  test('404 → error 含状态码', async () => {
    const stub: FetchStub = async () => simpleResponse(404, {})
    const result = await fetchImageFromURL('https://cdn.example.test/missing.png', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('404')
      expect(result.error).toContain('cdn.example.test/missing.png')
    }
  })

  test('500 → error 含状态码', async () => {
    const stub: FetchStub = async () => simpleResponse(500, {})
    const result = await fetchImageFromURL('https://cdn.example.test/x.png', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('500')
  })

  test('fetchImpl 抛错（连接级）→ error', async () => {
    const stub: FetchStub = async () => {
      throw new Error('ECONNREFUSED')
    }
    const result = await fetchImageFromURL('https://cdn.example.test/x.png', {
      maxBytes: 1024,
      fetchImpl: stub
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('ECONNREFUSED')
      expect(result.error).toContain('cdn.example.test')
    }
  })
})

// ── 超时 ──

describe('超时', () => {
  test('init.signal abort 后 reject → 落「Request timed out」', async () => {
    // stub 监听 init.signal abort 事件；abort 触发即 reject——保证终态不挂死
    const stub = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        } else {
          reject(new Error('no signal'))
        }
      })
    }) as FetchStub
    const result = await fetchImageFromURL('https://cdn.example.test/x.png', {
      maxBytes: 1024,
      fetchImpl: stub,
      timeoutMs: 20
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('timed out')
      expect(result.error).toContain('20ms')
    }
  })
})
