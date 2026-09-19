import { getWorldMatrix } from '@open-pencil/scene-graph/coordinate'
import Matrix from '@open-pencil/scene-graph/matrix'

import { isRasterImageMime, isSVGImageFile, isSupportedImageFile } from '#core/bytes'
import { resolvePasteTarget } from '#core/editor/clipboard/paste-target'
import type { EditorContext } from '#core/editor/types'
import { computeImageHash } from '#core/figma-api'
import {
  createSVGNodesFromImport,
  prepareSVGImport,
  type SVGImportData
} from '#core/io/formats/svg'
import { computeAllLayouts } from '#core/layout'
import { createRasterImageFill } from '#core/tools/shared/image-fill'

const IMAGE_MAX_DIMENSION = 4096
const ASSET_GAP = 20

interface PreparedRasterAsset {
  kind: 'raster'
  bytes: Uint8Array
  name: string
  width: number
  height: number
}

interface PreparedSVGAsset {
  kind: 'svg'
  data: SVGImportData
  name: string
  width: number
  height: number
}

type PreparedAsset = PreparedRasterAsset | PreparedSVGAsset

/**
 * 放置失败的机器可读原因（2026-09-19「添加图片配套」件 4）——toast 按
 * 原因分文案：0 字节空文件 / 不支持格式 / 损坏或无法解码 / 图像引擎未就绪
 * （ck 空窗期 decode 必返 null，与真损坏区分开给用户明确提示）。
 */
export type PlaceFileFailureReason = 'empty' | 'unsupported' | 'corrupted' | 'engine-not-ready'

export interface PlaceFileFailure {
  name: string
  reason: PlaceFileFailureReason
}

export interface PlaceFilesResult {
  /** 成功落画布的节点数 */
  placed: number
  /** 未放置文件的逐条原因（顺序同入参） */
  failures: PlaceFileFailure[]
}

type PushCreatedNodesUndo = (
  created: string[],
  previousSelection: Set<string>,
  label?: string
) => void

export function createClipboardAssetActions(
  ctx: EditorContext,
  pushCreatedNodesUndo: PushCreatedNodesUndo
) {
  function storeImage(bytes: Uint8Array): string {
    const hash = computeImageHash(bytes)
    ctx.graph.images.set(hash, bytes)
    return hash
  }

  function decodeImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
    const ck = ctx.getCk()
    if (!ck) return null
    const skImg = ck.MakeImageFromEncoded(bytes)
    if (!skImg) return null
    let width = skImg.width()
    let height = skImg.height()
    skImg.delete()
    if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
      const ratio = Math.min(IMAGE_MAX_DIMENSION / width, IMAGE_MAX_DIMENSION / height)
      width = Math.round(width * ratio)
      height = Math.round(height * ratio)
    }
    return { width, height }
  }

  async function prepareAsset(
    file: File
  ): Promise<{ asset: PreparedAsset } | { failure: PlaceFileFailure }> {
    if (file.size === 0) return { failure: { name: file.name, reason: 'empty' } }
    if (isSVGImageFile(file)) {
      const data = prepareSVGImport(await file.text())
      return data
        ? {
            asset: {
              kind: 'svg',
              data,
              name: file.name.replace(/\.svg$/i, '') || 'SVG',
              width: data.width,
              height: data.height
            }
          }
        : { failure: { name: file.name, reason: 'corrupted' } }
    }
    if (!isRasterImageMime(file.type)) {
      return { failure: { name: file.name, reason: 'unsupported' } }
    }
    if (!ctx.getCk()) return { failure: { name: file.name, reason: 'engine-not-ready' } }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const dimensions = decodeImageDimensions(bytes)
    return dimensions
      ? { asset: { kind: 'raster', bytes, name: file.name, ...dimensions } }
      : { failure: { name: file.name, reason: 'corrupted' } }
  }

  function parentLocalPoint(parentId: string, x: number, y: number) {
    const parent = ctx.graph.getNode(parentId)
    if (!parent) return { x, y }
    const inverse = Matrix.invert(getWorldMatrix(parent, ctx.graph))
    return inverse ? Matrix.mapPoint(inverse, { x, y }) : { x, y }
  }

  function createRasterNode(
    asset: PreparedRasterAsset,
    parentId: string,
    x: number,
    y: number
  ): string {
    return ctx.graph.createNode('RECTANGLE', parentId, {
      name: asset.name.replace(/\.[^.]+$/, ''),
      x,
      y,
      width: asset.width,
      height: asset.height,
      fills: [createRasterImageFill(storeImage(asset.bytes))]
    }).id
  }

  /** failures 携带逐文件失败原因——调用方据此给用户分文案反馈 */
  async function placeFiles(files: File[], cx: number, cy: number): Promise<PlaceFilesResult> {
    const outcomes = await Promise.all(files.map(prepareAsset))
    const prepared = outcomes.flatMap((outcome) => ('asset' in outcome ? [outcome.asset] : []))
    const failures = outcomes.flatMap((outcome) => ('failure' in outcome ? [outcome.failure] : []))
    if (prepared.length === 0) return { placed: 0, failures }

    const previousSelection = new Set(ctx.state.selectedIds)
    const parentId = resolvePasteTarget(ctx)
    const center = parentLocalPoint(parentId, cx, cy)
    const totalWidth =
      prepared.reduce((total, asset) => total + asset.width, 0) + ASSET_GAP * (prepared.length - 1)
    const maxHeight = Math.max(...prepared.map((asset) => asset.height))
    let x = center.x - totalWidth / 2
    const y = center.y - maxHeight / 2
    const created: string[] = []

    try {
      for (const asset of prepared) {
        const id =
          asset.kind === 'raster'
            ? createRasterNode(asset, parentId, x, y)
            : createSVGNodesFromImport(ctx.graph, parentId, asset.data, {
                name: asset.name,
                x,
                y
              })?.id
        // 例如 SVG 仅含外链 <image>（data: 以外 href 跳过）——矢量化阶段拦不住，建节点阶段才归零
        if (id) created.push(id)
        else failures.push({ name: asset.name, reason: 'corrupted' })
        x += asset.width + ASSET_GAP
      }
    } catch (error) {
      for (const id of created.reverse()) ctx.graph.deleteNode(id)
      throw error
    }

    if (created.length === 0) return { placed: 0, failures }
    computeAllLayouts(ctx.graph, ctx.state.currentPageId)
    ctx.setSelectedIds(new Set(created))
    pushCreatedNodesUndo(created, previousSelection, 'Place files')
    ctx.requestRender()
    return { placed: created.length, failures }
  }

  function placeImageFiles(files: File[], cx: number, cy: number) {
    return placeFiles(files.filter(isSupportedImageFile), cx, cy)
  }

  return { storeImage, placeFiles, placeImageFiles }
}
