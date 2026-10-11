import { groupBy } from 'es-toolkit/array'
import { isValid, toUint8Array } from 'js-base64'

import {
  fitEnclosingGroups,
  WHITE,
  type SceneGraph,
  type SceneNode
} from '@open-pencil/scene-graph'
import { computeImageHash } from '@open-pencil/scene-graph/images'
import type { Size } from '@open-pencil/scene-graph/primitives'

import { BLACK } from '#core/constants'
import type { SVGElementLayer } from '#core/icons/types'
import { createRasterImageFill } from '#core/tools/shared/image-fill'
import { createPlacedVector, vectorizedPathPaints } from '#core/vector/vectorize/placement'
import {
  svgToVectorPaths,
  type SVGVectorizeResult,
  type VectorizedClip,
  type VectorizedImage,
  type VectorizedPath,
  type VectorizedText
} from '#core/vector/vectorize/svg/to-vectors'

import { parseSVGDocument } from './document'
import { parseSVGSize, svgRootId } from './metadata'
import { createSVGText } from './text'

export type SVGImportData = SVGVectorizeResult &
  Size & {
    /** The root `<svg>` element's `id`, which names the imported layer. */
    name: string | null
    /** Without a width, height, or viewBox the SVG has no frame, only a group of its layers. */
    sized: boolean
  }

export interface SVGImportOptions {
  name?: string
  defaultColor?: string
  x?: number
  y?: number
  /** Keep the frame of an SVG that draws nothing, as `figma.createNodeFromSvg` does. */
  keepEmpty?: boolean
}

/** The layers SVG markup draws, or null when it does not parse as SVG. */
export function prepareSVGImport(
  source: string,
  options: Pick<SVGImportOptions, 'defaultColor'> = {}
): SVGImportData | null {
  if (!parseSVGDocument(source)) return null
  const sized = parseSVGSize(source, { width: 0, height: 0 }).width > 0
  const { width, height } = parseSVGSize(source)
  const vectorized = svgToVectorPaths(
    source,
    { width, height },
    {
      defaultColor: options.defaultColor,
      preserveAspectRatio: true
    }
  ) ?? { paths: [], texts: [], images: [], contentBounds: { x: 0, y: 0, width: 0, height: 0 } }
  return { width, height, name: svgRootId(source), sized, ...vectorized }
}

function createGroup(graph: SceneGraph, parentId: string, props: Partial<SceneNode>): string {
  return graph.createNode('GROUP', parentId, { x: 0, y: 0, ...props }).id
}

/** Figma's clip wrapper: a mask group drawn from the clip's shapes, then the clipped content. */
function createClipGroup(
  graph: SceneGraph,
  parentId: string,
  clip: VectorizedClip,
  parentIds: Set<string>
): string {
  const groupId = createGroup(graph, parentId, { name: 'Clip path group' })
  const maskId = createGroup(graph, groupId, { name: clip.id, isMask: true, maskType: 'VECTOR' })
  for (const shape of clip.shapes) {
    createPlacedVector(graph, maskId, shape, {
      name: 'Vector',
      fills: [{ type: 'SOLID', color: BLACK, opacity: 1, visible: true }]
    })
  }
  parentIds.add(maskId)
  return groupId
}

function clipFor(
  clips: VectorizedClip[] | undefined,
  element: SVGElementLayer
): VectorizedClip | null {
  const clip = element.clip === null ? null : clips?.[element.clip]
  return clip && clip.shapes.length > 0 ? clip : null
}

/** A path or a text, with the elements it was drawn in. */
interface Drawable {
  elements: SVGElementLayer[]
  clips?: VectorizedClip[]
  create: (parentId: string, element: SVGElementLayer) => void
}

