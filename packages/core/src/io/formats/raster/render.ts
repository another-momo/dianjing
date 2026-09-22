import type { CanvasKit, Canvas, Image, MallocObj, Surface } from 'canvaskit-wasm'

import {
  getWorldMatrix,
  type Mat3,
  type SceneGraph,
  type SceneNode
} from '@open-pencil/scene-graph'
import { computeDescendantVisualBounds } from '@open-pencil/scene-graph/geometry'

import type { SkiaRenderer } from '#core/canvas'
import type { RenderColorSpace } from '#core/color/management'
import { extractExportGraph, findPageId } from '#core/io/subgraph'

export type RasterExportFormat = 'PNG' | 'JPG' | 'WEBP'
export type ExportFormat = RasterExportFormat | 'SVG'

interface RenderOptions {
  scale: number
  format: ExportFormat
  quality?: number
  colorSpace?: RenderColorSpace
  trimTransparent?: boolean
  /**
   * Render the live page instead of extracting the selection onto a scratch
   * page — the selection paints with everything beneath/above it in z-order
   * (the same thing the blend-mode/BACKGROUND_BLUR path forces implicitly).
   */
  renderInContext?: boolean
  /**
   * Output window in absolute canvas coordinates. Defaults to the
   * selection's content bounds.
   */
  clip?: { minX: number; minY: number; maxX: number; maxY: number }
}

function ensureSinglePageSelection(graph: SceneGraph, pageId: string, nodeIds: string[]): boolean {
  return nodeIds.every((nodeId) => findPageId(graph, nodeId) === pageId)
}

function nodeNeedsSceneBackdrop(graph: SceneGraph, nodeId: string): boolean {
  const node = graph.getNode(nodeId)
  if (!node) return false
  if (node.blendMode !== 'NORMAL' && node.blendMode !== 'PASS_THROUGH') return true
  if (node.effects.some((effect) => effect.visible && effect.type === 'BACKGROUND_BLUR')) {
    return true
  }
  return node.childIds.some((childId) => nodeNeedsSceneBackdrop(graph, childId))
}

export function computeContentBounds(graph: SceneGraph, nodeIds: string[]) {
  return computeDescendantVisualBounds(
    nodeIds,
    (id) => graph.getNode(id),
    (id) => graph.getAbsolutePosition(id)
  )
}

function ckImageFormat(ck: CanvasKit, format: ExportFormat) {
  switch (format) {
    case 'JPG':
      return ck.ImageFormat.JPEG
    case 'WEBP':
      return ck.ImageFormat.WEBP
    default:
      return ck.ImageFormat.PNG
  }
}

function findAlphaBounds(ck: CanvasKit, canvas: Canvas, width: number, height: number) {
  const pixels = canvas.readPixels(0, 0, {
    alphaType: ck.AlphaType.Unpremul,
    colorType: ck.ColorType.RGBA_8888,
    colorSpace: ck.ColorSpace.SRGB,
    width,
    height
  })
  if (!pixels) return null

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (pixels[row + x * 4 + 3] === 0) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + 1)
      maxY = Math.max(maxY, y + 1)
    }
  }

  if (maxX < minX || maxY < minY) return null
  return { minX, minY, maxX, maxY }
}

const MIN_TRANSPARENT_TRIM_INSET = 2

/**
 * B-2（§4 根因治理·第一档）：导出前置字节预算——防止长图 / 超采样组合
 * 在 CanvasKit 单例堆上一次吃掉数百 MB～1GB。所有 raster 导出入口都按
 * `content bounds × scale × 超采样系数 × 4 字节` 先算，落到本阈值即按
 * renderScale 折半回退，最小 1×；仍超即抛 RasterBudgetExceededError 由调用
 * 层本地化文案。512 MB 阈值远高于正常导出（4K 屏截图 ~50 MB），普通画布
 * 行为零变化。
 */
export const MAX_RASTER_BYTES = 512 * 1024 * 1024

/**
 * Thrown when the requested raster export exceeds {@link MAX_RASTER_BYTES} even
 * at the smallest allowed supersample factor (1×). Carries structured fields so
 * the host (Vue UI, agent bridge, .fig save chain) can render a localized
 * message and pick a recovery scale without re-parsing the string.
 */
export class RasterBudgetExceededError extends Error {
  readonly name = 'RasterBudgetExceededError'
  readonly contentW: number
  readonly contentH: number
  readonly scale: number
  readonly projectedBytes: number

