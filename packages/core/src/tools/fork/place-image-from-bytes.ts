/**
 * 2026-09-18 本地图片工具链（仓外 docs/202609151700-load-image-tool-research.md
 * §3）：place_image_from_bytes——pi-backend load_image 编排器的桥端点。
 *
 * 为什么不用 image_gen_begin/commit：该套端点为 AI 生图设计（建帧语义/批量
 * 放置/覆盖快照），且写入链路无解码闸——magic bytes 过了而 canvaskit 解不了
 * 的文件会落成渲染不出的哑节点（截断 PNG 实证）。本端点行为对齐手工「添加
 * 图片」管线（editor/clipboard/assets.ts 的 prepareAsset/placeFiles）：
 *  - 光栅：MakeImageFromEncoded 真解码闸 + 64MP 像素上限（字节上限防不住
 *    像素炸弹，限制必须落在像素维度）+ 4096 逻辑缩放 + 自动定位
 *  - SVG：prepareSVGImport/createSVGNodesFromImport 矢量化（与手工入口同
 *    一节点形态）
 *  - replace_id：解码闸 + 像素上限后写 IMAGE fill（set_image_fill 同款写入
 *    路径，但前置真解码）
 *
 * placeFiles 本体绑定 EditorContext（选区/撤销回调），工具执行面拿不到——
 * 本端点用同一批图元原语（prepareSVGImport / createSVGNodesFromImport /
 * canvaskit 解码 / figma.createImage / findPlacementPosition）重述该管线；
 * 撤销由桥执行面 withAIUndo 页面快照承担（tool-handlers.ts），无需工具侧
 * 自理。
 *
 * 不对 AI 直接暴露（image_gen_begin 同款 exposure 三面全关）：agent 走
 * load_image（pi-backend 侧有路径三态裁决），桥执行面按名分发不受影响。
 *
 * 测试缝：placeImageFromBytes 的 deps.decodeRaster 可注入——仓内测试不加载
 * canvaskit wasm（compose-backdrop 的 sampler 注入同款先例）。
 */

import * as v from 'valibot'

import type { Size, Vector } from '@open-pencil/scene-graph/primitives'

import { decodeBase64 } from '#core/bytes'
import { type FigmaAPI } from '#core/figma-api'
import { createSVGNodesFromImport, prepareSVGImport } from '#core/io/formats/svg'
import { type ImageGenResult } from '#core/tools/fork/image-gen/requests'
import { findPlacementPosition } from '#core/tools/fork/placement'
import { toolNumber } from '#core/tools/input'
import { defineTool } from '#core/tools/schema'
import { applyImageFill } from '#core/tools/shared/image-fill'

/** 像素上限（总像素）——解码内存闸；超限拒绝并返实际宽高，不静默缩放 */
export const PLACE_IMAGE_MAX_PIXELS = 64_000_000
/** 节点逻辑尺寸上限（与 editor/clipboard/assets.ts IMAGE_MAX_DIMENSION 同值） */
export const PLACE_IMAGE_MAX_DIMENSION = 4096

export type PlaceImageMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'image/bmp'
  | 'image/svg+xml'

export interface PlaceImageFromBytesArgs {
  /** 原始文件名（节点命名 + 去扩展名口径同 assets.ts） */
  name: string
  /** base64 图像字节 */
  image_data: string
  /** pi-backend 嗅探后的规范 MIME（路由 SVG 矢量化 vs 光栅解码） */
  mime: PlaceImageMime
  replace_id?: string
  parent_id?: string
  x?: number
  y?: number
}

export interface PlaceImageFromBytesDeps {
  /**
   * 光栅真解码闸：返回实际像素宽高；不可解码返回 null。
   * 缺省 = canvaskit MakeImageFromEncoded + 1x1 readPixels 强制真实解码
   * （MakeImageFromEncoded 是惰性解码，仅读头不足以拦住截断文件）。
   */
  decodeRaster?: (bytes: Uint8Array) => Promise<Size | null>
}

async function defaultDecodeRaster(bytes: Uint8Array): Promise<Size | null> {
  const { getCanvasKit } = await import('#core/canvaskit')
  const ck = await getCanvasKit()
  const image = ck.MakeImageFromEncoded(bytes)
  if (!image) return null
  try {
    // 强制真实解码：惰性句柄只读了头，1x1 采样触发整图解码验证
    const pixels = image.readPixels(0, 0, {
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
      colorType: ck.ColorType.RGBA_8888,
      width: 1,
      height: 1
    })
    if (!pixels) return null
    return { width: image.width(), height: image.height() }
  } finally {
    image.delete()
  }
}

