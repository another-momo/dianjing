/**
 * 崩溃现场取证与缓存水位观测（docs/202609221818 §4 B-5/B-7）。
 *
 * 两个出口共用一个采集点：
 *   - B-7 崩溃现场快照——render-loop 的 crash capture 回调在翻 renderer-dead
 *     闸前调 captureRendererDiagnostics，把崩溃瞬间的缓存水位 / 最近导出 /
 *     场景版本挂到 RendererCrash.context 上，随 dead 闸快照可取（控制台同时
 *     落一份，重启前排障不依赖任何外部工具）。
 *   - B-5 水位观测——captureRendererDiagnostics 本身是只读函数，随时可调；
 *     观测先行版不做主动逐出/降级，只把数取出来。
 *
 * 导出取样由 raster 导出路径（renderToSurface）在 finally 里记——成功与失败
 * 都记（失败导出同样是内存压力信号），环形缓冲只留最近 8 笔防无界增长。
 *
 * 采集函数必须自身无敌：它在渲染器已崩的上下文里跑，任何字段读取失败都只
 * 能降级为「少记一点」，绝不能再抛——capture 回调若抛错会逃出
 * withCrashGuard 的 catch 块，把已吞下的崩溃重新变成未处理异常。
 */

import type { SkiaRenderer } from '#core/canvas/renderer'

export interface RasterExportSample {
  /** Date.now() 取样时刻。 */
  at: number
  /** 导出内容尺寸（未乘 scale）。 */
  width: number
  height: number
  scale: number
  /** 产出字节数；失败为 0。 */
  bytes: number
  /** 导出耗时毫秒。 */
  ms: number
  ok: boolean
}

const MAX_RECENT_EXPORTS = 8
const recentExports: RasterExportSample[] = []

export function recordRasterExportSample(sample: RasterExportSample): void {
  recentExports.push(sample)
  if (recentExports.length > MAX_RECENT_EXPORTS) recentExports.shift()
}

export function getRecentRasterExports(): readonly RasterExportSample[] {
  return recentExports
}

export interface CacheWatermark {
  entries: number
  /** ResourceCache 系给字节水位；Map 系无字节概念给 null。 */
  bytes: number | null
}

export interface RendererCrashContext {
  imageCache: CacheWatermark
  effectRasterCache: CacheWatermark
  nodePictureCache: CacheWatermark
  subtreePictureCache: CacheWatermark
  scenePictureVersion: number
  fontGeneration: number
  zoom: number
  dpr: number
  viewport: { width: number; height: number }
  worldViewport: { x: number; y: number; w: number; h: number } | null
  recentExports: readonly RasterExportSample[]
  /** performance.memory 存在才给（Chromium 系）；其它宿主为 null。 */
  jsHeapUsedBytes: number | null
}

function emptyContext(): RendererCrashContext {
  return {
    imageCache: { entries: 0, bytes: null },
    effectRasterCache: { entries: 0, bytes: null },
    nodePictureCache: { entries: 0, bytes: null },
    subtreePictureCache: { entries: 0, bytes: null },
    scenePictureVersion: 0,
    fontGeneration: 0,
    zoom: 1,
    dpr: 1,
    viewport: { width: 0, height: 0 },
    worldViewport: null,
    recentExports: getRecentRasterExports(),
    jsHeapUsedBytes: null
  }
}

function readJsHeapUsedBytes(): number | null {
  const memory = (performance as { memory?: { usedJSHeapSize?: unknown } }).memory
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null
}

/**
 * 只读采集渲染器诊断快照。renderer 为 null（尚未建/已销毁）或读取中途出错
 * 时降级为零值快照——崩毁上下文里「少记」永远优于「不记或再炸一次」。
 */
export function captureRendererDiagnostics(renderer: SkiaRenderer | null): RendererCrashContext {
  const base = emptyContext()
  base.jsHeapUsedBytes = readJsHeapUsedBytes()
  if (!renderer) return base
  try {
    return {
      imageCache: { entries: renderer.imageCache.size, bytes: renderer.imageCache.weight },
      effectRasterCache: {
        entries: renderer.effectRasterCache.size,
        bytes: renderer.effectRasterCache.weight
      },
      nodePictureCache: { entries: renderer.nodePictureCache.size, bytes: null },
      subtreePictureCache: { entries: renderer.subtreePictureCache.size, bytes: null },
      scenePictureVersion: renderer.scenePictureVersion,
      fontGeneration: renderer.fontGeneration,
      zoom: renderer.zoom,
      dpr: renderer.dpr,
      viewport: { width: renderer.viewportWidth, height: renderer.viewportHeight },
      worldViewport: renderer.worldViewport,
      recentExports: getRecentRasterExports(),
      jsHeapUsedBytes: base.jsHeapUsedBytes
    }
  } catch {
    return base
  }
}
