import { describe, expect, mock, test } from 'bun:test'

import { ImageCache, MAX_IMAGE_CACHE_BYTES } from '#core/canvas/renderer/image-cache'

interface FakeImage {
  width: () => number
  height: () => number
  delete: ReturnType<typeof mock>
}

function fakeImage(width: number, height: number): FakeImage {
  return {
    width: () => width,
    height: () => height,
    delete: mock(() => {})
  }
}

function imageBytes(width: number, height: number): number {
  // Same formula as ImageCache#imageWeight: ceil(w * h * 4 * 4 / 3).
  return Math.ceil((width * height * 4 * 4) / 3)
}

describe('image cache', () => {
  test('exposes the 512 MiB byte budget as the default cap', () => {
    expect(MAX_IMAGE_CACHE_BYTES).toBe(512 * 1024 * 1024)
  })

  test('accounts weight as the ceil of width × height × 4 × 4/3', () => {
    const cache = new ImageCache(10 * 1024 * 1024)
    const a = fakeImage(100, 100)
    const b = fakeImage(256, 64)

    cache.set('a', a as never)
    cache.set('b', b as never)

    expect(cache.weight).toBe(imageBytes(100, 100) + imageBytes(256, 64))
    expect(cache.size).toBe(2)
  })

  test('evicts the least-recently-used entry past the byte budget and disposes its image', () => {
    // Two 40×10 entries weigh 2134 each (ceil(40·10·16/3)).
    // Budget 5000 fits both but not a third.
    const cache = new ImageCache(5000)
    const first = fakeImage(40, 10)
    const second = fakeImage(40, 10)
    const third = fakeImage(40, 10)

    cache.set('first', first as never)
    cache.set('second', second as never)
    // Mark 'first' as most-recently used so eviction targets 'second'.
    expect(cache.get('first')).toBe(first as never)

    cache.set('third', third as never)

    expect(cache.has('second')).toBe(false)
    expect(second.delete).toHaveBeenCalledTimes(1)
    expect(cache.has('first')).toBe(true)
    expect(cache.has('third')).toBe(true)
    expect(first.delete).not.toHaveBeenCalled()
    expect(third.delete).not.toHaveBeenCalled()
  })

  test('rejects a single oversized entry without disposing it (caller retains ownership)', () => {
    // 100×100 weighs ~53334 bytes; budget 1000 forces rejection.
    const cache = new ImageCache(1000)
    const big = fakeImage(100, 100)

    const retained = cache.set('oversize', big as never)

    expect(retained).toBe(false)
    expect(cache.has('oversize')).toBe(false)
    expect(cache.size).toBe(0)
    // Caller owns it now and must delete (mirrors fills.ts rejection path).
    ;(big as unknown as { delete: () => void }).delete()
    expect(big.delete).toHaveBeenCalledTimes(1)
  })

  test('clear disposes every resident image', () => {
    const cache = new ImageCache(1024 * 1024)
    const a = fakeImage(64, 64)
    const b = fakeImage(32, 128)
    const c = fakeImage(16, 16)

    cache.set('a', a as never)
    cache.set('b', b as never)
    cache.set('c', c as never)

    cache.clear()

    expect(a.delete).toHaveBeenCalledTimes(1)
    expect(b.delete).toHaveBeenCalledTimes(1)
    expect(c.delete).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(0)
    expect(cache.weight).toBe(0)
  })

  test('disposes the previous image when replaced on the same key', () => {
    const cache = new ImageCache(5000)
    const initial = fakeImage(40, 10)
    const replacement = fakeImage(40, 10)

    cache.set('k', initial as never)
    cache.set('k', replacement as never)

    expect(initial.delete).toHaveBeenCalledTimes(1)
    expect(replacement.delete).not.toHaveBeenCalled()
  })

  test('evicts the oldest entry to make room and disposes its image', () => {
    // Budget 4269 fits two 40×10 entries (2134 each) exactly but not a third.
    const cache = new ImageCache(4269)
    const a = fakeImage(40, 10)
    const b = fakeImage(40, 10)
    const c = fakeImage(40, 10)

    cache.set('a', a as never)
    cache.set('b', b as never)
    cache.set('c', c as never)

    // 'a' is the oldest of three sizes; first to go (LRU since first stored).
    expect(a.delete).toHaveBeenCalledTimes(1)
    expect(b.delete).not.toHaveBeenCalled()
    expect(c.delete).not.toHaveBeenCalled()
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
  })
})
