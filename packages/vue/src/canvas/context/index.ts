import { type InjectionKey, type Ref, inject, provide } from 'vue'

import type { SceneNode } from '@open-pencil/scene-graph'

export interface CanvasContext {
  canvasRef: Ref<HTMLCanvasElement | null>
  ready: Ref<boolean>
  renderNow: () => void
  hitTestSectionTitle: (cx: number, cy: number) => SceneNode | null
  hitTestComponentLabel: (cx: number, cy: number) => SceneNode | null
  hitTestFrameTitle: (cx: number, cy: number) => SceneNode | null
  /**
   * Flipped true when the WASM renderer has crashed and been silenced
   * (docs/202609221818-canvaskit-wasm-crash-save-close-deadlock.md §4 A-3).
   * UI surfaces a persistent prompt; tool calls fail fast while this
   * is true. Only resets on a fresh editor mount.
   */
  rendererDead: Ref<boolean>
}

export const CANVAS_KEY: InjectionKey<CanvasContext> = Symbol('canvas')

export function provideCanvas(ctx: CanvasContext) {
  provide(CANVAS_KEY, ctx)
}

export function useCanvasContext(): CanvasContext {
  const ctx = inject(CANVAS_KEY)
  if (!ctx) throw new Error('[open-pencil] useCanvasContext() called outside <CanvasRoot>')
  return ctx
}