  constructor(contentW: number, contentH: number, scale: number, projectedBytes: number) {
    super(
      `Raster export exceeds ${MAX_RASTER_BYTES} byte budget (content ${contentW}×${contentH} at ${scale}× would allocate ${projectedBytes} bytes)`
    )
    this.contentW = contentW
    this.contentH = contentH
    this.scale = scale
    this.projectedBytes = projectedBytes
  }
}

function projectedRasterBytes(
  contentW: number,
  contentH: number,
  scale: number,
  renderScale: number
): number {
  const w = Math.ceil(contentW * scale * renderScale)
  const h = Math.ceil(contentH * scale * renderScale)
  return w * h * 4
}

/**
 * Returns the largest renderScale ≤ `requestedRenderScale` (minimum 1) such
 * that the projected high-res surface allocation stays within the byte budget.
 * Throws {@link RasterBudgetExceededError} if even renderScale=1 overflows.
 */
function chooseRasterRenderScale(
  contentW: number,
  contentH: number,
  scale: number,
  requestedRenderScale: number
): number {
  let renderScale = Math.max(1, Math.floor(requestedRenderScale))
  while (renderScale > 1) {
    const bytes = projectedRasterBytes(contentW, contentH, scale, renderScale)
    if (bytes <= MAX_RASTER_BYTES) return renderScale
    renderScale = Math.max(1, Math.floor(renderScale / 2))
  }
  const baseBytes = projectedRasterBytes(contentW, contentH, scale, 1)
  if (baseBytes <= MAX_RASTER_BYTES) return 1
  throw new RasterBudgetExceededError(contentW, contentH, scale, baseBytes)
}

function shouldTrimAlphaBounds(
  alphaBounds: NonNullable<ReturnType<typeof findAlphaBounds>>,
  width: number,
  height: number
): boolean {
  return (
    Math.max(
      alphaBounds.minX,
      alphaBounds.minY,
      width - alphaBounds.maxX,
      height - alphaBounds.maxY
    ) >= MIN_TRANSPARENT_TRIM_INSET
  )
}

// CanvasKit's `encodeToBytes` returns null for JPEG/WEBP in this build, so
// fall back to encoding the raw pixels through the browser canvas.
function encodeRasterViaBrowserFallback(
  ck: CanvasKit,
  renderer: SkiaRenderer,
  downsampleCanvas: Canvas,
  alphaBounds: ReturnType<typeof findAlphaBounds>,
  width: number,
  height: number,
  format: ExportFormat,
  quality: number
): Uint8Array | null {
  if (format !== 'JPG' && format !== 'WEBP') return null
  const exportWidth = alphaBounds ? alphaBounds.maxX - alphaBounds.minX : width
  const exportHeight = alphaBounds ? alphaBounds.maxY - alphaBounds.minY : height
  const exportMinX = alphaBounds ? alphaBounds.minX : 0
  const exportMinY = alphaBounds ? alphaBounds.minY : 0

  const rawPixels = downsampleCanvas.readPixels(exportMinX, exportMinY, {
    alphaType: ck.AlphaType.Unpremul,
    colorType: ck.ColorType.RGBA_8888,
    colorSpace: ck.ColorSpace.SRGB,
    width: exportWidth,
    height: exportHeight
  })
  if (!(rawPixels instanceof Uint8Array)) return null
  return renderer.encodeRasterFallback(rawPixels, exportWidth, exportHeight, format, quality)
}

