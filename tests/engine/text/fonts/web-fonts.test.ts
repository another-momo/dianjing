import { describe, expect, test } from 'bun:test'

import {
  normalizedCoverageText,
  WebFontResolver,
  webFontSubsetsForText
} from '@open-pencil/core/text'
import type { WebFontFetch } from '@open-pencil/core/text'

describe('web font coverage requests', () => {
  test('normalizes coverage without splitting supplementary code points', () => {
    expect(normalizedCoverageText('界A界𠀀A')).toBe(normalizedCoverageText('A界𠀀'))
    expect(Array.from(normalizedCoverageText('𠀀'))).toEqual(['𠀀'])
  })

  test('aborts a font load queued behind an active provider request', async () => {
    const resolver = new WebFontResolver()
    resolver.setEnabled({ google: true })
    let requestStarted: (() => void) | null = null
    let releaseRequest: (() => void) | null = null
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    const blocked = new Promise<Response>((resolve) => {
      releaseRequest = () => resolve(new Response('{}', { status: 200 }))
    })
    resolver.setRemoteFetch(async () => {
      requestStarted?.()
      return blocked
    })
    const first = resolver.listFamilies('google')
    await started
    const abort = new AbortController()
    const queued = resolver.fetchFont(['Inter'], 'Regular', '', abort.signal)

    abort.abort()

    await expect(queued).rejects.toHaveProperty('name', 'AbortError')
    releaseRequest?.()
    await first
  })

  test('aborts promptly while provider resolution is pending', async () => {
    const resolver = new WebFontResolver()
    resolver.setEnabled({ google: true })
    let providerRequestStarted: (() => void) | null = null
    let releaseProviderRequest: (() => void) | null = null
    const started = new Promise<void>((resolve) => {
      providerRequestStarted = resolve
    })
    const blocked = new Promise<Response>((resolve) => {
      releaseProviderRequest = () => resolve(new Response('{}', { status: 200 }))
    })
    resolver.setRemoteFetch(async () => {
      providerRequestStarted?.()
      return blocked
    })
    const abort = new AbortController()
    const loading = resolver.fetchFont(['Inter'], 'Regular', '', abort.signal)
    await started

    abort.abort()

    await expect(loading).rejects.toHaveProperty('name', 'AbortError')
    releaseProviderRequest?.()
  })

  test('requests script-specific subsets instead of Latin only', () => {
    expect(webFontSubsetsForText('مرحبا')).toContain('arabic')
    expect(webFontSubsetsForText('한글')).toContain('korean')
    expect(webFontSubsetsForText('かな')).toContain('japanese')
    expect(webFontSubsetsForText('你好')).toEqual(
      expect.arrayContaining(['chinese-simplified', 'chinese-traditional', 'japanese'])
    )
  })
})

describe('web font family enumeration failure caching', () => {
  interface FetcherState {
    calls: number
    ok: boolean
  }

  /** fontsource 元数据形态的桩响应（provider init 拉 /fonts，listFonts 返回 family 名单） */
  function trackingFetcher(state: FetcherState): WebFontFetch {
    return async () => {
      state.calls++
      if (!state.ok) throw new TypeError('font metadata unreachable')
      return new Response(JSON.stringify([{ family: 'Inter' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  }

  test('retries after the failure record expires instead of caching the failure forever', async () => {
    const resolver = new WebFontResolver({ familiesFailureTtlMs: 0 })
    resolver.setEnabled({ fontsource: true })
    const state: FetcherState = { calls: 0, ok: false }
    resolver.setRemoteFetch(trackingFetcher(state))

    await expect(resolver.listFamilies('fontsource')).resolves.toEqual([])
    expect(state.calls).toBeGreaterThan(0)

    // TTL = 0：失败记录即刻过期，重调必须重发请求（成功后返回真实枚举）
    state.ok = true
    await expect(resolver.listFamilies('fontsource')).resolves.toEqual(['Inter'])
    expect(state.calls).toBeGreaterThan(1)
  })

  test('does not re-issue requests within the failure TTL', async () => {
    const resolver = new WebFontResolver()
    resolver.setEnabled({ fontsource: true })
    const state: FetcherState = { calls: 0, ok: false }
    resolver.setRemoteFetch(trackingFetcher(state))

    await expect(resolver.listFamilies('fontsource')).resolves.toEqual([])
    const callsAfterFailure = state.calls
    expect(callsAfterFailure).toBeGreaterThan(0)

    await expect(resolver.listFamilies('fontsource')).resolves.toEqual([])
    expect(state.calls).toBe(callsAfterFailure)
  })

  test('setEnabled with identical settings clears the failure record and forces a retry', async () => {
    const resolver = new WebFontResolver()
    resolver.setEnabled({ fontsource: true })
    const state: FetcherState = { calls: 0, ok: false }
    resolver.setRemoteFetch(trackingFetcher(state))

    await expect(resolver.listFamilies('fontsource')).resolves.toEqual([])
    const callsAfterFailure = state.calls

    // 同值重设（settings 无变化）也算显式重试意图
    resolver.setEnabled({ fontsource: true })
    state.ok = true
    await expect(resolver.listFamilies('fontsource')).resolves.toEqual(['Inter'])
    expect(state.calls).toBeGreaterThan(callsAfterFailure)
  })

  test('caches a successful enumeration permanently', async () => {
    const resolver = new WebFontResolver()
    resolver.setEnabled({ fontsource: true })
    const state: FetcherState = { calls: 0, ok: true }
    resolver.setRemoteFetch(trackingFetcher(state))

    await expect(resolver.listFamilies('fontsource')).resolves.toEqual(['Inter'])
    const callsAfterSuccess = state.calls

    // 网络转坏也不重发：成功结果永久缓存
    state.ok = false
    await expect(resolver.listFamilies('fontsource')).resolves.toEqual(['Inter'])
    expect(state.calls).toBe(callsAfterSuccess)
  })
})
