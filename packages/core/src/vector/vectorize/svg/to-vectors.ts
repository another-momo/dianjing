/**
 * Maps vendor SVG into scene-graph vector networks.
 *
 * Raster vectorizers often return paths in viewBox user units while width/height
 * reflect the input pixel size. Scale path data from the SVG coordinate space
 * (viewBox, else width/height) into the target node bounds before parsing.
 */
import svgpath from 'svgpath'

import type { Fill, Stroke, VectorNetwork, WindingRule } from '@open-pencil/scene-graph'
import { parseColor } from '@open-pencil/scene-graph/color'
import { computeBounds } from '@open-pencil/scene-graph/geometry'
import type { Mat3 } from '@open-pencil/scene-graph/matrix'
import { parseSVGPath } from '@open-pencil/scene-graph/parse-path'
import type { Rect, Size, Vector } from '@open-pencil/scene-graph/primitives'

import { createPathStroke } from '#core/icons/path-style'
import { extractSVGContent, type SVGImageElementInfo } from '#core/icons/svg'
import type { IconPathInfo, SVGElementLayer, SVGTextPiece, SVGTextRun } from '#core/icons/types'
import { parseSVGSize, parseSVGViewBox } from '#core/io/formats/svg/metadata'
import { computeAccurateBounds } from '#core/vector/curve-math'

import { parseSVGGradients, resolveGradientFill } from './gradients'
import {
  type SVGViewportMapping,
  applySVGTransformToPath,
  mapSVGPathToViewport,
  resolveSVGViewportMapping
} from './transform'

function parseSVGCoordinateSpace(svg: string): Rect {
  const viewBox = parseSVGViewBox(svg)
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) return viewBox
  const size = parseSVGSize(svg)
  return { x: 0, y: 0, width: size.width, height: size.height }
}

function unionPathBounds(paths: VectorizedPath[]): Rect {
  const rects = paths
    .map((path) => computeAccurateBounds(path.vectorNetwork))
    .filter((bounds) => bounds.width > 0 && bounds.height > 0)
  return computeBounds(rects)
}

function resolveFill(path: IconPathInfo, defaultColor: string): Fill[] {
  if (path.fill && path.fill !== 'none') {
    const color = path.fill === 'currentColor' ? parseColor(defaultColor) : parseColor(path.fill)
    return [{ type: 'SOLID', color, opacity: path.fillOpacity, visible: true }]
  }
  if (path.fill === null && !path.stroke) {
    return [{ type: 'SOLID', color: parseColor(defaultColor), opacity: 1, visible: true }]
  }
  return []
}

function resolveStrokes(path: IconPathInfo, defaultColor: string, strokeScale = 1): Stroke[] {
  if (!path.stroke || path.stroke === 'none') return []
  const color = path.stroke === 'currentColor' ? parseColor(defaultColor) : parseColor(path.stroke)
  const stroke = createPathStroke(
    color,
    path.strokeWidth * strokeScale,
    path.strokeCap,
    path.strokeJoin
  )
  return [{ ...stroke, opacity: path.strokeOpacity }]
}

export interface VectorizedClip {
  /** The `<clipPath>` element's `id`. */
  id: string
  /** One network per clip shape. */
  shapes: VectorNetwork[]
}

export interface VectorizedPath {
  vectorNetwork: VectorNetwork
  fills: Fill[]
  strokes: Stroke[]
  /** The clip regions around the path, ordered like `IconPathInfo.clipPaths`. */
  clips?: VectorizedClip[]
  elements: SVGElementLayer[]
}

/** SVG text, placed by the matrix from its element's coordinates into the target bounds. */
export type VectorizedTextPiece = Omit<SVGTextPiece, 'runs'> & {
  runs: Array<SVGTextRun & { fills: Fill[] }>
}

export interface VectorizedText {
  pieces: VectorizedTextPiece[]
  matrix: Mat3
  clips?: VectorizedClip[]
  elements: SVGElementLayer[]
  /** How many paths come before the text in drawing order. */
  pathIndex: number
}

/** <image> 元素映射到目标坐标系的矩形（import 侧落成 IMAGE-fill 矩形；外链 href 由消费方跳过） */
export interface VectorizedImage {
  x: number
  y: number
  width: number
  height: number
  href: string
}

export interface SVGVectorizeResult {
  paths: VectorizedPath[]
  texts: VectorizedText[]
  images: VectorizedImage[]
  /** Tight bounds of path geometry in the target coordinate space. */
  contentBounds: Rect
}

function mapImageElement(
  image: SVGImageElementInfo,
  viewport: SVGViewportMapping
): VectorizedImage {
  const m = transformMatrix(image.transform, viewport)
  const map = (x: number, y: number) => ({
    x: m[0] * x + m[1] * y + m[2],
    y: m[3] * x + m[4] * y + m[5]
  })
  const topLeft = map(image.x, image.y)
  const bottomRight = map(image.x + image.width, image.y + image.height)
  return {
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
    href: image.href
  }
}

