import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_FONT_MEMORY_BUDGET,
  FontManager,
  FontMemoryLedger,
  fontFaceDemand,
  fontManager,
  fontResolver
} from '@open-pencil/core/text'

describe('FontMemoryLedger', () => {
  test('accounts bytes per key and reports totals', () => {
    const ledger = new FontMemoryLedger()
    ledger.set('A|Regular', 100)
    ledger.set('B|Regular', 200)
    expect(ledger.totalBytes()).toBe(300)
    expect(ledger.size()).toBe(2)

    ledger.set('A|Regular', 150)
    expect(ledger.totalBytes()).toBe(350)

    ledger.remove('B|Regular')
    expect(ledger.totalBytes()).toBe(150)
    expect(ledger.size()).toBe(1)
  })

  test('picks victims in least-recently-used order, honoring touch', () => {
    const ledger = new FontMemoryLedger()
    ledger.set('A|Regular', 100)
    ledger.set('B|Regular', 200)
    ledger.set('C|Regular', 300)
    ledger.touch('A|Regular')

    // 需释放 200：B 最久未用先逐（200 即达标），A 因 touch 续命，C 最新保留
    expect(ledger.lruVictims(200, new Set(), 1000)).toEqual(['B|Regular'])
    // 需释放 400：B + C（A 被 touch 过排在最后）
    expect(ledger.lruVictims(400, new Set(), 1000)).toEqual(['B|Regular', 'C|Regular'])
  })

  test('whale keys (single entry larger than budget) participate in LRU eviction', () => {
    // 钉扎 ①：鲸键（单键 > 预算）在超预算时入受害者清单且按 LRU 序
    const ledger = new FontMemoryLedger()
    ledger.set('A|Regular', 100)
    ledger.set('Huge|Regular', 5000)
    ledger.touch('Huge|Regular')

    // 需释放 100：A 最久未用先逐；Huge 留（仍未达标）
    expect(ledger.lruVictims(100, new Set(), 1000)).toEqual(['A|Regular'])
    // 需释放 5100：A + Huge 都被卷入（无单条目豁免）
    expect(ledger.lruVictims(5100, new Set(), 1000)).toEqual(['A|Regular', 'Huge|Regular'])

    // 钉扎 ②：exclude 键仍豁免
    expect(ledger.lruVictims(50, new Set(['A|Regular', 'Huge|Regular']), 1000)).toEqual([])

    // 钉扎 ③：逐出后 totalBytes 降到预算内（含鲸键场景）
    ledger.set('B|Regular', 200)
    expect(ledger.totalBytes()).toBe(5300)
    const victims = ledger.lruVictims(5300, new Set(), 1000)
    for (const victim of victims) ledger.remove(victim)
    expect(ledger.totalBytes()).toBe(0)

    // 诊断快照语义：鲸键不再保留，但调用方可在需要时观察当前超预算键
    ledger.set('Huge2|Regular', 4000)
    expect(ledger.overBudgetKeys(1000)).toEqual(['Huge2|Regular'])
  })
})

