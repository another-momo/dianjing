import type { CanvasKit } from 'canvaskit-wasm'

import type { SceneGraph } from '@open-pencil/scene-graph'

import { SkiaRenderer } from '#core/canvas'
import { memoizeAsync } from '#core/memoize-async'

import { renderNodesToImage, renderThumbnail, type ExportFormat } from './render'

// ck/renderer 双层缓存均走 in-flight 记忆化：并发导出不得双开 WASM 实例、
// 双建 renderer（重复 loadFonts）；失败清零允许下次导出重试。
const initOnce = memoizeAsync(async (): Promise<CanvasKit> => {
  const CanvasKitInit = (await import('canvaskit-wasm/full')).default
  const ckPath = import.meta.resolve('canvaskit-wasm/full')
  // T91c 要 fileURLToPath 语义但不能 import node:url——本模块经 io barrel
  // 进浏览器 bundle，vite 把 node:url 外部化、浏览器访问即抛错（owner dev
  // 页面打不开实证）。手写等价转换：pathname 剥 win32 前导斜杠 + 百分号解码。
  const binDir = decodeURIComponent(new URL('.', ckPath).pathname).replace(/^\/(?=[A-Za-z]:\/)/, '')
  return CanvasKitInit({ locateFile: (file: string) => binDir + file })
})

export function initCanvasKit(): Promise<CanvasKit> {
  return initOnce()
}

const getRenderer = memoizeAsync(async (): Promise<{ ck: CanvasKit; renderer: SkiaRenderer }> => {
  const ck = await initCanvasKit()
  const surface = ck.MakeSurface(1, 1)
  if (!surface) throw new Error('Failed to create CanvasKit surface')
  const renderer = new SkiaRenderer(ck, surface)
  renderer.viewportWidth = 1
  renderer.viewportHeight = 1
  renderer.dpr = 1
  await renderer.loadFonts()
  return { ck, renderer }
})

export async function headlessRenderNodes(
  graph: SceneGraph,
  pageId: string,
  nodeIds: string[],
  options: {
    scale?: number
    format?: ExportFormat
    quality?: number
    trimTransparent?: boolean
  } = {}
): Promise<Uint8Array | null> {
  const { ck, renderer } = await getRenderer()
  renderer.invalidateAllPictures()
  const restoreTextMeasurer = await renderer.prepareForExport(graph, pageId, nodeIds)
  try {
    return renderNodesToImage(ck, renderer, graph, pageId, nodeIds, {
      scale: options.scale ?? 1,
      format: options.format ?? 'PNG',
      quality: options.quality,
      trimTransparent: options.trimTransparent
    })
  } finally {
    restoreTextMeasurer()
  }
}

export async function headlessRenderThumbnail(
  graph: SceneGraph,
  pageId: string,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  const { ck, renderer } = await getRenderer()
  renderer.invalidateAllPictures()
  return renderThumbnail(ck, renderer, graph, pageId, width, height)
}
