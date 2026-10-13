/**
 * T84：bundled PuHuiTi 前插 CJK 回退链——三连钉：
 * ① bundled 命中时位于 CJK 回退链首位；
 * ② bundled 加载失败时链行为一致（链上无该族，不 throw）；
 * ③ 幂等（二次调用不重复 unshift）。
 *
 * 钉扎路径与 owner 验收三连对应。
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

describe('bundled PuHuiTi 前插 CJK 回退链 (T84)', () => {
  test('① bundled 命中时位于 CJK 回退链首位', async () => {
    const manager = new FontManager()
    const { provider, registrations } = recordingProvider()
    manager.attachProvider({} as CanvasKit, provider)

    const families = await manager.ensureCJKFallback()

    expect(families.length).toBeGreaterThan(0)
    expect(families[0]).toBe('Alibaba PuHuiTi')
    expect(registrations).toContain('Alibaba PuHuiTi')
    expect(manager.isLoaded('Alibaba PuHuiTi')).toBe(true)
  })

  test('② bundled 加载失败时链行为与现状一致（降级到本地/远端，不 throw）', async () => {
    const manager = new FontManager()
    const { provider } = recordingProvider()
    manager.attachProvider({} as CanvasKit, provider)

    // 模拟 bundled 端失败：截断 PuHuiTi 加载，其余族 loadFont 行为不变。
    const originalLoadFont = manager.loadFont.bind(manager)
    manager.loadFont = (async (family: string, style = 'Regular', characters = '') => {
      if (family === 'Alibaba PuHuiTi') return null
      return originalLoadFont(family, style, characters)
    }) as typeof manager.loadFont

    const families = await manager.ensureCJKFallback()

    expect(Array.isArray(families)).toBe(true)
    expect(families).not.toContain('Alibaba PuHuiTi')
  })

  test('③ 幂等：二次调用不重复 unshift', async () => {
    const manager = new FontManager()
    const { provider } = recordingProvider()
    manager.attachProvider({} as CanvasKit, provider)

    const first = await manager.ensureCJKFallback()
    const second = await manager.ensureCJKFallback()

    expect(first).toBe(second)
    expect(first.filter((family) => family === 'Alibaba PuHuiTi')).toHaveLength(1)
    expect(first[0]).toBe('Alibaba PuHuiTi')
  })

  test('ensureFallbackPack 直调路径（cjk + characters）也保证 bundled 在最前', async () => {
    const manager = new FontManager()
    const { provider } = recordingProvider()
    manager.attachProvider({} as CanvasKit, provider)

    const result = await manager.ensureFallbackPack(['cjk'], '字')

    expect(result.cjk).toBeDefined()
    expect(result.cjk?.[0]).toBe('Alibaba PuHuiTi')
  })
})

// T88：直画路径多 typeface 装配硬约束——
// 校验 loadFonts 后 latin/cjk/arabic 三 typeface 在 fontManager 缓存中都为非 null 字节（直画路径硬约束；T84 仅覆盖 TypefaceFontProvider 注册层，未涉及 loadFont buffer 实际就位）。
const T88_FAMILIES = ['Inter', 'Alibaba PuHuiTi', 'Noto Naskh Arabic'] as const
for (const family of T88_FAMILIES) {
  test(`T88 ${family} 字节 buffer loadFont 后 isLoaded=true`, async () => {
    const manager = new FontManager()
    const { provider } = recordingProvider()
    manager.attachProvider({} as CanvasKit, provider)

    const buffer = await manager.loadFont(family, 'Regular')
    expect(buffer).not.toBeNull()
    expect(manager.isLoaded(family)).toBe(true)
  })
}
