import { describe, expect, mock, test } from 'bun:test'

import type { Canvas, Image as CKImage, ImageInfo, Surface } from 'canvaskit-wasm'

import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import type { SkiaRenderer } from '#core/canvas/renderer'
import { renderSceneBacking } from '#core/canvas/renderer/retained-backing'
import { renderTile } from '#core/canvas/renderer/tiles'
import { renderShape } from '#core/canvas/scene'

function noopCanvas() {
  return {
    drawImageRectOptions: mock(),
    drawImageRect: mock(),
    save: mock(),
    restore: mock(),
    translate: mock(),
    scale: mock(),
    clear: mock(),
    drawPicture: mock(),
    drawColor: mock(),
    clipRect: mock()
  } as Canvas
}

function fakeImage() {
  return { delete: mock(), width: mock(() => 100), height: mock(() => 100) } as CKImage
}

function fakeSurface(snapshotReturn: CKImage | null = fakeImage()) {
  return {
    getCanvas: mock(() => noopCanvas()),
    flush: mock(),
    delete: mock(),
    makeImageSnapshot: mock(() => snapshotReturn)
  } as Surface & {
    flush: ReturnType<typeof mock>
    delete: ReturnType<typeof mock>
    makeImageSnapshot: ReturnType<typeof mock>
  }
}

function buildCkFixture() {
  return {
    AlphaType: { Premul: 'Premul' },
    ColorSpace: { SRGB: 'SRGB' },
    ColorType: { RGBA_8888: 'RGBA_8888' },
    Color4f: mock(() => [0, 0, 0, 0]),
    TRANSPARENT: { r: 0, g: 0, b: 0, a: 0 },
    LTRBRect: mock((left: number, top: number, right: number, bottom: number) => [
      left,
      top,
      right,
      bottom
    ]),
    FilterMode: { Linear: 'Linear', Nearest: 'Nearest' },
    MipmapMode: { None: 'None' },
    ClipOp: { Intersect: 'Intersect', Difference: 'Difference' },
    PictureRecorder: function PictureRecorder() {
      return {
        beginRecording: mock(() => noopCanvas()),
        finishRecordingAsPicture: mock(() => ({ delete: mock() })),
        delete: mock()
      }
    }
  }
}

function backingRenderer(snapshotFactory: () => CKImage | null) {
  const buildSurface = fakeSurface(snapshotFactory())
  buildSurface.makeImageSnapshot = mock(snapshotFactory)

  const renderer: Partial<SkiaRenderer> = {
    ck: buildCkFixture() as SkiaRenderer['ck'],
    surface: {
      makeSurface: mock((_info: ImageInfo) => buildSurface as Surface)
    } as SkiaRenderer['surface'],
    opacityPaint: { setAlphaf: mock() } as SkiaRenderer['opacityPaint'],
    panX: 0,
    panY: 0,
    zoom: 1,
    dpr: 1,
    viewportWidth: 100,
    viewportHeight: 100,
    pageColor: { r: 1, g: 1, b: 1 },
    pageId: 'page',
    navigationPhase: 'idle',
    sceneBacking: null,
    sceneBackingBuild: null,
    sceneBackingAllocationFailed: false,
    sceneBackingNeedsCrispRender: false,
    sceneBackingPreviewUntil: 0,
    sceneBackingAverageRecordMs: 40,
    sceneBackingAverageViewportIntervalMs: 80,
    scenePictureVersion: 0,
    scenePicturePositionPreviewVersion: 0,
    scenePicturePageId: null,
    scenePictureFontGeneration: 0,
    scenePicture: null,
    fontGeneration: 0,
    subtreePictureCache: new Map(),
    subtreePictureCachePageId: null,
    subtreePictureCacheSceneVersion: 0,
    subtreePictureCachePositionPreviewVersion: 0,
    subtreePictureCacheFontGeneration: 0,
    worldViewport: { x: 0, y: 0, w: 0, h: 0 },
    renderNode: mock()
  }
  return { renderer: renderer as SkiaRenderer, buildSurface }
}

function backingGraph(): SceneGraph {
  return {
    rootId: 'root',
    positionPreviewVersion: 0,
    getNode: mock((id: string) =>
      id === 'page' ? { id: 'page', type: 'CANVAS', childIds: [] } : null
    ),
    getAbsolutePosition: mock(() => ({ x: 0, y: 0 }))
  } as SceneGraph
}

function shapeNode(overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id: 'shape',
    type: 'RECTANGLE',
    visible: true,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    strokeCap: 'NONE',
    strokeJoin: 'MITER',
    vectorNetwork: null,
    effects: [
      {
        type: 'DROP_SHADOW',
        visible: true,
        color: { r: 0, g: 0, b: 0, a: 0.5 },
        offset: { x: 4, y: 6 },
        radius: 8,
        spread: 0
      }
    ],
    childIds: [],
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    blendMode: 'NORMAL',
    isMask: false,
    ...overrides
  } as SceneNode
}

