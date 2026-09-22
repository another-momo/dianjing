/**
 * look（T55 / S3 §5）——AI 的「看图」工具，通道 A（base64 进主对话）。
 *
 * 移植自 open-pencil 仓 feature/agent-backend @ 5d38aa4e
 * packages/core/src/tools/marketing/look.ts，差异：
 * - 通道 B（独立视觉模型侧信道）不建、不留桩（S3 §1：侧信道=后续任务）。
 * - 三档导出模式自动选择与缩放策略原样保留。
 * - 返回结构字段化：base64/mimeType/byteLength + 节点元数据（node/exportInfo），
 *   供 pi-backend 媒体登记层（src/app/ai/pi-backend/media-output.ts）识别并转媒体块。
 */

import * as v from 'valibot'

import type { Fill, SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import type { Color } from '@open-pencil/scene-graph/primitives'

import { detectImageMime, encodeBase64 } from '#core/bytes'
import { isRendererDead } from '#core/canvas'
import type { TileWorldBounds } from '#core/canvas/renderer/tiles/geometry'
import type { FigmaAPI } from '#core/figma-api'
import { computeContentBounds } from '#core/io/formats/raster/render'
import { defineTool } from '#core/tools/schema'

const MAX_LONG_EDGE = 1024
const MIN_EXPORT_LONG_EDGE = 512
const MAX_UPSCALE = 4
const CONTEXT_MARGIN = 48
const NEAR_WHITE_LUMINANCE = 0.92
const MIN_LEGIBLE_TEXT_PX = 12
const JPEG_QUALITY = 80
const MAX_DRILL_DEPTH = 2
const MAX_DRILL_TARGETS = 5
const MAX_DRILL_NAME = 40

type ExportMode = 'original-bytes' | 'isolated' | 'in-context'

interface ExportInfo {
  mode: ExportMode
  scale?: number
  upscaled?: boolean
}

// T98：与上游 TileWorldBounds（canvas/renderer/tiles/geometry.ts）同形——
// no-duplicate-type-shapes 要求同构对象类型收敛，别名复用而非重复声明。
type ClipRect = TileWorldBounds

function fillLuminance(color: Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

/**
 * Effective luminance of a fill composited over white: a faint 50%-opacity
 * gray reads as light gray on the blank isolated background, so opacity
 * must fold into the near-white check, not just the raw fill color.
 */
function effectiveLuminanceOverWhite(fill: Fill): number {
  return 1 - fill.opacity * (1 - fillLuminance(fill.color))
}

/**
 * Structural preflight: an isolated export paints the node on a blank
 * background (white for JPG), so two node shapes are guaranteed-unreadable
 * there and must be exported IN CONTEXT instead:
 * - nodes with no visible fill of their own — their content floats on
 *   whatever paints beneath them in the design (e.g. a transparent
 *   HeroContent frame whose white title sits over the BackgroundLayer);
 * - near-white text — designed against a dark image, invisible on white.
 */
function needsContextExport(node: SceneNode): boolean {
  const own = node.fills.filter((f) => f.visible && f.opacity > 0)
  if (own.length === 0) return true
  if (node.type === 'TEXT') {
    return own.every(
      (f) => f.type === 'SOLID' && effectiveLuminanceOverWhite(f) >= NEAR_WHITE_LUMINANCE
    )
  }
  return false
}

/** The node's design root: topmost ancestor below the CANVAS page. */
function designRootId(graph: SceneGraph, node: SceneNode): string | undefined {
  let current = node
  while (current.parentId) {
    const parent = graph.getNode(current.parentId)
    if (!parent || parent.type === 'CANVAS') return current.id
    current = parent
  }
  return undefined
}

/**
 * The in-context output window: the target's visual bounds plus a margin of
 * its surroundings, clamped to the design root so the export never shows
 * bare page canvas outside the design.
 */
function contextClip(graph: SceneGraph, rootId: string, targetId: string): ClipRect | null {
  const target = computeContentBounds(graph, [targetId])
  const root = computeContentBounds(graph, [rootId])
  if (!target || !root) return null
  return {
    minX: Math.max(target.minX - CONTEXT_MARGIN, root.minX),
    minY: Math.max(target.minY - CONTEXT_MARGIN, root.minY),
    maxX: Math.min(target.maxX + CONTEXT_MARGIN, root.maxX),
    maxY: Math.min(target.maxY + CONTEXT_MARGIN, root.maxY)
  }
}

/** Big designs scale down to [0.1, 1]; small nodes upscale toward the minimum legible edge (capped). */
function exportScale(longEdge: number): { scale: number; upscaled: boolean } {
  if (longEdge > 0 && longEdge < MIN_EXPORT_LONG_EDGE) {
    return { scale: Math.min(MAX_UPSCALE, MIN_EXPORT_LONG_EDGE / longEdge), upscaled: true }
  }
  const scale = longEdge > 0 ? Math.max(0.1, Math.min(1, MAX_LONG_EDGE / longEdge)) : 1
  return { scale, upscaled: false }
}

/**
 * When the target is a plain image bearer (a single visible IMAGE fill —
 * pasted images, brief material slots), hand the model the original bytes
 * instead of a render. The canvas presentation shrinks (brief slots render
 * at 143px) and crops (FILL into fixed squares) the image, destroying detail
 * and orientation cues the model is explicitly asked to judge.
 */
function originalImageData(
  figma: FigmaAPI,
  node: SceneNode
): { data: Uint8Array; mimeType: string } | null {
  const { fills } = node
  if (!Array.isArray(fills) || fills.length !== 1) return null
  const fill = fills[0]
  if (fill.type !== 'IMAGE' || !fill.visible || !fill.imageHash) return null
  const data = figma.graph.images.get(fill.imageHash)
  return data ? { data, mimeType: detectImageMime(data) } : null
}

/**
 * Breadth-first TEXT-node drill targets for the legibility note, limited in
 * depth and count so large designs don't bloat the note.
 */
function collectDrillTargets(
  graph: SceneGraph,
  rootId: string
): { targets: string[]; total: number } {
  const targets: string[] = []
  let total = 0
  let frontier = graph.getChildren(rootId)
  for (let depth = 0; depth < MAX_DRILL_DEPTH; depth++) {
    const next: SceneNode[] = []
    for (const child of frontier) {
      if (child.type === 'TEXT') {
        total++
        if (targets.length < MAX_DRILL_TARGETS) {
          const name = child.name.trim()
          const label = name.length > MAX_DRILL_NAME ? `${name.slice(0, MAX_DRILL_NAME)}…` : name
          targets.push(label ? `${child.id} (${label})` : child.id)
        }
      } else {
        next.push(...graph.getChildren(child.id))
      }
    }
    frontier = next
  }
  return { targets, total }
}

function minFontSizeInSubtree(graph: SceneGraph, rootId: string): number | undefined {
  let min: number | undefined
  const stack: string[] = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) break
    const node = graph.getNode(id)
    if (!node) continue
    if (node.type === 'TEXT' && (min === undefined || node.fontSize < min)) {
      min = node.fontSize
    }
    for (const childId of node.childIds) stack.push(childId)
  }
  return min
}

