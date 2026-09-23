import { describe, expect, test } from 'bun:test'

// 走源码别名而非包桶：压实是本批新增 API，包桶解析到 dist 旧类型会误报
import {
  compactFontProvider,
  maybeCompactFontProvider,
  resetProviderCompactionCooldown,
  PROVIDER_COMPACTION_MIN_DEAD_BYTES,
  PROVIDER_COMPACTION_THRESHOLD_BYTES
} from '#core/canvas/renderer/fonts'
import { FontManager } from '#core/text/fonts'

interface FakeProvider {
  id: string
  deleted: boolean
  families: string[]
  registerFont(data: ArrayBuffer, family: string): boolean
  delete(): void
}

function makeFakeProvider(id: string, events: string[]): FakeProvider {
  return {
    id,
    deleted: false,
    families: [],
    registerFont(_data, family) {
      this.families.push(family)
      events.push(`${id}:register:${family}`)
      return true
    },
    delete() {
      this.deleted = true
      events.push(`${id}:delete`)
    }
  }
}

function makeCk(created: FakeProvider[], events: string[]) {
  return {
    TypefaceFontProvider: {
      Make: () => {
        const provider = makeFakeProvider(`p${created.length}`, events)
        created.push(provider)
        return provider
      }
    }
  } as never
}

function makeHost(id: string, events: string[]) {
  const state = {
    destroyed: false,
    prepared: 0,
    provider: null as FakeProvider | null,
    generation: -1
  }
  const host = {
    isDestroyed: () => state.destroyed,
    prepareProviderSwap: () => {
      state.prepared++
      events.push(`${id}:prepare`)
    },
    acceptProvider: (provider: FakeProvider, generation: number) => {
      state.provider = provider
      state.generation = generation
      events.push(`${id}:accept:${provider.id}`)
    }
  }
  return { host, state }
}

const liveRenderer = { isDestroyed: () => false }

