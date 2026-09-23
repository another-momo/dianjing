import { describe, expect, test } from 'bun:test'

// 走源码别名而非包桶：压实是本批新增 API，包桶解析到 dist 旧类型会误报
import {
  compactFontProvider,
  maybeCompactFontProvider,
  PROVIDER_COMPACTION_THRESHOLD_BYTES
} from '#core/canvas/renderer/fonts'
import { FontManager } from '#core/text/fonts'

interface FakeProvider {
  deleted: boolean
  families: string[]
  registerFont(data: ArrayBuffer, family: string): boolean
  delete(): void
}

function makeFakeProvider(): FakeProvider {
  return {
    deleted: false,
    families: [],
    registerFont(_data, family) {
      this.families.push(family)
      return true
    },
    delete() {
      this.deleted = true
    }
  }
}

function makeHost(fontProvider: FakeProvider | null) {
  const created: FakeProvider[] = []
  const host = {
    ck: {
      TypefaceFontProvider: {
        Make: () => {
          const provider = makeFakeProvider()
          created.push(provider)
          return provider
        }
      }
    } as never,
    fontProvider,
    fontGeneration: -1,
    destroyed: false,
    invalidated: 0,
    created,
    isDestroyed() {
      return host.destroyed
    },
    invalidateAllPictures() {
      host.invalidated++
    }
  }
  return host
}

describe('font provider 压实（WASM 4GB 天花板防线）', () => {
  test('压实释放旧 provider、只回放存活集、注册水位降到存活字节', () => {
    const manager = new FontManager()
    const stale = makeFakeProvider()
    const host = makeHost(stale)
    manager.attachProvider(null as never, stale as never)
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    manager.markLoaded('Noto Sans SC', 'Regular', new ArrayBuffer(200))
    // 逐出只释放 JS 侧，旧 provider 里的死注册残留（泄漏语义，probe.test.ts 已钉扎）
    manager.evictFont('Inter', 'Regular')
    expect(manager.providerRegisteredBytes()).toBe(300)

    expect(compactFontProvider(host as never, manager)).toBe(true)

    expect(stale.deleted).toBe(true)
    expect(host.created).toHaveLength(1)
    expect(host.fontProvider).toBe(host.created[0])
    // 新 provider 只回放存活键——死副本不随压实复活
    expect(host.created[0].families).toEqual(['Noto Sans SC'])
    expect(manager.providerRegisteredBytes()).toBe(200)
    // generation 跳变 + 全量 picture 失效：驱动 textPicture 对新 provider 重排
    expect(host.fontGeneration).toBe(manager.generation())
    expect(host.invalidated).toBe(1)
  })

  test('注册字节未超阈值不压实', () => {
    const manager = new FontManager()
    const stale = makeFakeProvider()
    const host = makeHost(stale)
    manager.attachProvider(null as never, stale as never)
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))

    expect(maybeCompactFontProvider(host as never, manager)).toBe(false)

    expect(stale.deleted).toBe(false)
    expect(host.created).toHaveLength(0)
    expect(host.fontProvider).toBe(stale)
  })

  test('注册字节超阈值压实（阈值可注入）', () => {
    const manager = new FontManager()
    const stale = makeFakeProvider()
    const host = makeHost(stale)
    manager.attachProvider(null as never, stale as never)
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))

    expect(maybeCompactFontProvider(host as never, manager, 99)).toBe(true)

    expect(stale.deleted).toBe(true)
    expect(host.fontProvider).toBe(host.created[0])
  })

  test('无 provider 或渲染器已销毁时压实 no-op', () => {
    const manager = new FontManager()
    const idle = makeHost(null)
    expect(compactFontProvider(idle as never, manager)).toBe(false)
    expect(idle.created).toHaveLength(0)

    const stale = makeFakeProvider()
    const destroyed = makeHost(stale)
    destroyed.destroyed = true
    expect(compactFontProvider(destroyed as never, manager)).toBe(false)
    expect(stale.deleted).toBe(false)
    expect(destroyed.created).toHaveLength(0)
  })

  test('默认阈值钉在 wasm32 4GB 天花板之下并留有余量', () => {
    const WASM32_LINEAR_MEMORY_CEILING = 4 * 1024 ** 3
    expect(PROVIDER_COMPACTION_THRESHOLD_BYTES).toBeLessThanOrEqual(
      WASM32_LINEAR_MEMORY_CEILING / 2
    )
  })
})