function renderToSurface(
  ck: CanvasKit,
  renderer: SkiaRenderer,
  renderGraph: SceneGraph,
  pageId: string,
  width: number,
  height: number,
  format: ExportFormat,
  quality: number,
  setup: (canvas: Canvas) => void,
  trimTransparent = false,
  renderScale = 2
): Uint8Array | null {
  const renderWidth = width * renderScale
  const renderHeight = height * renderScale
  // B-2 防御层：上游入口已做预算降级；此处兜底——直接把 width/height/renderScale
  // 代入字节预算校验，避免外部调用绕过入口（如 headless 路径、自定义 setup）
  // 时把巨型分配提交给 CanvasKit 单例。
  const requestedBytes = renderWidth * renderHeight * 4
  if (requestedBytes > MAX_RASTER_BYTES) {
    throw new RasterBudgetExceededError(width, height, 1, requestedBytes)
  }
  const pixels = ck.Malloc(Uint8Array, renderWidth * renderHeight * 4)
  const surface = ck.MakeRasterDirectSurface(
    {
      alphaType: ck.AlphaType.Premul,
      colorType: ck.ColorType.RGBA_8888,
      colorSpace: ck.ColorSpace.SRGB,
      width: renderWidth,
      height: renderHeight
    },
    pixels,
    renderWidth * 4
  )
  if (!surface) {
    ck.Free(pixels)
    return null
  }

  // B-1（§4 逃生舱·第一档·无条件正确）：资源所有权收敛到函数作用域顶部，
  // 释放后置 null 防重复——makeImageSnapshot() 返 null 时 .delete() 会抛
  // TypeError，泄漏会反馈给 CanvasKit 单例堆。单一 finally 覆盖所有退出路径
  // （正常返回 / 早返 / 抛错），成功路径语义零变化。
  let highResImage: Image | null = null
  let downsamplePixels: MallocObj | null = null
  let downsampleSurface: Surface | null = null
  let image: Image | null = null

  try {
    const canvas = surface.getCanvas()
    canvas.scale(renderScale, renderScale)
    setup(canvas)
    renderer.renderSceneToCanvas(canvas, renderGraph, pageId)
    surface.flush()

    // d.ts 把 makeImageSnapshot 标为非空返回，运行时实际可返 null——cast 保住守卫
    highResImage = surface.makeImageSnapshot() as Image | null
    if (!highResImage) return null

    downsamplePixels = ck.Malloc(Uint8Array, width * height * 4)
    downsampleSurface = ck.MakeRasterDirectSurface(
      {
        alphaType: ck.AlphaType.Premul,
        colorType: ck.ColorType.RGBA_8888,
        colorSpace: ck.ColorSpace.SRGB,
        width,
        height
      },
      downsamplePixels,
      width * 4
    )
    if (!downsampleSurface) return null

    const downsampleCanvas = downsampleSurface.getCanvas()
    downsampleCanvas.clear(ck.TRANSPARENT)
    downsampleCanvas.drawImageRectOptions(
      highResImage,
      ck.LTRBRect(0, 0, renderWidth, renderHeight),
      ck.LTRBRect(0, 0, width, height),
      ck.FilterMode.Linear,
      ck.MipmapMode.None,
      null
    )
    downsampleSurface.flush()
    highResImage.delete()
    highResImage = null

    const foundAlphaBounds = trimTransparent
      ? findAlphaBounds(ck, downsampleCanvas, width, height)
      : null
    const alphaBounds =
      foundAlphaBounds && shouldTrimAlphaBounds(foundAlphaBounds, width, height)
        ? foundAlphaBounds
        : null
    image = (
      alphaBounds
        ? downsampleSurface.makeImageSnapshot([
            alphaBounds.minX,
            alphaBounds.minY,
            alphaBounds.maxX,
            alphaBounds.maxY
          ])
        : downsampleSurface.makeImageSnapshot()
    ) as Image | null
    if (!image) return null

    const encoded = image.encodeToBytes(ckImageFormat(ck, format), quality)
    let resultBytes: Uint8Array | null = encoded ? new Uint8Array(encoded) : null
    resultBytes ??= encodeRasterViaBrowserFallback(
      ck,
      renderer,
      downsampleCanvas,
      alphaBounds,
      width,
      height,
      format,
      quality
    )

    return resultBytes
  } finally {
    image?.delete()
    downsampleSurface?.delete()
    highResImage?.delete()
    if (downsamplePixels) ck.Free(downsamplePixels)
    surface.delete()
    ck.Free(pixels)
  }
}

export function prepareSelectionRenderGraph(
  source: SceneGraph,
  renderGraph: SceneGraph,
  pageId: string,
  nodeIds: string[]
): void {
  const page = renderGraph.getNode(pageId)
  if (!page) return

  page.childIds = nodeIds.filter((nodeId) => renderGraph.getNode(nodeId) !== undefined)
  for (const nodeId of page.childIds) {
    const node = renderGraph.getNode(nodeId)
    const sourceNode = source.getNode(nodeId)
    if (!node || !sourceNode) continue
    if (sourceNode.parentId === pageId) continue
    const world = getWorldMatrix(sourceNode, source)
    node.parentId = pageId
    applyWorldTransform(node, world)
  }
  renderGraph.clearAbsPosCache()
}

