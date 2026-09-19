/**
 * Maps vendor SVG into scene-graph vector networks.
 *
 * Raster vectorizers often return paths in viewBox user units while width/height
 * reflect the input pixel size. Scale path data from the SVG coordinate space
 * (viewBox, else width/height) into the target node bounds before parsing.
 */
import svgpath from 'svgpath'

import type { Fill, Stroke, VectorNetwork, WindingRule } from '@open-pencil/scene-graph'
import { mergeVectorNetworks } from '@open-pencil/scene-graph'
import { computeBounds } from '@open-pencil/scene-graph/geometry'
import { parseSVGPath } from '@open-pencil/scene-graph/parse-path'
import type { Rect, Size } from '@open-pencil/scene-graph/primitives'

import { parseColor } from '#core/color'
import { createPathStroke } from '#core/icons/path-style'
import { extractRichContent, transformStrokeScale } from '#core/icons/svg'
import type { SVGImageElementInfo, SVGTextElementInfo } from '#core/icons/svg'
import type { IconPathInfo } from '#core/icons/types'
import { parseSVGSize, parseSVGViewBox } from '#core/io/formats/svg/metadata'
import { computeAccurateBounds } from '#core/vector/curve-math'

import { parseSVGGradients, resolveGradientFill } from './gradients'
import {
  applySVGTransformToPath,
  mapSVGPathToViewport,
  mapSVGPointToViewport,
  resolveSVGViewportMapping,
  type SVGViewportMapping
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

/** SVG 规范默认 font-size（medium）——<text> 未声明时的基准 */
const SVG_DEFAULT_FONT_SIZE = 16
/** 基线 y → 节点顶边的经验换算（典型 ascent ≈ 0.8em） */
const TEXT_ASCENT_RATIO = 0.8
/** contentBounds 用的文本宽度经验估算（无字体度量可用时的上限防收紧偏移） */
const TEXT_WIDTH_PER_CHAR = 0.6

function resolveFill(path: IconPathInfo, defaultColor: string): Fill[] {
  if (path.fill && path.fill !== 'none') {
    const color = path.fill === 'currentColor' ? parseColor(defaultColor) : parseColor(path.fill)
    return [{ type: 'SOLID', color, opacity: 1, visible: true }]
  }
  if (path.fill === null && !path.stroke) {
    return [{ type: 'SOLID', color: parseColor(defaultColor), opacity: 1, visible: true }]
  }
  return []
}

function resolveStrokes(path: IconPathInfo, defaultColor: string, strokeScale = 1): Stroke[] {
  if (!path.stroke || path.stroke === 'none') return []
  const color = path.stroke === 'currentColor' ? parseColor(defaultColor) : parseColor(path.stroke)
  return [createPathStroke(color, path.strokeWidth * strokeScale, path.strokeCap, path.strokeJoin)]
}

export interface VectorizedPath {
  vectorNetwork: VectorNetwork
  fills: Fill[]
  strokes: Stroke[]
  clipNetworks?: VectorNetwork[]
}

/** 目标视口坐标系下的文本元素（y 仍是 SVG 基线语义，建节点侧换算顶边） */
export interface VectorizedText {
  x: number
  y: number
  content: string
  fontFamily: string | null
  fontSize: number
  fontWeight: number | null
  fill: string | null
  textAnchor: 'start' | 'middle' | 'end' | null
}

/** 目标视口坐标系下的内嵌位图元素（旋转/剪切变换退化为轴对齐包围盒） */
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

function mapTextElement(
  text: SVGTextElementInfo,
  viewport: SVGViewportMapping,
  defaultColor: string
): VectorizedText {
  const point = mapSVGPointToViewport(text.x, text.y, text.transform, null, viewport)
  const scale =
    Math.min(viewport.scaleX, viewport.scaleY) * transformStrokeScale(text.transform ?? null)
  const fill = text.fill === 'currentColor' ? defaultColor : text.fill
  return {
    x: point.x,
    y: point.y,
    content: text.content,
    fontFamily: text.fontFamily,
    fontSize: (text.fontSize ?? SVG_DEFAULT_FONT_SIZE) * scale,
    fontWeight: text.fontWeight,
    fill,
    textAnchor: text.textAnchor
  }
}

function mapImageElement(
  image: SVGImageElementInfo,
  viewport: SVGViewportMapping
): VectorizedImage {
  const topLeft = mapSVGPointToViewport(image.x, image.y, image.transform, null, viewport)
  const bottomRight = mapSVGPointToViewport(
    image.x + image.width,
    image.y + image.height,
    image.transform,
    null,
    viewport
  )
  return {
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
    href: image.href
  }
}

/** 文本无精确度量时的经验宽度（0.6em/字符、下限 1em）——contentBounds 估算框与建节点锚点换算共用同一口径，防两处漂移 */
export function estimateVectorizedTextWidth(text: { content: string; fontSize: number }): number {
  return Math.max(text.content.length * text.fontSize * TEXT_WIDTH_PER_CHAR, text.fontSize)
}

/** 文本无精确度量，contentBounds 用经验估算框防止收紧偏移误裁 */
function estimateTextBounds(text: VectorizedText): Rect {
  const width = estimateVectorizedTextWidth(text)
  const height = text.fontSize * (1 + (1 - TEXT_ASCENT_RATIO) * 2)
  const x =
    text.textAnchor === 'middle'
      ? text.x - width / 2
      : text.textAnchor === 'end'
        ? text.x - width
        : text.x
  return { x, y: text.y - text.fontSize * TEXT_ASCENT_RATIO, width, height }
}

function unionRichContentBounds(
  paths: VectorizedPath[],
  texts: VectorizedText[],
  images: VectorizedImage[]
): Rect {
  const rects: Rect[] = []
  if (paths.length > 0) rects.push(unionPathBounds(paths))
  for (const image of images) {
    if (image.width > 0 && image.height > 0) rects.push(image)
  }
  for (const text of texts) rects.push(estimateTextBounds(text))
  return computeBounds(rects)
}

export function svgToVectorPaths(
  svgText: string,
  bounds: Size,
  options?: { defaultColor?: string; preserveAspectRatio?: boolean }
): SVGVectorizeResult | null {
  const rich = extractRichContent(svgText)
  const { paths, texts, images } = rich
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
  const clipCache = new WeakMap<NonNullable<IconPathInfo['clipPaths']>, VectorNetwork[]>()
  for (const path of paths) {
    const fillRule: WindingRule = path.fillRule
    const transform = path.transform ?? null
    const pathData = applySVGTransformToPath(path.d, transform)
    const scaledD = mapSVGPathToViewport(pathData, viewport)
    const network = parseSVGPath(scaledD, fillRule)
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
    let clipNetworks: VectorNetwork[] | undefined
    if (path.clipPaths) {
      const hasObjectBoundingBoxClip = path.clipPaths.some(
        ({ units }) => units === 'objectBoundingBox'
      )
      clipNetworks = hasObjectBoundingBoxClip ? undefined : clipCache.get(path.clipPaths)
      if (!clipNetworks) {
        clipNetworks = path.clipPaths.map((clipRegion) =>
          mergeVectorNetworks(
            clipRegion.paths.map((clipPath) => {
              let clipData = applySVGTransformToPath(clipPath.d, clipPath.transform ?? null)
              if (clipRegion.units === 'objectBoundingBox') {
                clipData = svgpath(clipData)
                  .scale(pathBounds.width, pathBounds.height)
                  .translate(pathBounds.x, pathBounds.y)
                  .toString()
                return parseSVGPath(clipData, clipPath.fillRule)
              }
              return parseSVGPath(mapSVGPathToViewport(clipData, viewport), clipPath.fillRule)
            })
          )
        )
        if (!hasObjectBoundingBoxClip) clipCache.set(path.clipPaths, clipNetworks)
      }
    }
    vectorized.push({
      vectorNetwork: network,
      fills: gradientFill ? [gradientFill] : resolveFill(path, defaultColor),
      strokes: resolveStrokes(path, defaultColor, strokeScale),
      clipNetworks
    })
  }

  const vectorizedTexts = texts.map((text) => mapTextElement(text, viewport, defaultColor))
  const vectorizedImages = images.map((image) => mapImageElement(image, viewport))
  return {
    paths: vectorized,
    texts: vectorizedTexts,
    images: vectorizedImages,
    contentBounds: unionRichContentBounds(vectorized, vectorizedTexts, vectorizedImages)
  }
}
