/**
 * Renderer-dead signal: a single boolean latch per Editor/canvas instance.
 *
 * The CanvasKit WASM heap can be corrupted by OOM peaks, UAF, or AI image
 * generation runaways (docs/202609221818-canvaskit-wasm-crash-save-close-deadlock.md
 * §2.3). Once corrupted, every subsequent canvas call throws `RuntimeError`
 * from the WASM boundary (`table index is out of bounds`,
 * `memory access out of bounds`). The render loop schedules a new frame
 * every animation tick, so the same throw repeats forever — the canvas
 * silently freezes and `look` returns nothing.
 *
 * This module exposes the latch plus a DI seam (`withCrashGuard`) so the
 * render-loop and look tool can fail fast instead of looping on a dead
 * renderer. Production wires `markRendererDead` as the default capture
 * (single global latch); tests inject a per-test capture to assert
 * behavior without touching the singleton.
 *
 * The signal is intentionally framework-free (no Vue, no nanostores) so
 * `core` stays host-agnostic and `look` (which lives in core) can read
 * the same latch the render-loop writes.
 */

import type { RendererCrashContext } from './diagnostics'

export interface RendererCrash {
  /** Message from the captured RuntimeError. */
  message: string
  /** Original error name (e.g. `RuntimeError`). */
  name: string
  /** Time the latch was flipped. */
  at: number
  /**
   * B-7 crash forensics: cache watermarks / recent raster exports / scene
   * versions captured at the moment the latch flipped. Absent in tests that
   * flip the latch without a live renderer.
   */
  context?: RendererCrashContext
}

export type CrashCapture = (crash: RendererCrash) => void

export type RendererDeadListener = (snapshot: RendererDeadSnapshot) => void

export interface RendererDeadSnapshot {
  dead: boolean
  lastCrash: RendererCrash | null
}

let dead = false
let lastCrash: RendererCrash | null = null
const listeners = new Set<RendererDeadListener>()

function emit(): void {
  const snapshot: RendererDeadSnapshot = { dead, lastCrash }
  for (const listener of listeners) listener(snapshot)
}

/**
 * Returns the current snapshot synchronously. Cheap — no allocation
 * unless listeners are subscribed.
 */
export function getRendererDeadState(): RendererDeadSnapshot {
  return { dead, lastCrash }
}

/** Read-only convenience: is the renderer dead right now? */
export function isRendererDead(): boolean {
  return dead
}

/**
 * Flip the latch. Idempotent: subsequent calls update `lastCrash` only
 * if a newer crash arrives, but the dead flag never resets. Reset is
 * a separate operation owned by the editor on a fresh mount.
 */
export function markRendererDead(crash: RendererCrash): void {
  const wasDead = dead
  dead = true
  lastCrash = crash
  if (!wasDead) emit()
}

/**
 * Clear the latch. Called when a fresh renderer is mounted (e.g. page
 * change creates a new surface). Listeners are notified only on a
 * true→false transition.
 */
export function resetRendererDead(): void {
  if (!dead) return
  dead = false
  lastCrash = null
  emit()
}

/** Subscribe to latch transitions. Returns an unsubscribe function. */
export function subscribeRendererDeadState(listener: RendererDeadListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * RuntimeError signature from CanvasKit WASM: the only error class the
 * JS layer ever sees come out of a dead WASM heap. We match on the name
 * (not the message) because messages are Emscripten-formatted and
 * locale-unstable; the name is set by the WASM runtime.
 */
function isWasmRuntimeError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false
  if (err.name === 'RuntimeError') return true
  // Defensive: some Emscripten builds surface the WASM exception under
  // a generic Error with the offending substring in the message.
  const msg = err.message
  return (
    msg.includes('table index is out of bounds') ||
    msg.includes('memory access out of bounds') ||
    msg.includes('out of bounds')
  )
}

/**
 * Wrap a render function so WASM runtime errors flip the latch and
 * are swallowed. The render function is called once per frame; the
 * capture is invoked exactly once per new crash.
 *
 * The default capture calls `markRendererDead` (the production latch).
 * Tests inject a fake to assert call ordering without mutating the
 * singleton.
 */
export function withCrashGuard<R extends (...args: never[]) => unknown>(
  render: R,
  capture: CrashCapture = markRendererDead
): (...args: Parameters<R>) => void {
  return (...args: Parameters<R>) => {
    try {
      render(...args)
    } catch (err) {
      if (!isWasmRuntimeError(err)) throw err
      capture({
        message: err.message,
        name: err.name,
        at: Date.now()
      })
    }
  }
}
