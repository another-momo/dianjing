import type { Fill, SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import { computeImageHash } from '@open-pencil/scene-graph/images'
import type { Size } from '@open-pencil/scene-graph/primitives'

import { decodeBase64 } from '#core/bytes'
import { parseColor } from '#core/color'
import { createRasterImageFill } from '#core/tools/shared/image-fill'
import { createFlattenedVectorFrameChildren } from '#core/vector/vectorize/placement'
import {
  estimateVectorizedTextWidth,
  svgToVectorPaths,
  type SVGVectorizeResult,
  type VectorizedImage,
  type VectorizedText
} from '#core/vector/vectorize/svg/to-vectors'

import { parseSVGSize } from './metadata'

export type SVGImportData = SVGVectorizeResult & Size

export interface SVGImportOptions {
  name?: string
  defaultColor?: string
  x?: number
  y?: number
}

export function prepareSVGImport(
  source: string,
  options: Pick<SVGImportOptions, 'defaultColor'> = {}
): SVGImportData | null {
  const { width, height } = parseSVGSize(source)
  const vectorized = svgToVectorPaths(
    source,
    { width, height },
    {
      defaultColor: options.defaultColor,
      preserveAspectRatio: true
    }
  )
  return vectorized ? { width, height, ...vectorized } : null
}

/** 基线 y → 节点顶边：与 to-vectors.ts 估算框同口径（ascent ≈ 0.8em） */
const TEXT_ASCENT_RATIO = 0.8

function textAlignFromAnchor(anchor: VectorizedText['textAnchor']): 'LEFT' | 'CENTER' | 'RIGHT' {
  if (anchor === 'middle') return 'CENTER'
  if (anchor === 'end') return 'RIGHT'
  return 'LEFT'
}

/** <text> → TEXT 节点（保可编辑；字体声明尽力直通，渲染期缺字由 font fallback 链兜底） */
function createTextChild(graph: SceneGraph, frameId: string, text: VectorizedText): void {
  const fills: Fill[] = text.fill
    ? [{ type: 'SOLID', color: parseColor(text.fill), opacity: 1, visible: true }]
    : []
  // SVG text-anchor 的 x 是锚点（middle=中心、end=右缘），而 WIDTH_AND_HEIGHT
  // 自适应盒以左缘为 x——按经验宽度把锚点换算回左缘（与 contentBounds 同口径）
  const anchorOffset =
    text.textAnchor === 'middle'
      ? estimateVectorizedTextWidth(text) / 2
      : text.textAnchor === 'end'
        ? estimateVectorizedTextWidth(text)
        : 0
  const props: Record<string, unknown> = {
    name: text.content.length > 40 ? `${text.content.slice(0, 40)}…` : text.content,
    x: text.x - anchorOffset,
    y: text.y - text.fontSize * TEXT_ASCENT_RATIO,
    text: text.content,
    fontSize: text.fontSize,
    textAlignHorizontal: textAlignFromAnchor(text.textAnchor),
    textAutoResize: 'WIDTH_AND_HEIGHT',
    fills
  }
  if (text.fontFamily) props.fontFamily = text.fontFamily
  if (text.fontWeight !== null) props.fontWeight = text.fontWeight
  graph.createNode('TEXT', frameId, props)
}

/** data: URI → 字节；外链/相对引用无法离线解析返回 null（跳过该元素，不阻塞整图导入） */
function decodeImageDataUri(href: string): Uint8Array | null {
  const match = /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,([\s\S]+)$/.exec(href.trim())
  if (!match || !match[1]) return null
  try {
    return decodeBase64(match[1])
  } catch {
    return null
  }
}

/** <image> → storeImage + IMAGE fill 矩形（与手工添加图片同节点形态） */
function createImageChild(graph: SceneGraph, frameId: string, image: VectorizedImage): void {
  const bytes = decodeImageDataUri(image.href)
  if (!bytes) {
    console.warn('Skipping unsupported SVG <image> href (only embedded data: URIs import)')
    return
  }
  const hash = computeImageHash(bytes)
  graph.images.set(hash, bytes)
  graph.createNode('RECTANGLE', frameId, {
    name: 'image',
    x: image.x,
    y: image.y,
    width: image.width,
    height: image.height,
    fills: [createRasterImageFill(hash)]
  })
}

export function createSVGNodesFromImport(
  graph: SceneGraph,
  parentId: string,
  data: SVGImportData,
  options: SVGImportOptions = {}
): SceneNode | null {
  const frame = graph.createNode('FRAME', parentId, {
    name: options.name ?? 'SVG',
    x: options.x ?? 0,
    y: options.y ?? 0,
    width: data.width,
    height: data.height,
    fills: []
  })

  try {
    createFlattenedVectorFrameChildren(graph, frame.id, data, {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      offsetX: 0,
      offsetY: 0
    })
    for (const text of data.texts) createTextChild(graph, frame.id, text)
    for (const image of data.images) createImageChild(graph, frame.id, image)
    if (graph.getChildren(frame.id).length > 0) return frame
    graph.deleteNode(frame.id)
    return null
  } catch (error) {
    graph.deleteNode(frame.id)
    throw error
  }
}

export function createSVGNodes(
  graph: SceneGraph,
  parentId: string,
  source: string,
  options: SVGImportOptions = {}
): SceneNode | null {
  const data = prepareSVGImport(source, options)
  return data ? createSVGNodesFromImport(graph, parentId, data, options) : null
}
