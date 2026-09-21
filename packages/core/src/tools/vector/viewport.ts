import * as v from 'valibot'

import type { FigmaNodeProxy } from '#core/figma-api'
import { toolNumber } from '#core/tools/input'
import { defineTool } from '#core/tools/schema'

export const viewportGet = defineTool({
  name: 'viewport_get',
  description: 'Get current viewport position and zoom level.',
  execution: { kind: 'sync', mutation: 'none' },
  exposure: { webmcp: false },
  input: v.object({}),
  execute: (figma) => {
    return figma.viewport
  }
})

export const viewportSet = defineTool({
  name: 'viewport_set',

  description: 'Set viewport position and zoom.',
  execution: { kind: 'sync', mutation: 'view' },
  input: v.object({
    x: toolNumber(v.pipe(v.number(), v.description('Center X'))),
    y: toolNumber(v.pipe(v.number(), v.description('Center Y'))),
    zoom: toolNumber(v.pipe(v.number(), v.minValue(0.01), v.description('Zoom level')))
  }),
  execute: (figma, { x, y, zoom }) => {
    figma.viewport = { center: { x, y }, zoom }
    return { x, y, zoom }
  }
})

export const viewportZoomToFit = defineTool({
  name: 'viewport_zoom_to_fit',

  description: 'Zoom viewport to fit specified nodes.',
  execution: { kind: 'sync', mutation: 'view' },
  input: v.object({
    ids: v.pipe(v.array(v.string()), v.minLength(1), v.description('Node IDs to fit in view'))
  }),
  execute: (figma, { ids }) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const targets: FigmaNodeProxy[] = []
    for (const id of ids) {
      const node = figma.getNodeById(id)
      if (!node) continue
      const bounds = node.absoluteBoundingBox
      minX = Math.min(minX, bounds.x)
      minY = Math.min(minY, bounds.y)
      maxX = Math.max(maxX, bounds.x + bounds.width)
      maxY = Math.max(maxY, bounds.y + bounds.height)
      targets.push(node)
    }
    if (targets.length === 0) return { error: 'No valid nodes found' }
    // 走 figma-api 的 scrollAndZoomIntoView：复用其 fit 算法（padding 80、
    // min(viewW/contentW, viewH/contentH, 1)）——原先写死 zoom: 1，"fit" 名不副实；
    // 且写 _viewport 后由 onViewportChange 回写编辑器 store（桥上下文）。
    figma.viewport.scrollAndZoomIntoView(targets)
    const { center, zoom } = figma.viewport
    return {
      center,
      zoom,
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    }
  }
})
