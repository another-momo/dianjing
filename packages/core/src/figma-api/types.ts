import type { RasterExportFormat } from '#core/io/formats/raster'

export type FigmaTransform = [[number, number, number], [number, number, number]]

/** Raster export request; `pageId` names the page holding the nodes (default: the current page). */
export interface ExportImageOptions {
  scale?: number
  format?: RasterExportFormat
  quality?: number
  pageId?: string
  /** Render the nodes composited in their live page context (everything painting beneath/above them included) instead of isolated on a blank background. */
  renderInContext?: boolean
  /** Output window in absolute canvas coordinates; defaults to the selection's content bounds. */
  clip?: { minX: number; minY: number; maxX: number; maxY: number }
}
