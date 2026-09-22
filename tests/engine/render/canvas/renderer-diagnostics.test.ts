import { afterEach, describe, expect, test } from 'bun:test'

import type { SkiaRenderer } from '#core/canvas/renderer'
import {
  getRendererDeadState,
  markRendererDead,
  resetRendererDead
} from '#core/canvas/renderer/dead'
import {
  captureRendererDiagnostics,
  getRecentRasterExports,
  recordRasterExportSample,
  type RasterExportSample
} from '#core/canvas/renderer/diagnostics'

function fakeRenderer(): SkiaRenderer {
  return {
    imageCache: { size: 3, weight: 1024 },
    effectRasterCache: { size: 2, weight: 2048 },
    nodePictureCache: new Map([['node-a', null]]),
    subtreePictureCache: new Map(),
    scenePictureVersion: 7,
    fontGeneration: 3,
    zoom: 2,
    dpr: 1.5,
    viewportWidth: 800,
    viewportHeight: 600,
    worldViewport: { x: 1, y: 2, w: 300, h: 200 }
  } as SkiaRenderer
}

function sample(index: number, ok = true) {
  return {
    at: 1000 + index,
    width: 10,
    height: 20,
    scale: 2,
    bytes: 800 + index,
    ms: 5,
    ok
  }
}

describe('renderer crash diagnostics (B-5/B-7)', () => {
  afterEach(() => {
    resetRendererDead()
  })

  test('export ring buffer keeps the most recent 8 samples in order', () => {
    const before = getRecentRasterExports().length
    for (let i = 0; i < 12; i++) recordRasterExportSample(sample(i))

    const exports = getRecentRasterExports()
    expect(exports.length).toBeLessThanOrEqual(8)
    const tail = exports.slice(-8)
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i].at).toBeGreaterThan(tail[i - 1].at)
    }
    expect(exports.length).toBeGreaterThanOrEqual(before)
  })

  test('capture with null renderer returns a zeroed context without throwing', () => {
    const context = captureRendererDiagnostics(null)
    expect(context.imageCache).toEqual({ entries: 0, bytes: null })
    expect(context.scenePictureVersion).toBe(0)
    expect(context.worldViewport).toBeNull()
    expect(Array.isArray(context.recentExports)).toBe(true)
  })

  test('capture maps renderer cache watermarks and scene versions', () => {
    recordRasterExportSample(sample(42))
    const context = captureRendererDiagnostics(fakeRenderer())

    expect(context.imageCache).toEqual({ entries: 3, bytes: 1024 })
    expect(context.effectRasterCache).toEqual({ entries: 2, bytes: 2048 })
    expect(context.nodePictureCache).toEqual({ entries: 1, bytes: null })
    expect(context.subtreePictureCache).toEqual({ entries: 0, bytes: null })
    expect(context.scenePictureVersion).toBe(7)
    expect(context.fontGeneration).toBe(3)
    expect(context.zoom).toBe(2)
    expect(context.dpr).toBe(1.5)
    expect(context.viewport).toEqual({ width: 800, height: 600 })
    expect(context.worldViewport).toEqual({ x: 1, y: 2, w: 300, h: 200 })
    expect(context.recentExports.some((entry: RasterExportSample) => entry.at === 1042)).toBe(true)
  })

  test('capture degrades to zeroed context when a field getter throws', () => {
    const hostile = Object.defineProperty({}, 'imageCache', {
      get() {
        throw new Error('getter boom')
      }
    }) as SkiaRenderer

    const context = captureRendererDiagnostics(hostile)
    expect(context.imageCache).toEqual({ entries: 0, bytes: null })
    expect(context.scenePictureVersion).toBe(0)
  })

  test('dead latch carries the crash context through the snapshot', () => {
    const context = captureRendererDiagnostics(fakeRenderer())
    markRendererDead({ message: 'out of bounds', name: 'RuntimeError', at: 1, context })

    const snapshot = getRendererDeadState()
    expect(snapshot.dead).toBe(true)
    expect(snapshot.lastCrash?.context?.scenePictureVersion).toBe(7)
    expect(snapshot.lastCrash?.context?.imageCache.bytes).toBe(1024)
  })
})
