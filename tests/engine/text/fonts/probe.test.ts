import { describe, expect, test } from 'bun:test'

// 走源码别名而非包桶：fontProbeStats 是本批新增 API，包桶解析到 dist 旧类型会误报
import { FontManager } from '#core/text/fonts'

describe('fontProbeStats（内存水表）', () => {
  test('空管理器返回全零', () => {
    const stats = new FontManager().fontProbeStats()
    expect(stats.loadedFamilies).toBe(0)
    expect(stats.loadedDataBytes).toBe(0)
    expect(stats.providers).toBe(0)
    expect(stats.registeredPieces).toBe(0)
    expect(stats.registeredBytes).toBe(0)
  })

  test('markLoaded 计入 JS 侧缓存；无 provider 时 WASM 侧注册为零', () => {
    const manager = new FontManager()
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    manager.markLoaded('Noto Sans SC', 'Regular', new ArrayBuffer(200))
    const stats = manager.fontProbeStats()
    expect(stats.loadedFamilies).toBe(2)
    expect(stats.loadedDataBytes).toBe(300)
    expect(stats.registeredPieces).toBe(0)
  })

  test('provider 注册按 buffer 去重并计数', () => {
    const manager = new FontManager()
    manager.attachProvider(null as never, { registerFont: () => true } as never)
    const inter = new ArrayBuffer(100)
    manager.markLoaded('Inter', 'Regular', inter)
    manager.markLoaded('Inter', 'Regular', inter)
    manager.markLoaded('Emoji', 'Regular', new ArrayBuffer(50))
    const stats = manager.fontProbeStats()
    expect(stats.providers).toBe(1)
    expect(stats.registeredFamilies).toBe(2)
    expect(stats.registeredPieces).toBe(2)
    expect(stats.registeredBytes).toBe(150)
    expect(stats.registrationGeneration).toBeGreaterThan(0)
  })

  test('eviction 释放 JS 侧但不卸 WASM 侧注册（泄漏语义钉扎）', () => {
    const manager = new FontManager()
    manager.attachProvider(null as never, { registerFont: () => true } as never)
    manager.setFontMemoryBudget(150)
    manager.markLoaded('Inter', 'Regular', new ArrayBuffer(100))
    manager.markLoaded('Noto Sans SC', 'Regular', new ArrayBuffer(100))
    const stats = manager.fontProbeStats()
    // JS 侧：预算 150B 下旧条目被逐出，只剩当前键
    expect(stats.evictions).toBeGreaterThan(0)
    expect(stats.loadedFamilies).toBe(1)
    // WASM 侧：注册永不卸载——崩溃归因要盯的单调增长位
    expect(stats.registeredPieces).toBe(2)
    expect(stats.registeredBytes).toBe(200)
  })
})