describe('font provider 压实（WASM 4GB 天花板防线）', () => {
  test('共享 provider 幂等：全部画布层持同一 provider，注册只进一份', () => {
    const events: string[] = []
    const created: FakeProvider[] = []
    const manager = new FontManager()
    const ck = makeCk(created, events)

    const first = manager.ensureSharedProvider(ck)
    const second = manager.ensureSharedProvider(ck)

    expect(second).toBe(first)
    expect(created).toHaveLength(1)
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    expect(created[0].families).toEqual(['Inter'])
    expect(manager.providerRegisteredBytes()).toBe(100)
  })

  test('压实协奏：全宿主先清缓存→回放存活集→删旧 provider→全宿主接入同一新 provider', () => {
    const events: string[] = []
    const created: FakeProvider[] = []
    const manager = new FontManager()
    manager.ensureSharedProvider(makeCk(created, events))
    const stale = created[0]
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    manager.markLoaded('Noto Sans SC', 'Regular', new ArrayBuffer(200))
    // 逐出只释放 JS 侧，旧 provider 里的死注册残留（泄漏语义，probe.test.ts 已钉扎）
    manager.evictFont('Inter', 'Regular')
    expect(manager.providerRegisteredBytes()).toBe(300)
    const a = makeHost('A', events)
    const b = makeHost('B', events)
    manager.registerProviderHost(a.host as never)
    manager.registerProviderHost(b.host as never)

    expect(compactFontProvider(liveRenderer, manager)).toBe(true)

    expect(stale.deleted).toBe(true)
    expect(created).toHaveLength(2)
    const fresh = created[1]
    // 新 provider 只回放存活键——死副本不随压实复活
    expect(fresh.families).toEqual(['Noto Sans SC'])
    // 注册水位降到存活字节 ×1（共享单例，不再乘层数）
    expect(manager.providerRegisteredBytes()).toBe(200)
    // 两宿主都先清缓存、后接入同一新 provider，generation 同步跳变
    expect(a.state.prepared).toBe(1)
    expect(b.state.prepared).toBe(1)
    expect(a.state.provider).toBe(fresh)
    expect(b.state.provider).toBe(fresh)
    expect(a.state.generation).toBe(manager.generation())
    expect(b.state.generation).toBe(manager.generation())
  })

  test('顺序铁律：宿主清缓存先于旧 provider delete（先删后清 = UAF，轮 9 实证堆腐败）', () => {
    const events: string[] = []
    const created: FakeProvider[] = []
    const manager = new FontManager()
    manager.ensureSharedProvider(makeCk(created, events))
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    const a = makeHost('A', events)
    manager.registerProviderHost(a.host as never)

    expect(compactFontProvider(liveRenderer, manager)).toBe(true)

    const prepareAt = events.indexOf('A:prepare')
    const deleteAt = events.indexOf('p0:delete')
    const acceptAt = events.indexOf('A:accept:p1')
    expect(prepareAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeGreaterThan(prepareAt)
    expect(acceptAt).toBeGreaterThan(deleteAt)
  })

  test('注册字节未超阈值不压实', () => {
    const events: string[] = []
    const created: FakeProvider[] = []
    const manager = new FontManager()
    manager.ensureSharedProvider(makeCk(created, events))
    const stale = created[0]
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))

    expect(maybeCompactFontProvider(liveRenderer, manager)).toBe(false)

    expect(stale.deleted).toBe(false)
    expect(created).toHaveLength(1)
  })

  test('超阈值但死副本太薄不压实（存活集自身超阈值时空转闸）', () => {
    const events: string[] = []
    const created: FakeProvider[] = []
    const manager = new FontManager()
    manager.ensureSharedProvider(makeCk(created, events))
    const stale = created[0]
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    // registered=100 全存活（dead=0）；阈值 99 已破，但死副本不足 margin
    expect(maybeCompactFontProvider(liveRenderer, manager, 99, 50)).toBe(false)
    expect(stale.deleted).toBe(false)
    expect(created).toHaveLength(1)
  })

  test('超阈值且死副本够厚才压实（回差可注入）', () => {
    const events: string[] = []
    const created: FakeProvider[] = []
    const manager = new FontManager()
    manager.ensureSharedProvider(makeCk(created, events))
    const stale = created[0]
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    manager.markLoaded('Noto Sans SC', 'Regular', new ArrayBuffer(200))
    manager.evictFont('Inter', 'Regular')
    // registered=300（dead=100 逐出残留），live=200；阈值 250 破、dead 100 > margin 50
    expect(manager.providerRegisteredBytes()).toBe(300)
    expect(manager.providerLiveRegistrationBytes()).toBe(200)

    expect(maybeCompactFontProvider(liveRenderer, manager, 250, 50)).toBe(true)

    expect(stale.deleted).toBe(true)
    expect(manager.providerRegisteredBytes()).toBe(200)
  })

  test('宿主清缓存失败回滚：旧 provider 保留、新建未发生，冷却期内拒压', () => {
    const events: string[] = []
    const created: FakeProvider[] = []
    const manager = new FontManager()
    manager.ensureSharedProvider(makeCk(created, events))
    const stale = created[0]
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    manager.markLoaded('Noto Sans SC', 'Regular', new ArrayBuffer(200))
    manager.evictFont('Inter', 'Regular')
    const bad = {
      isDestroyed: () => false,
      prepareProviderSwap: () => {
        throw new Error('heap corrupt')
      },
      acceptProvider: () => undefined
    }
    const unregister = manager.registerProviderHost(bad)

    try {
      expect(() => compactFontProvider(liveRenderer, manager)).toThrow('heap corrupt')
      // 旧 provider 未删、新 provider 未建——渲染可持旧 provider 降级继续
      expect(stale.deleted).toBe(false)
      expect(created).toHaveLength(1)
      // 冷却期：闸门全过也拒压（腐败堆上每次重试都是一遍大额分配）
      expect(maybeCompactFontProvider(liveRenderer, manager, 250, 50)).toBe(false)
      expect(stale.deleted).toBe(false)
    } finally {
      unregister()
      resetProviderCompactionCooldown()
    }

    // 冷却复位 + 故障宿主注销后可正常压实
    expect(maybeCompactFontProvider(liveRenderer, manager, 250, 50)).toBe(true)
    expect(stale.deleted).toBe(true)
  })

  test('渲染器已销毁或无共享 provider 时压实 no-op', () => {
    const events: string[] = []
    const created: FakeProvider[] = []
    const manager = new FontManager()
    expect(compactFontProvider(liveRenderer, manager)).toBe(false)

    manager.ensureSharedProvider(makeCk(created, events))
    expect(compactFontProvider({ isDestroyed: () => true }, manager)).toBe(false)
    expect(created[0].deleted).toBe(false)
    expect(created).toHaveLength(1)
  })

  test('destroyed 宿主被压实跳过（不清缓存也不接入）', () => {
    const events: string[] = []
    const created: FakeProvider[] = []
    const manager = new FontManager()
    manager.ensureSharedProvider(makeCk(created, events))
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    const dead = makeHost('dead', events)
    dead.state.destroyed = true
    manager.registerProviderHost(dead.host as never)

    expect(compactFontProvider(liveRenderer, manager)).toBe(true)

    expect(dead.state.prepared).toBe(0)
    expect(dead.state.provider).toBeNull()
  })

  test('默认阈值钉在 wasm32 4GB 天花板之下并留有余量', () => {
    const WASM32_LINEAR_MEMORY_CEILING = 4 * 1024 ** 3
    expect(PROVIDER_COMPACTION_THRESHOLD_BYTES).toBeLessThanOrEqual(
      WASM32_LINEAR_MEMORY_CEILING / 2
    )
    // 死副本闸必须显著小于阈值——否则阈值先到、闸永不生效
    expect(PROVIDER_COMPACTION_MIN_DEAD_BYTES).toBeLessThan(PROVIDER_COMPACTION_THRESHOLD_BYTES)
  })
})
