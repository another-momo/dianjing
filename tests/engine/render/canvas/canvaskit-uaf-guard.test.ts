import { describe, expect, test } from 'bun:test'

import type { CanvasKit } from 'canvaskit-wasm'

import { wrapCanvasKitUseAfterDeleteGuard } from '#core/canvaskit'

type FakeEmbind = {
  delete: () => void
  isDeleted: () => boolean
  [key: string]: unknown
}

function fakeEmbind(methods: Record<string, unknown> = {}): FakeEmbind {
  let deleted = false
  return {
    ...methods,
    delete: () => {
      deleted = true
    },
    isDeleted: () => deleted
  }
}

function fakeCk(): CanvasKit {
  return {
    MakeSurface: () =>
      fakeEmbind({
        width: () => 100,
        getCanvas: () => fakeEmbind({ drawRect: () => undefined }),
        makeImageSnapshot: () => fakeEmbind({ width: () => 64 })
      }),
    TRANSPARENT: { r: 0, g: 0, b: 0, a: 0 }
  } as never
}

describe('CanvasKit use-after-delete guard (B-6)', () => {
  test('pre-delete method calls pass through and return real values', () => {
    const surface = wrapCanvasKitUseAfterDeleteGuard(fakeCk()).MakeSurface()
    expect(surface?.width()).toBe(100)
    expect(surface?.isDeleted()).toBe(false)
  })

  test('method call after delete throws a labeled error at the call site', () => {
    const surface = wrapCanvasKitUseAfterDeleteGuard(fakeCk()).MakeSurface()
    surface?.delete()
    expect(surface?.isDeleted()).toBe(true)
    expect(() => surface?.getCanvas()).toThrow(/ck\.MakeSurface\(\)\.getCanvas/)
    expect(() => surface?.width()).toThrow(/use-after-delete/)
  })

  test('recursively wraps embind objects returned from embind methods', () => {
    const surface = wrapCanvasKitUseAfterDeleteGuard(fakeCk()).MakeSurface()
    const image = surface?.makeImageSnapshot()
    image?.delete()
    expect(() => image?.width()).toThrow(/makeImageSnapshot\(\)\.width/)
    // 同源对象未 delete 时不受影响
    expect(surface?.isDeleted()).toBe(false)
  })

  test('non-embind values pass through unwrapped (identity preserved)', () => {
    const ck = fakeCk()
    const wrapped = wrapCanvasKitUseAfterDeleteGuard(ck)
    expect(wrapped.TRANSPARENT).toBe(ck.TRANSPARENT)
  })

  test('objects with delete but without isDeleted are not treated as embind', () => {
    const plain = { delete: () => undefined, value: 1 }
    const ck = { MakeImageFromEncoded: () => plain }
    const wrapped = wrapCanvasKitUseAfterDeleteGuard(ck as never)
    const result = wrapped.MakeImageFromEncoded(new Uint8Array(0))
    expect(result).toBe(plain)
  })
})