function applyWorldTransform(node: SceneNode, matrix: Mat3): void {
  const determinant = matrix[0] * matrix[4] - matrix[1] * matrix[3]
  const flipX = determinant < 0
  const rotation = Math.atan2(matrix[3], flipX ? matrix[4] : matrix[0])
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const centerX = node.width / 2
  const centerY = node.height / 2
  const m00 = flipX ? -cos : cos
  const m01 = flipX ? sin : -sin
  const m10 = sin
  const m11 = cos

  node.x = matrix[2] - centerX + m00 * centerX + m01 * centerY
  node.y = matrix[5] - centerY + m10 * centerX + m11 * centerY
  node.rotation = rotation * (180 / Math.PI)
  node.flipX = flipX
  node.flipY = false
}

export function renderNodesToImage(
  ck: CanvasKit,
  renderer: SkiaRenderer,
  graph: SceneGraph,
  pageId: string,
  nodeIds: string[],
  options: RenderOptions
): Uint8Array | null {
  if (!ensureSinglePageSelection(graph, pageId, nodeIds)) {
    throw new Error('Raster export selection must stay on a single page')
  }

  const bounds = options.clip ?? computeContentBounds(graph, nodeIds)
  if (!bounds) return null

  const contentW = bounds.maxX - bounds.minX
  const contentH = bounds.maxY - bounds.minY
  if (contentW <= 0 || contentH <= 0) return null

  const pixelW = Math.ceil(contentW * options.scale)
  const pixelH = Math.ceil(contentH * options.scale)
  if (pixelW <= 0 || pixelH <= 0) return null

  const inContext =
    options.renderInContext === true ||
    nodeIds.some((nodeId) => nodeNeedsSceneBackdrop(graph, nodeId))

  let renderGraph = graph
  let renderPageId = pageId
  if (!inContext) {
    const extracted = extractExportGraph(graph, { scope: 'selection', nodeIds })
    if (!extracted.pageId) return null
    prepareSelectionRenderGraph(graph, extracted.graph, extracted.pageId, nodeIds)
    renderGraph = extracted.graph
    renderPageId = extracted.pageId
  }

  const quality = options.quality ?? (options.format === 'PNG' ? 100 : 90)
  // B-2（§4 根因治理·第一档）：先按字节预算选 renderScale——超采样系数从
  // 2×/4× 折半回退到 1×，溢出仍超则向上抛 RasterBudgetExceededError。
  // pixelW/pixelH 来自同一预算（renderScale=1 时的尺寸），正常导出不变。
  const requestedRenderScale = Math.max(2, options.scale)
  const renderScale = chooseRasterRenderScale(
    contentW,
    contentH,
    options.scale,
    requestedRenderScale
  )
  return renderToSurface(
    ck,
    renderer,
    renderGraph,
    renderPageId,
    pixelW,
    pixelH,
    options.format,
    quality,
    (canvas) => {
      canvas.clear(options.format === 'JPG' ? ck.WHITE : ck.TRANSPARENT)
      canvas.scale(options.scale, options.scale)
      canvas.translate(-bounds.minX, -bounds.minY)
    },
    options.trimTransparent,
    renderScale
  )
}

export function renderThumbnail(
  ck: CanvasKit,
  renderer: SkiaRenderer,
  graph: SceneGraph,
  pageId: string,
  width: number,
  height: number
): Uint8Array | null {
  const page = graph.getNode(pageId)
  if (!page || page.childIds.length === 0) return null

  const bounds = computeContentBounds(graph, page.childIds)
  if (!bounds) return null

  const contentW = bounds.maxX - bounds.minX
  const contentH = bounds.maxY - bounds.minY
  if (contentW <= 0 || contentH <= 0) return null

  const scale = Math.min(width / contentW, height / contentH)
  const pixelW = Math.max(1, Math.round(contentW * scale))
  const pixelH = Math.max(1, Math.round(contentH * scale))

  return renderToSurface(ck, renderer, graph, pageId, pixelW, pixelH, 'PNG', 100, (canvas) => {
    canvas.clear(ck.Color4f(renderer.pageColor.r, renderer.pageColor.g, renderer.pageColor.b, 1))
    canvas.translate(-bounds.minX * scale, -bounds.minY * scale)
    canvas.scale(scale, scale)
  })
}