function addTextLegibilityNote(
  graph: SceneGraph,
  targetId: string,
  scale: number,
  noteParts: string[]
): void {
  const minFontSize = minFontSizeInSubtree(graph, targetId)
  if (minFontSize === undefined) return
  const minTextPx = minFontSize * scale
  if (minTextPx >= MIN_LEGIBLE_TEXT_PX) return
  noteParts.push(
    `You can judge layout proportions, visual weight, and color distribution from this image. ⚠ Text renders at ~${Math.round(minTextPx)}px here — too small to read; do not judge text content or legibility from it.`
  )
  const { targets, total } = collectDrillTargets(graph, targetId)
  if (targets.length > 0) {
    const more =
      total > targets.length ? ` — and ${total - targets.length} more, look specific ids` : ''
    noteParts.push(
      `To inspect text, look at these text nodes individually: ${targets.join(' / ')}${more}.`
    )
  }
}

/**
 * Render the node to JPEG bytes for inspection. Nodes whose appearance
 * depends on what paints beneath them would export as white-on-white in
 * isolation — they export composited in their design context, clipped to
 * their bounds plus a margin. The design root itself stays isolated: its
 * context is the bare page.
 */
async function renderNodeForInspection(
  figma: FigmaAPI,
  targetId: string,
  node: SceneNode,
  noteParts: string[]
): Promise<
  { error: string } | { image: { data: Uint8Array; mimeType: string }; exportInfo: ExportInfo }