/** 4096 逻辑缩放（assets.ts decodeImageDimensions 同口径） */
function logicalSize(width: number, height: number): Size {
  if (width <= PLACE_IMAGE_MAX_DIMENSION && height <= PLACE_IMAGE_MAX_DIMENSION) {
    return { width, height }
  }
  const ratio = Math.min(PLACE_IMAGE_MAX_DIMENSION / width, PLACE_IMAGE_MAX_DIMENSION / height)
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) }
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

type NodeProxy = NonNullable<ReturnType<FigmaAPI['getNodeById']>>

// 同形对象类型按仓规别名复用（type-shapes 门禁），不另立字面量
type CheckedRaster = ImageGenResult

async function decodeAndCheckPixels(
  args: PlaceImageFromBytesArgs,
  decodeRaster: (bytes: Uint8Array) => Promise<Size | null>
): Promise<CheckedRaster | { error: string }> {
  const bytes = decodeBase64(args.image_data)
  const decoded = await decodeRaster(bytes)
  if (!decoded) return { error: 'File is corrupted or not a valid image.' }
  const pixels = decoded.width * decoded.height
  if (pixels > PLACE_IMAGE_MAX_PIXELS) {
    return {
      error: `Image too large (${decoded.width}x${decoded.height}). Downscale below 64MP first.`
    }
  }
  return { bytes, ...decoded }
}

/**
 * 新节点落点：x/y 省略时页级走 findPlacementPosition 自动定位；parent_id
 * 在场景的缺省落点按坐标系语义分流——
 *  - 'absolute'（光栅 RECTANGLE 路径）：父左上角绝对原点（appendChild 保持
 *    绝对坐标，先设页级 x/y 再 reparent 不漂移）
 *  - 'parent-local'（SVG 路径）：createSVGNodesFromImport 的 x/y 是父本地
 *    坐标，缺省 0,0
 */
function resolveNewNodePosition(
  figma: FigmaAPI,
  args: PlaceImageFromBytesArgs,
  size: Size,
  parent: NodeProxy | null,
  mode: 'absolute' | 'parent-local'
): Vector {
  let x = args.x
  let y = args.y
  if (x === undefined || y === undefined) {
    if (parent && mode === 'absolute') {
      const abs = figma.graph.getAbsolutePosition(parent.id)
      x ??= abs.x
      y ??= abs.y
    } else if (parent) {
      x ??= 0
      y ??= 0
    } else {
      const auto = findPlacementPosition(figma, size)
      x ??= auto.x
      y ??= auto.y
    }
  }
  return { x, y }
}

/** replace 路径：解码闸 + 像素上限后写 IMAGE fill（set_image_fill 同款写入，但前置真解码） */
async function replaceNodeFill(
  figma: FigmaAPI,
  args: PlaceImageFromBytesArgs,
  decodeRaster: (bytes: Uint8Array) => Promise<Size | null>
): Promise<Record<string, unknown>> {
  if (args.mime === 'image/svg+xml') {
    return {
      error:
        'SVG cannot replace a node fill — omit replace_id to place it as vectorized nodes instead.'
    }
  }
  const target = figma.getNodeById(args.replace_id ?? '')
  if (!target) return { error: `Node "${args.replace_id}" not found` }
  const checked = await decodeAndCheckPixels(args, decodeRaster)
  if ('error' in checked) return checked
  const imageHash = applyImageFill(figma, target, checked.bytes)
  return { id: target.id, width: checked.width, height: checked.height, imageHash }
}

/** SVG 新建：矢量化建 FRAME（与手工「添加图片」同节点形态） */
function placeSVGAsNewNode(
  figma: FigmaAPI,
  args: PlaceImageFromBytesArgs,
  parent: NodeProxy | null
): Record<string, unknown> {
  const source = new TextDecoder().decode(decodeBase64(args.image_data))
  const data = prepareSVGImport(source)
  if (!data) {
    return { error: 'SVG could not be vectorized (no supported shape elements found).' }
  }
  const size = { width: data.width, height: data.height }
  const position = resolveNewNodePosition(figma, args, size, parent, 'parent-local')
  const frame = createSVGNodesFromImport(figma.graph, parent?.id ?? figma.currentPageId, data, {
    name: stripExtension(args.name) || 'SVG',
    x: position.x,
    y: position.y
  })
  if (!frame) {
    return { error: 'SVG could not be vectorized (no supported shape elements found).' }
  }
  return { id: frame.id, width: data.width, height: data.height, imageHash: null }
}