describe('FontManager memory governance (T40 S1)', () => {
  test('tracks bytes across primary replacement and supplemental demotion', () => {
    const manager = new FontManager()
    manager.markLoaded('MemA', 'Regular', new ArrayBuffer(100))
    expect(manager.fontMemoryStats().loadedBytes).toBe(100)

    // 同键换 primary：旧 buffer 降级为补充片，总字节 = 新 100 + 旧 150
    manager.markLoaded('MemA', 'Regular', new ArrayBuffer(150))
    expect(manager.fontMemoryStats().loadedBytes).toBe(250)
    expect(manager.fontMemoryStats().entries).toBe(1)
  })

  test('evicts least-recently-used faces when over budget', () => {
    const manager = new FontManager()
    const evicted: string[] = []
    manager.onFontEvicted((family, style) => evicted.push(`${family}|${style}`))

    manager.markLoaded('MemB', 'Regular', new ArrayBuffer(100))
    manager.markLoaded('MemC', 'Regular', new ArrayBuffer(200))
    manager.markLoaded('MemD', 'Regular', new ArrayBuffer(300))

    manager.setFontMemoryBudget(400)
    expect(evicted).toEqual(['MemB|Regular', 'MemC|Regular'])
    expect(manager.isStyleLoaded('MemB', 'Regular')).toBe(false)
    expect(manager.isStyleLoaded('MemC', 'Regular')).toBe(false)
    expect(manager.isStyleLoaded('MemD', 'Regular')).toBe(true)

    const stats = manager.fontMemoryStats()
    expect(stats.loadedBytes).toBe(300)
    expect(stats.evictions).toBe(2)
    expect(stats.budgetBytes).toBe(400)
  })

  test('touch via isStyleLoaded protects a face from eviction', () => {
    const manager = new FontManager()
    manager.markLoaded('MemE', 'Regular', new ArrayBuffer(100))
    manager.markLoaded('MemF', 'Regular', new ArrayBuffer(200))
    manager.markLoaded('MemG', 'Regular', new ArrayBuffer(300))

    expect(manager.isStyleLoaded('MemE', 'Regular')).toBe(true)
    manager.setFontMemoryBudget(400)
    expect(manager.isStyleLoaded('MemE', 'Regular')).toBe(true)
    expect(manager.isStyleLoaded('MemF', 'Regular')).toBe(false)
    expect(manager.isStyleLoaded('MemG', 'Regular')).toBe(true)
  })

  test('protect-via-exclude keeps a just-loaded whale key loaded while older siblings evict', () => {
    // setFontMemoryBudget 在无新键时无 exclude，老键按 LRU 正常卷入；
    // 鲸键豁免已移除——若超预算，无 exclude 守护的老鲸键也会被逐
    const manager = new FontManager()
    manager.markLoaded('MemH', 'Regular', new ArrayBuffer(100))
    manager.markLoaded('MemI', 'Regular', new ArrayBuffer(500))

    manager.setFontMemoryBudget(400)
    // 600 > 400，无 exclude：MemH (100) LRU 先逐，仍需 100 → MemI (500) 也被卷入
    expect(manager.isStyleLoaded('MemH', 'Regular')).toBe(false)
    expect(manager.isStyleLoaded('MemI', 'Regular')).toBe(false)
    expect(manager.fontMemoryStats().loadedBytes).toBe(0)
    expect(manager.fontMemoryStats().evictions).toBe(2)
  })

  test('markLoaded exclude protects the just-loaded whale key', () => {
    const manager = new FontManager()
    manager.setFontMemoryBudget(200)
    manager.markLoaded('MemJ', 'Regular', new ArrayBuffer(300))
    // 预算 200、新入账 300：markLoaded 经 enforce(exclude=本键) 守护，本键不被卷入，
    // 留作 overBudgetKeys 诊断快照（鲸键豁免已删，此处存活靠 exclude 而非豁免）
    expect(manager.isStyleLoaded('MemJ', 'Regular')).toBe(true)
    expect(manager.fontMemoryStats().overBudgetKeys).toEqual(['MemJ|Regular'])
  })

  test('manual evictFont releases the face and reports it', () => {
    const manager = new FontManager()
    manager.markLoaded('MemK', 'Bold', new ArrayBuffer(64))
    expect(manager.evictFont('MemK', 'Bold')).toBe(true)
    expect(manager.evictFont('MemK', 'Bold')).toBe(false)
    expect(manager.isStyleLoaded('MemK', 'Bold')).toBe(false)
    expect(manager.fontMemoryStats().loadedBytes).toBe(0)
  })

  test('default budget is the 512MB safety-airbag ceiling', () => {
    expect(DEFAULT_FONT_MEMORY_BUDGET).toBe(512 * 1024 * 1024)
    expect(new FontManager().fontMemoryStats().budgetBytes).toBe(DEFAULT_FONT_MEMORY_BUDGET)
  })
})

describe('eviction ↔ resolver integration (T40 S1)', () => {
  test('evicting a loaded face resets its resolver entry so it reloads on demand', async () => {
    const family = 'EvictIntegration'
    fontManager.markLoaded(family, 'Regular', new ArrayBuffer(64))

    const demand = fontFaceDemand(family, 'Regular')
    const settled = await fontResolver.demand(demand)
    expect(settled.state).toBe('loaded')

    expect(fontManager.evictFont(family, 'Regular')).toBe(true)
    expect(fontManager.isStyleLoaded(family, 'Regular')).toBe(false)
    expect(fontResolver.state(demand).state).toBe('idle')

    // 重新 demand 能再次走通 registered 候选之外的重载链。关停在线 provider，
    // 避免 remote 候选对测试环境发起真实网络请求（此处无源 → exhausted）。
    fontManager.setOnlineFontProviders({
      google: false,
      fontsource: false,
      bunny: false,
      fontshare: false
    })
    try {
      const reloaded = await fontResolver.demand(demand)
      expect(reloaded.state).toBe('exhausted')
    } finally {
      fontManager.setOnlineFontProviders({ google: true, fontsource: true })
      fontResolver.reset(demand)
    }
  })
})