export function svgToVectorPaths(
  svgText: string,
  bounds: Size,
  options?: { defaultColor?: string; preserveAspectRatio?: boolean }
): SVGVectorizeResult | null {
  const { paths, texts, images } = extractSVGContent(svgText)
  if (paths.length === 0 && texts.length === 0 && images.length === 0) return null

  const space = parseSVGCoordinateSpace(svgText)
  if (space.width <= 0 || space.height <= 0) return null

  const defaultColor = options?.defaultColor ?? '#000000'
  const gradients = parseSVGGradients(svgText)
  const viewport = resolveSVGViewportMapping(
    svgText,
    space,
    bounds,
    options?.preserveAspectRatio ?? false
  )
  const strokeScale = Math.min(viewport.scaleX, viewport.scaleY)

  const vectorized: VectorizedPath[] = []
  const clipCache: ClipCache = new WeakMap()
  for (const path of paths) {
    const fillRule: WindingRule = path.fillRule
    const transform = path.transform ?? null
    const pathData = applySVGTransformToPath(path.d, transform)
    const scaledD = mapSVGPathToViewport(pathData, viewport)
    const solidFills = resolveFill(path, defaultColor)
    const strokes = resolveStrokes(path, defaultColor, strokeScale)
    // A stroke would also trace the closing edge of an open subpath in the fill region.
    const network = parseSVGPath(scaledD, fillRule, {
      includeOpenRegions: solidFills.length > 0 && strokes.length === 0
    })
    const pathBounds = computeAccurateBounds(network)
    const gradientFill =
      gradients.size > 0
        ? resolveGradientFill(
            path.fill,
            gradients,
            transform,
            viewport,
            computeAccurateBounds(network)
          )
        : null
    const clips = path.clipPaths && vectorizeClips(path.clipPaths, viewport, pathBounds, clipCache)
    vectorized.push({
      vectorNetwork: network,
      fills: gradientFill ? [{ ...gradientFill, opacity: path.fillOpacity }] : solidFills,
      strokes,
      clips,
      elements: path.elements
    })
  }

  const vectorizedImages = images.map((image) => mapImageElement(image, viewport))
  return {
    paths: vectorized,
    texts: texts.map((text) => ({
      pieces: text.pieces.map((piece) => ({
        ...piece,
        runs: piece.runs.map((run) => ({ ...run, fills: resolveTextFill(run, defaultColor) }))
      })),
      matrix: transformMatrix(text.transform, viewport),
      clips: text.clipPaths && vectorizeClips(text.clipPaths, viewport, null, clipCache),
      elements: text.elements,
      pathIndex: text.pathIndex
    })),
    images: vectorizedImages,
    contentBounds: computeBounds([
      ...(vectorized.length > 0 ? [unionPathBounds(vectorized)] : []),
      ...vectorizedImages.filter((image) => image.width > 0 && image.height > 0)
    ])
  }
}

type ClipCache = WeakMap<NonNullable<IconPathInfo['clipPaths']>, VectorizedClip[]>

/**
 * Clip regions as networks in the target space. An objectBoundingBox clip follows the bounds of
 * what it clips, which text has only once laid out, so without bounds such a clip has no shapes.
 */
function vectorizeClips(
  clipPaths: NonNullable<IconPathInfo['clipPaths']>,
  viewport: SVGViewportMapping,
  objectBounds: Rect | null,
  cache: ClipCache
): VectorizedClip[] {
  const hasObjectBoundingBoxClip = clipPaths.some(({ units }) => units === 'objectBoundingBox')
  const cached = hasObjectBoundingBoxClip ? undefined : cache.get(clipPaths)
  if (cached) return cached
  const clips = clipPaths.map((clipRegion) => ({
    id: clipRegion.id,
    shapes:
      clipRegion.units === 'objectBoundingBox' && !objectBounds
        ? []
        : clipRegion.paths.map((clipPath) => {
            let clipData = applySVGTransformToPath(clipPath.d, clipPath.transform ?? null)
            if (clipRegion.units === 'objectBoundingBox' && objectBounds) {
              clipData = svgpath(clipData)
                .scale(objectBounds.width, objectBounds.height)
                .translate(objectBounds.x, objectBounds.y)
                .toString()
              return parseSVGPath(clipData, clipPath.fillRule, { includeOpenRegions: true })
            }
            return parseSVGPath(mapSVGPathToViewport(clipData, viewport), clipPath.fillRule, {
              includeOpenRegions: true
            })
          })
  }))
  if (!hasObjectBoundingBoxClip) cache.set(clipPaths, clips)
  return clips
}

/** The matrix taking an element's own coordinates, under `transform`, into the target space. */
function transformMatrix(transform: string | null, viewport: SVGViewportMapping): Mat3 {
  const points: Vector[] = []
  svgpath(mapSVGPathToViewport(applySVGTransformToPath('M0 0M1 0M0 1', transform), viewport))
    .abs()
    .iterate((segment) => {
      if (segment[0] === 'M') points.push({ x: segment[1], y: segment[2] })
    })
  const [origin = { x: 0, y: 0 }, unitX = { x: 1, y: 0 }, unitY = { x: 0, y: 1 }] = points
  return [
    unitX.x - origin.x,
    unitY.x - origin.x,
    origin.x,
    unitX.y - origin.y,
    unitY.y - origin.y,
    origin.y,
    0,
    0,
    1
  ]
}

function resolveTextFill(run: SVGTextRun, defaultColor: string): Fill[] {
  const color =
    run.fill === null || run.fill === 'currentColor'
      ? parseColor(defaultColor)
      : parseColor(run.fill)
  return [{ type: 'SOLID', color, opacity: run.fillOpacity, visible: true }]
}
