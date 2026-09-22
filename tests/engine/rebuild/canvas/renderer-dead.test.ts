/**
 * Renderer-dead latch + crash guard tests (A-3, see docs/202609221818-canvaskit-wasm-crash-save-close-deadlock.md §4).
 *
 * The latch is a module-level singleton, so every test that touches it must
 * call `resetRendererDead()` in `beforeEach`/`afterEach` to keep cases
 * hermetic. The DI seam (`withCrashGuard(render, capture)`) is what
 * production wires to `markRendererDead` — tests inject a fake capture to
 * assert call ordering without mutating the singleton.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  getRendererDeadState,
  isRendererDead,
  markRendererDead,
  resetRendererDead,
  subscribeRendererDeadState,
  withCrashGuard,
  type CrashCapture,
  type RendererCrash
} from '#core/canvas/renderer/dead'

describe('renderer-dead latch', () => {
  beforeEach(() => {
    resetRendererDead()
  })

  afterEach(() => {
    resetRendererDead()
  })

  test('starts cleared and reports not dead', () => {
    expect(isRendererDead()).toBe(false)
    expect(getRendererDeadState()).toEqual({ dead: false, lastCrash: null })
  })

  test('markRendererDead flips the latch and records the crash', () => {
    const crash: RendererCrash = {
      message: 'table index is out of bounds',
      name: 'RuntimeError',
      at: 1
    }
    markRendererDead(crash)

    expect(isRendererDead()).toBe(true)
    const snapshot = getRendererDeadState()
    expect(snapshot.dead).toBe(true)
    expect(snapshot.lastCrash?.message).toBe(crash.message)
    expect(snapshot.lastCrash?.name).toBe('RuntimeError')
  })

  test('markRendererDead is idempotent and updates lastCrash', () => {
    const first: RendererCrash = { message: 'first', name: 'RuntimeError', at: 1 }
    const second: RendererCrash = { message: 'second', name: 'RuntimeError', at: 2 }

    markRendererDead(first)
    markRendererDead(second)

    expect(getRendererDeadState().lastCrash?.message).toBe('second')
  })

  test('resetRendererDead only fires once on the true→false transition', () => {
    const events: boolean[] = []
    const off = subscribeRendererDeadState((snapshot) => events.push(snapshot.dead))

    markRendererDead({ message: 'x', name: 'RuntimeError', at: 0 })
    // mark while already dead: no emit
    markRendererDead({ message: 'y', name: 'RuntimeError', at: 1 })
    expect(events).toEqual([true])

    resetRendererDead()
    expect(events).toEqual([true, false])
    // reset while already alive: no emit
    resetRendererDead()
    expect(events).toEqual([true, false])

    off()
  })

  test('subscribe returns an unsubscribe handle', () => {
    const events: boolean[] = []
    const off = subscribeRendererDeadState((snapshot) => events.push(snapshot.dead))

    markRendererDead({ message: 'x', name: 'RuntimeError', at: 0 })
    off()
    resetRendererDead()

    expect(events).toEqual([true])
  })
})

describe('withCrashGuard', () => {
  beforeEach(() => {
    resetRendererDead()
  })

  afterEach(() => {
    resetRendererDead()
  })

  test('passes through when render does not throw', () => {
    let calls = 0
    const render = () => {
      calls++
    }
    const safe = withCrashGuard(render)
    safe()
    expect(calls).toBe(1)
    expect(isRendererDead()).toBe(false)
  })

  test('captures RuntimeError named errors and swallows them', () => {
    const captures: RendererCrash[] = []
    const capture: CrashCapture = (crash) => captures.push(crash)
    const render = () => {
      throw new WebAssembly.RuntimeError('table index is out of bounds')
    }
    const safe = withCrashGuard(render, capture)

    // Must not re-throw — the rAF callback needs to return cleanly.
    expect(() => safe()).not.toThrow()
    expect(captures).toHaveLength(1)
    expect(captures[0]?.name).toBe('RuntimeError')
    expect(captures[0]?.message).toContain('table index is out of bounds')
  })

  test('captures WASM errors surfaced as plain Error with OOB message', () => {
    const captures: RendererCrash[] = []
    const capture: CrashCapture = (crash) => captures.push(crash)
    // Some Emscripten builds wrap the WASM exception under a generic Error.
    const render = () => {
      throw new Error('memory access out of bounds')
    }
    const safe = withCrashGuard(render, capture)

    expect(() => safe()).not.toThrow()
    expect(captures).toHaveLength(1)
  })

  test('rethrows non-WASM errors unchanged', () => {
    const captures: RendererCrash[] = []
    const capture: CrashCapture = (crash) => captures.push(crash)
    const boom = new Error('network failed')
    const render = () => {
      throw boom
    }
    const safe = withCrashGuard(render, capture)

    expect(() => safe()).toThrow(boom)
    expect(captures).toHaveLength(0)
  })

  test('default capture flips the production latch', () => {
    // No capture argument — must wire to markRendererDead by default.
    const render = () => {
      throw new WebAssembly.RuntimeError('table index is out of bounds')
    }
    const safe = withCrashGuard(render)

    expect(() => safe()).not.toThrow()
    expect(isRendererDead()).toBe(true)
  })

  test('non-Error throws are not captured (defensive)', () => {
    const captures: RendererCrash[] = []
    const capture: CrashCapture = (crash) => captures.push(crash)
    const render = () => {
      throw 'string thrown'
    }
    const safe = withCrashGuard(render, capture)

    expect(() => safe()).toThrow()
    expect(captures).toHaveLength(0)
  })

  test('forwards arguments to the wrapped render function', () => {
    const seen: number[] = []
    const render = (a: number, b: number) => {
      seen.push(a, b)
    }
    const safe = withCrashGuard<typeof render>(render)
    safe(7, 11)
    expect(seen).toEqual([7, 11])
  })
})