> {
  if (!figma.exportImage) {
    return { error: 'Visual inspection is not available in this environment' }
  }
  const rootId = designRootId(figma.graph, node)
  const clip =
    rootId !== undefined && rootId !== node.id && needsContextExport(node)
      ? contextClip(figma.graph, rootId, node.id)
      : null
  const exportW = clip ? clip.maxX - clip.minX : node.width
  const exportH = clip ? clip.maxY - clip.minY : node.height
  const { scale, upscaled } = exportScale(Math.max(exportW, exportH))
  const exportInfo: ExportInfo = {
    mode: clip ? 'in-context' : 'isolated',
    scale,
    ...(upscaled ? { upscaled: true } : {})
  }

  if (clip) {
    noteParts.push(
      `Visual inspection of "${node.name}" (${node.width}×${node.height}) composited in its design context — the node has no opaque background of its own, so the export shows it plus a ~${CONTEXT_MARGIN}px band of what paints beneath/above it in the design.`
    )
  } else {
    noteParts.push(
      `Visual inspection of "${node.name}" (${node.width}×${node.height}, exported at ${Math.round(scale * 100)}%).`
    )
  }
  if (upscaled) {
    const capped = scale === MAX_UPSCALE ? ` (capped at ×${MAX_UPSCALE})` : ''
    noteParts.push(
      `Upscaled ×${scale.toFixed(2)}${capped} toward the ${MIN_EXPORT_LONG_EDGE}px minimum legible edge — slight softness is a resampling artifact, not a design property.`
    )
  }
  if (exportW > 4 * exportH || exportH > 4 * exportW) {
    noteParts.push(
      'Aspect ratio distorted at this scale — judge colors and presence, not proportions.'
    )
  }
  addTextLegibilityNote(figma.graph, targetId, scale, noteParts)

  const exportOptions: {
    scale: number
    format: 'JPG'
    quality: number
    renderInContext?: boolean
    clip?: ClipRect
  } = {
    scale,
    format: 'JPG',
    quality: JPEG_QUALITY
  }
  if (clip) {
    exportOptions.renderInContext = true
    exportOptions.clip = clip
  }
  const data = await figma.exportImage([targetId], exportOptions)
  if (!data || data.length === 0) {
    if (!node.visible || node.width <= 0 || node.height <= 0) {
      return {
        error: `Nothing visible to inspect — "${node.name}" is hidden or has zero width/height.`
      }
    }
    return {
      error:
        'Image export returned empty bytes for a visible node — the render pipeline failed (often transient memory pressure), this is not an empty design. Retry the call; if it persists, restart the app to recover the renderer.'
    }
  }
  return { image: { data, mimeType: 'image/jpeg' }, exportInfo }
}

export const lookTool = defineTool({
  name: 'look',
  execution: { kind: 'async', mutation: 'none' },
  exposure: { mcp: false, webmcp: false },
  description:
    'Visually inspect a node by rendering it to an image you can actually see. Use for questions describe cannot answer: text over busy backgrounds, visual style consistency, generated-image content (e.g. garbled text in AI images), or what a user-provided image shows. For text legibility on a large design, look at the section or text-bearing child node, not the root — the tool tells you when text is too small to read and lists child node ids to drill into. Nodes whose appearance depends on their surroundings (transparent frames, light text over images) are automatically rendered in their design context, and small nodes are upscaled to a legible size — both declared in the note. Observations are advisory — structural concerns (layout, hierarchy, alignment) come from `describe`; what the eye sees is not a substitute.',
  input: v.object({
    id: v.pipe(
      v.string(),
      v.description(
        'Node id to inspect — e.g. the design root frame id returned by setup_design, or an imageNodeId from brief material entries.'
      )
    ),
    focus: v.optional(
      v.pipe(
        v.string(),
        v.description(
          'What to check this time, e.g. "text readability", "consistency with locked palette", "what does this image show"'
        )
      )
    )
  }),
  execute: async (figma, { id, focus }) => {
    if (typeof id !== 'string' || !id) {
      return {
        error: 'Pass an explicit node id — the design root frame id is returned by setup_design'
      }
    }
    const targetId = id

    // Fail fast on a dead renderer: any render call would just throw and
    // burn the caller's turn. Tell the model to ask the user to save and
    // restart so the canvas can be re-created cleanly.
    if (isRendererDead()) {
      return {
        error:
          'The canvas renderer has crashed and cannot produce images right now. Ask the user to save the document and restart the app to recover.'
      }
    }

    const node = figma.graph.getNode(targetId)
    if (!node) return { error: `Node "${targetId}" not found` }

    const nodeInfo = { id: targetId, name: node.name, width: node.width, height: node.height }
    const noteParts: string[] = []

    let image: { data: Uint8Array; mimeType: string }
    let exportInfo: ExportInfo
    const original = originalImageData(figma, node)
    if (original) {
      noteParts.push(
        `Original image bytes of "${node.name}" at full resolution — on canvas it appears as ${node.width}×${node.height}, possibly cropped or scaled. Judge the image itself, not its canvas presentation.`
      )
      image = original
      exportInfo = { mode: 'original-bytes' }
    } else {
      const rendered = await renderNodeForInspection(figma, targetId, node, noteParts)
      if ('error' in rendered) return { error: rendered.error }
      image = rendered.image
      exportInfo = rendered.exportInfo
    }

    if (focus) noteParts.push(`Focus: ${focus}.`)

    return {
      base64: encodeBase64(image.data),
      mimeType: image.mimeType,
      byteLength: image.data.length,
      channel: 'A' as const,
      node: nodeInfo,
      exportInfo,
      ...(focus ? { focus } : {}),
      note: noteParts.join(' ')
    }
  }
})
