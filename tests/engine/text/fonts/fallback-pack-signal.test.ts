/**
 * CJK 回退链缺口 A：ensureFallbackPack 的 signal 分支曾绕过 prependBundledCJK——
 * signal 路径先填充共享链时 bundled PuHuiTi 优先级失守。
 * 钉扎：signal 路径同样 bundled 前插 + 中止语义不回归。
 * mock 模式沿用 cjk-fallback.test.ts。
 */
import { describe, expect, test } from 'bun:test'

import type { CanvasKit, TypefaceFontProvider } from 'canvaskit-wasm'

import { FontManager } from '@open-pencil/core/text'

function recordingProvider(): {
  provider: TypefaceFontProvider
  registrations: string[]
} {
  const registrations: string[] = []
  const provider = {
    registerFont(_data: ArrayBuffer, family: string) {
      registrations.push(family)
    }
  } as TypefaceFontProvider
  return { provider, registrations }
}

/** unifont provider 元数据请求快速回空（避免真实网络/退避重试拖慢单测） */
function fastEmptyFetch(): (url: string) => Promise<Response> {
  return async (url: string) => {
    if (url.endsWith('.woff2')) return new Response('nope', { status: 404 })
    return new Response('[]', { status: 200 })
  }
}

function makeManager(): FontManager {
  const manager = new FontManager()
  const { provider } = recordingProvider()
  manager.attachProvider({} as CanvasKit, provider)
  manager.setWebFontFetch(fastEmptyFetch())
  manager.setCnFontPieceCache(null)
  manager.setWebFontListTimeout(50)
  return manager
}

describe('ensureFallbackPack signal 路径（缺口 A）', () => {
  test('cjk + signal：bundled PuHuiTi 仍位于回退链首位', async () => {
    const manager = makeManager()

    const result = await manager.ensureFallbackPack(['cjk'], '', new AbortController().signal)

    expect(result.cjk).toBeDefined()
    expect(result.cjk?.[0]).toBe('Alibaba PuHuiTi')
    expect(manager.isLoaded('Alibaba PuHuiTi')).toBe(true)
  })

  test('cjk + characters + signal：bundled 前插与直调路径口径一致', async () => {
    const manager = makeManager()

    const result = await manager.ensureFallbackPack(['cjk'], '字', new AbortController().signal)

    expect(result.cjk?.[0]).toBe('Alibaba PuHuiTi')
  })

  test('已中止 signal 仍即抛（取消语义不回归）', async () => {
    const manager = makeManager()
    const controller = new AbortController()
    controller.abort()

    await expect(manager.ensureFallbackPack(['cjk'], '', controller.signal)).rejects.toThrow()
  })
})