/** 光栅新建：IMAGE-fill RECTANGLE + 4096 逻辑缩放 + 自动定位 */
async function placeRasterAsNewNode(
  figma: FigmaAPI,
  args: PlaceImageFromBytesArgs,
  parent: NodeProxy | null,
  decodeRaster: (bytes: Uint8Array) => Promise<Size | null>
): Promise<Record<string, unknown>> {
  const checked = await decodeAndCheckPixels(args, decodeRaster)
  if ('error' in checked) return checked
  const size = logicalSize(checked.width, checked.height)
  const position = resolveNewNodePosition(figma, args, size, parent, 'absolute')

  // 宽化到 NodeProxy：createRectangle 返回值交叉了插件 typings RectangleNode
  // （fills 字面量 TS2353 坑见 tools/shared/image-fill.ts 头注）；proxy 侧
  // fills 按 scene-graph 平铺 Fill 校验
  const node: NodeProxy = figma.createRectangle()
  node.name = stripExtension(args.name) || 'image'
  node.resize(size.width, size.height)
  node.x = position.x
  node.y = position.y
  const imageHash = applyImageFill(figma, node, checked.bytes)
  // appendChild 保持绝对坐标（reparentNode 语义），x/y 按页级解释不漂移
  if (parent) parent.appendChild(node)
  return { id: node.id, width: size.width, height: size.height, imageHash }
}

export async function placeImageFromBytes(
  figma: FigmaAPI,
  args: PlaceImageFromBytesArgs,
  deps: PlaceImageFromBytesDeps = {}
): Promise<Record<string, unknown>> {
  const decodeRaster = deps.decodeRaster ?? defaultDecodeRaster
  if (args.replace_id) return replaceNodeFill(figma, args, decodeRaster)

  const parent = args.parent_id ? figma.getNodeById(args.parent_id) : null
  if (args.parent_id && !parent) return { error: `Node "${args.parent_id}" not found` }

  if (args.mime === 'image/svg+xml') return placeSVGAsNewNode(figma, args, parent)
  return placeRasterAsNewNode(figma, args, parent, decodeRaster)
}

export const placeImageFromBytesTool = defineTool({
  name: 'place_image_from_bytes',
  execution: { kind: 'async', mutation: 'document' },
  // 内部流水线段：agent 侧经 load_image（路径裁决在 pi-backend），不透出
  exposure: { ai: false, mcp: false, webmcp: false },
  description:
    'INTERNAL pipeline segment — called by the pi-backend load_image orchestrator, not meant for direct AI use. Places image bytes (base64) on the canvas: raster (PNG/JPEG/WEBP/GIF/BMP) goes through a real decode gate and a 64MP pixel cap before becoming an IMAGE-fill rectangle; SVG is vectorized into shape nodes. With replace_id, fills an existing node instead (raster only). Returns {id, width, height, imageHash}.',
  input: v.object({
    name: v.pipe(v.string(), v.description('Original file name (used for node naming)')),
    image_data: v.pipe(v.string(), v.description('Base64-encoded image bytes')),
    mime: v.pipe(
      v.picklist([
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/gif',
        'image/bmp',
        'image/svg+xml'
      ]),
      v.description('Sniffed MIME type of the bytes')
    ),
    replace_id: v.optional(
      v.pipe(v.string(), v.description('Existing node ID to fill (omit = create new node)'))
    ),
    parent_id: v.optional(
      v.pipe(v.string(), v.description('Parent node ID for new nodes (omit = page level)'))
    ),
    x: v.optional(
      toolNumber(v.pipe(v.number(), v.description('X position for new nodes (omit = auto-place)')))
    ),
    y: v.optional(
      toolNumber(v.pipe(v.number(), v.description('Y position for new nodes (omit = auto-place)')))
    )
  }),
  execute: (figma, args) => placeImageFromBytes(figma, args)
})
