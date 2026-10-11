import { useElementSize } from '@vueuse/core'
import type { CanvasKit } from 'canvaskit-wasm'
import { onScopeDispose, ref } from 'vue'
import type { Ref } from 'vue'

import { getRendererDeadState, subscribeRendererDeadState } from '@open-pencil/core/canvas'
import type { Editor } from '@open-pencil/core/editor'

import {
  createCanvasSurfaceManager,
  useCanvasSurfaceLifecycle
} from '#vue/canvas/surface/lifecycle'
import { createCanvasHitTests, createRulerVisibility } from '#vue/canvas/surface/overlays'
import { useShaderPlayback } from '#vue/canvas/surface/shader-playback'
import type { UseCanvasOptions } from '#vue/canvas/surface/types'

export type { UseCanvasOptions } from '#vue/canvas/surface/types'

/**
 * Connects an OpenPencil editor to a real canvas element using CanvasKit.
 *
 * This composable owns renderer creation, surface recreation on resize,
 * render scheduling, and renderer-backed hit testing helpers used by higher-
 * level canvas interaction code.
 */
export function useCanvas(
  canvasRef: Ref<HTMLCanvasElement | null>,
  editor: Editor,
  options?: UseCanvasOptions
) {
  let ck: CanvasKit | null = null
  const lifecycle: { destroyed: boolean } = { destroyed: false }
  const isDestroyed = () => lifecycle.destroyed
  const shouldShowRulers = createRulerVisibility(options)

  const surface = createCanvasSurfaceManager({
    editor,
    canvasRef,
    options,
    getCanvasKit: () => ck,
    isDestroyed,
    shouldShowRulers
  })

  useCanvasSurfaceLifecycle({
    canvasRef,
    surface,
    lifecycle,
    getCanvasKitValue: () => ck,
    setCanvasKit: (value) => {
      ck = value
    },
    onReady: options?.onReady
  })

  // The scene surface plays shaders in preview; an overlay surface draws none.
  if (options?.layer !== 'overlays') {
    // The view's size in CSS pixels, which the editor's pan and zoom map the page onto.
    const viewport = useElementSize(canvasRef)
    useShaderPlayback({
      editor,
      getRenderer: surface.getRenderer,
      getView: () => options?.getRenderState?.() ?? editor.state,
      getViewport: () => ({ width: viewport.width.value, height: viewport.height.value }),
      markDirty: surface.markDirty
    })
  }

  const { hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle, hitTestIssueMarker } =
    createCanvasHitTests(editor, surface.getRenderer)

  // Reactive mirror of the core renderer-dead latch. The latch is a
  // plain module-level signal; this ref is the Vue surface that the
  // banner and other consumers can read in templates.
  const rendererDead: Ref<boolean> = ref(getRendererDeadState().dead)
  const unsubscribeDead = subscribeRendererDeadState((snapshot) => {
    rendererDead.value = snapshot.dead
  })
  onScopeDispose(unsubscribeDead)

  return {
    render: surface.markDirty,
    renderNow: surface.renderNow,
    hitTestSectionTitle,
    hitTestComponentLabel,
    hitTestFrameTitle,
    hitTestIssueMarker,
    rendererDead
  }
}
