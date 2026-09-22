export {
  canMakeBooleanSourceNode,
  canMakeBooleanSourcePath,
  hasVisibleStrokeSourceNode,
  nodeHasVisibleStroke
} from './boolean'
export {
  distanceToGuideSegment,
  getGuideScreenSegment,
  type GuideScreenSegment,
  type GuideViewport
} from './guides/geometry'
export { computeGuideRedline } from './guides/redlines'
export { hitTestGuides, type GuideHit } from './guides/hit-test'
export type { GuideOverlayState, GuidePreview, GuideSelection } from './guides/types'
export { canvasLabelForeground } from './labels/color'
export { SkiaRenderer, type RenderOverlays, type RulerTheme } from './renderer'
export {
  captureRendererDiagnostics,
  getRecentRasterExports,
  recordRasterExportSample,
  type CacheWatermark,
  type RasterExportSample,
  type RendererCrashContext
} from './renderer/diagnostics'
export {
  getRendererDeadState,
  isRendererDead,
  markRendererDead,
  resetRendererDead,
  subscribeRendererDeadState,
  withCrashGuard,
  type CrashCapture,
  type RendererCrash,
  type RendererDeadListener,
  type RendererDeadSnapshot
} from './renderer/dead'