function shapeRenderer(surfaceFactory: () => Surface | null) {
  const setCalls: string[] = []
  const renderer: Partial<SkiaRenderer> = {
    ck: buildCkFixture() as SkiaRenderer['ck'],
    surface: {
      makeSurface: mock((_info: ImageInfo) => surfaceFactory())
    } as SkiaRenderer['surface'],
    opacityPaint: { setAlphaf: mock() } as SkiaRenderer['opacityPaint'],
    effectRasterCache: {
      get: mock(() => null),
      delete: mock(),
      set: mock((id: string) => {
        setCalls.push(id)
        return true
      })
    } as SkiaRenderer['effectRasterCache'],
    effectOverflow: mock(() => 0),
    arrowCapOverflow: mock(() => 0),
    zoom: 1,
    dpr: 1,
    renderingSceneBacking: true,
    nodePictureCache: new Map(),
    nodePictureCacheGenerations: new Map(),
    nodePictureCacheDependencies: new Map(),
    fontGeneration: 0,
    renderShapeUncached: mock()
  }
  return { renderer: renderer as SkiaRenderer, setCalls }
}

function shapeGraph(node: SceneNode): SceneGraph {
  return {
    rootId: 'root',
    positionPreviewVersion: 0,
    getNode: mock((id: string) => (id === node.id ? node : null)),
    getAbsolutePosition: mock(() => ({ x: 0, y: 0 }))
  } as SceneGraph
}

describe('CanvasKit null return guards (B-3 UAF audit)', () => {
  describe('retained backing makeImageSnapshot returns null', () => {
    test('recordSceneBacking path: no install and no throw when snapshot is null', () => {
      const { renderer } = backingRenderer(() => null)
      const canvas = noopCanvas()

      expect(() => renderSceneBacking(renderer, canvas, backingGraph(), 1)).not.toThrow()
      expect(renderer.sceneBacking).toBeNull()
      expect(renderer.sceneBackingNeedsCrispRender).toBe(true)
      expect(canvas.drawImageRectOptions).not.toHaveBeenCalled()
    })

    test('recordSceneBacking path: completes install when snapshot returns a valid image', () => {
      const image = fakeImage()
      const { renderer, buildSurface } = backingRenderer(() => image)
      const canvas = noopCanvas()

      expect(() => renderSceneBacking(renderer, canvas, backingGraph(), 1)).not.toThrow()
      expect(buildSurface.makeImageSnapshot).toHaveBeenCalled()
      expect(renderer.sceneBackingNeedsCrispRender).toBe(false)
      expect(renderer.sceneBacking).not.toBeNull()
    })
  })

  describe('tile render makeImageSnapshot returns null', () => {
    test('renderTile returns null without throwing when snapshot is null', () => {
      const innerSurface = fakeSurface(null)
      const renderer = {
        ck: {
          AlphaType: { Premul: 'Premul' },
          ColorSpace: { SRGB: 'SRGB' },
          ColorType: { RGBA_8888: 'RGBA_8888' },
          Color4f: mock(() => [0, 0, 0, 0]),
          LTRBRect: mock((l: number, t: number, r: number, b: number) => [l, t, r, b]),
          ClipOp: { Intersect: 'Intersect', Difference: 'Difference' }
        },
        surface: { makeSurface: mock(() => innerSurface) },
        pageColor: { r: 1, g: 1, b: 1, a: 1 },
        boundEffectLayersToViewport: false
      } as SkiaRenderer
      const surfacePool = {
        acquire: mock(() => innerSurface),
        release: mock(() => undefined)
      }
      const tileIndex = { search: () => [], size: () => 0 }
      const pictureCache = { get: () => null }

      const result = (renderTile as (...args: unknown[]) => unknown)(
        renderer,
        { positionPreviewVersion: 0, getNode: () => null },
        tileIndex,
        { pageId: 'p', level: 1, x: 0, y: 0 },
        pictureCache,
        surfacePool
      )

      expect(result).toBeNull()
      expect(innerSurface.flush).toHaveBeenCalled()
    })
  })

  describe('shape render effect raster surface null', () => {
    test('falls through when r.surface.makeSurface returns null (no TypeError)', () => {
      const { renderer, setCalls } = shapeRenderer(() => null)
      const canvas = noopCanvas()
      const node = shapeNode()

      expect(() => renderShape(renderer, canvas, node, shapeGraph(node))).not.toThrow()
      expect(setCalls).toHaveLength(0)
      expect(canvas.drawPicture).toHaveBeenCalled()
    })

    test('falls through when inner makeImageSnapshot returns null (no TypeError)', () => {
      const innerSurface = fakeSurface(null)
      const { renderer, setCalls } = shapeRenderer(() => innerSurface as Surface)
      const canvas = noopCanvas()
      const node = shapeNode()

      expect(() => renderShape(renderer, canvas, node, shapeGraph(node))).not.toThrow()
      expect(innerSurface.makeImageSnapshot).toHaveBeenCalled()
      expect(setCalls).toHaveLength(0)
      expect(canvas.drawPicture).toHaveBeenCalled()
    })
  })
})
