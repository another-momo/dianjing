/**
 * 2026-09-18 CI 修红（run 35372599440，jscpd 阈值 0）：IMAGE fill 字面量
 * 三处克隆（stock-photo/apply.ts + fork/place-image-from-bytes.ts 两处）抽
 * 共享 helper。
 *
 * 类型坑（本批已踩过一次，勿回退）：node 参数用结构型 { fills }——禁
 * @figma/plugin-typings 的 RectangleNode 交叉型，其 ImagePaint 无 color，
 * 新鲜 fills 字面量会撞超额属性检查（TS2353）；proxy 侧 fills 按
 * scene-graph 平铺 Fill 校验（fill 要求 color，IMAGE 变体亦然）。
 */

import type { Fill } from '@open-pencil/scene-graph'

import type { FigmaAPI } from '#core/figma-api'

/** 可写 fills 的节点代理结构型（见头注类型坑） */
export type ImageFillTarget = { fills: readonly Fill[] }

/**
 * createImage + 赋单枚 IMAGE fill（FILL 缩放 / 白 color / 全不透明 /
 * visible）——stock_photo 与 place_image_from_bytes 三调用点同字面量。
 * 返回 image.hash 供调用方进结果。
 */
export function applyImageFill(figma: FigmaAPI, node: ImageFillTarget, bytes: Uint8Array): string {
  const image = figma.createImage(bytes)
  node.fills = [
    {
      type: 'IMAGE',
      color: { r: 1, g: 1, b: 1, a: 1 },
      imageHash: image.hash,
      imageScaleMode: 'FILL',
      visible: true,
      opacity: 1
    }
  ]
  return image.hash
}
