import { beforeAll, describe, expect, test } from 'bun:test'

import { renderNodesToImage, SceneGraph, SkiaRenderer } from '@open-pencil/core'
import { initCanvasKit, MAX_RASTER_BYTES, RasterBudgetExceededError } from '@open-pencil/core/io'

import { expectDefined } from '#tests/helpers/assert'

let ck: Awaited<ReturnType<typeof initCanvasKit>>

beforeAll(async () => {
  ck = await initCanvasKit()
})

describe('raster export byte budget', () => {
  test('throws RasterBudgetExceededError when content × scale × supersample exceeds the budget', () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    // 20000 × 20000 px at scale=1 with default supersample=2 would allocate
    // 40000 × 40000 × 4 = 6.4 GB — well above the 512 MB cap. Even with the
    // halved renderScale the projected surface stays over the cap.
    graph.createNode('RECTANGLE', page.id, {
      x: 0,
      y: 0,
      width: 20000,
      height: 20000,
      fills: [
        {
          type: 'SOLID',
          color: { r: 1, g: 0, b: 0, a: 1 },
          opacity: 1,
          visible: true
        }
      ]
    })

    const surface = expectDefined(ck.MakeSurface(1, 1), 'surface')
    const renderer = new SkiaRenderer(ck, surface)
    try {
      let caught: unknown = null
      try {
        renderNodesToImage(ck, renderer, graph, page.id, page.childIds, {
          scale: 1,
          format: 'PNG'
        })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(RasterBudgetExceededError)
      const budgetError = caught as RasterBudgetExceededError
      expect(budgetError.contentW).toBe(20000)
      expect(budgetError.contentH).toBe(20000)
      expect(budgetError.scale).toBe(1)
      expect(budgetError.projectedBytes).toBeGreaterThan(MAX_RASTER_BYTES)
    } finally {
      surface.delete()
    }
  })

  test('normal-size exports pass through unchanged (budget invisible at common scales)', () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    graph.createNode('RECTANGLE', page.id, {
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      fills: [
        {
          type: 'SOLID',
          color: { r: 1, g: 0, b: 0, a: 1 },
          opacity: 1,
          visible: true
        }
      ]
    })

    const surface = expectDefined(ck.MakeSurface(1, 1), 'surface')
    const renderer = new SkiaRenderer(ck, surface)
    try {
      const png = expectDefined(
        renderNodesToImage(ck, renderer, graph, page.id, page.childIds, {
          scale: 1,
          format: 'PNG'
        }),
        'png'
      )
      expect(png.byteLength).toBeGreaterThan(0)
    } finally {
      surface.delete()
    }
  })
})