/** Paths and texts in drawing order: each text goes before the path it preceded. */
function drawables(graph: SceneGraph, data: SVGImportData, parentIds: Set<string>): Drawable[] {
  const pathDrawable = (path: VectorizedPath): Drawable => ({
    elements: path.elements,
    clips: path.clips,
    create: (parentId, element) => {
      const vector = createPlacedVector(graph, parentId, path.vectorNetwork, {
        name: element.name ?? 'Vector',
        opacity: element.opacity,
        ...vectorizedPathPaints(path)
      })
      if (vector) parentIds.add(parentId)
    }
  })
  const textDrawable = (text: VectorizedText): Drawable => ({
    elements: text.elements,
    clips: text.clips,
    create: (parentId, element) => {
      createSVGText(graph, parentId, text, element, (groupParentId, props) => {
        const groupId = createGroup(graph, groupParentId, props)
        parentIds.add(groupId)
        return groupId
      })
      parentIds.add(parentId)
    }
  })
  const textsByPath = groupBy(data.texts, (text) => text.pathIndex)
  const textsAt = (index: number) => (textsByPath[index] ?? []).map(textDrawable)
  return [
    ...data.paths.flatMap((path, index) => [...textsAt(index), pathDrawable(path)]),
    ...textsAt(data.paths.length)
  ]
}

/**
 * Builds the layers Figma makes from SVG: a group per `<g>`, a vector per shape and a text layer
 * per text, each named by its `id`, and a clip group around anything clipped. Groups are fitted
 * to their layers last.
 */
function createSVGLayers(graph: SceneGraph, rootId: string, data: SVGImportData): void {
  const open: Array<{ key: number; parentId: string }> = []
  const parentIds = new Set<string>()
  for (const drawable of drawables(graph, data, parentIds)) {
    const groups = drawable.elements.slice(0, -1)
    const shape = drawable.elements.at(-1)
    if (!shape) continue
    let depth = 0
    while (depth < open.length && depth < groups.length && open[depth].key === groups[depth].key) {
      depth++
    }
    open.length = depth
    let parentId = open.at(-1)?.parentId ?? rootId
    for (const element of groups.slice(depth)) {
      const clip = clipFor(drawable.clips, element)
      if (clip) parentId = createClipGroup(graph, parentId, clip, parentIds)
      parentId = createGroup(graph, parentId, {
        name: element.name ?? 'Group',
        opacity: element.opacity
      })
      open.push({ key: element.key, parentId })
    }
    const clip = clipFor(drawable.clips, shape)
    drawable.create(clip ? createClipGroup(graph, parentId, clip, parentIds) : parentId, shape)
  }
  fitEnclosingGroups(graph, [...parentIds])
}

/** data: URI → 字节；外链/相对引用无法离线解析返回 null（跳过该元素，不阻塞整图导入） */
function decodeImageDataURI(href: string): Uint8Array | null {
  const match = /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,([\s\S]+)$/.exec(href.trim())
  if (!match?.[1]) return null
  try {
    if (!isValid(match[1])) throw new TypeError('Invalid Base64 string')
    return toUint8Array(match[1])
  } catch {
    return null
  }
}

/** <image> → storeImage + IMAGE fill 矩形（与手工添加图片同节点形态） */
function createImageChild(graph: SceneGraph, rootId: string, image: VectorizedImage): void {
  const bytes = decodeImageDataURI(image.href)
  if (!bytes) {
    console.warn('Skipping unsupported SVG <image> href (only embedded data: URIs import)')
    return
  }
  const hash = computeImageHash(bytes)
  graph.images.set(hash, bytes)
  graph.createNode('RECTANGLE', rootId, {
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
  const position = { x: options.x ?? 0, y: options.y ?? 0 }
  const root = data.sized
    ? graph.createNode('FRAME', parentId, {
        name: options.name ?? data.name ?? 'Frame',
        ...position,
        width: data.width,
        height: data.height,
        fills: [{ type: 'SOLID', color: WHITE, opacity: 1, visible: true }],
        clipsContent: true
      })
    : graph.createNode('GROUP', parentId, {
        name: options.name ?? data.name ?? 'Group',
        ...position
      })

  try {
    createSVGLayers(graph, root.id, data)
    for (const image of data.images) createImageChild(graph, root.id, image)
    const created = graph.getNode(root.id)
    if (created && (options.keepEmpty || graph.getChildren(root.id).length > 0)) return created
    if (created) graph.deleteNode(root.id)
    return null
  } catch (error) {
    graph.deleteNode(root.id)
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
