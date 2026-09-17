/**
 * T54（Phase 3 W2/T-B3）：generate_image 画布侧编排——自 open-pencil 仓
 * feature/agent-backend @ 5d38aa4e 的 tools/image-gen/apply.ts 移植，
 * 按 S3 §4 双段执行拓扑拆为 begin/commit 两半（01 B.3 裁决 2）：
 *
 *   beginImageGen  —— protectedRedirect 误传保护 → 参考图提取三规则 +
 *                     `[image N]` 错位防护 → 目标解析（新帧放置走
 *                     placement.ts，每次调用重读页面 bounds，00 #10 修复）
 *   [pi-backend 段]  provider HTTP 生图（凭证不出后端进程，不经桥）
 *   commitImageGen —— snapshotBeforeOverwrite 覆盖前快照（仅 IMAGE fill、
 *                     同 hash 去重，history.ts）→ 写入 IMAGE fill
 *
 * 拆段理由：provider HTTP 必须在 pi-backend 进程执行（key 不进桥 payload），
 * 画布操作必须经 7600 桥在编辑器进程执行——源的 generateOne 因此被切成
 * 两个桥可调段。begin 在生图前建帧（与源同序：帧先建，生图失败留空帧，
 * 由结果 error 标注）；commit 在生图成功后写 fill。
 *
 * `references` 语义与源一致：唯一输入图源；replace_id 唯一输出目标，
 * 永不隐式贡献像素。EDIT = replace_id + 自身 id 进 references；
 * REGENERATE = replace_id 但 references 不含目标。
 */

import type { Fill, SceneNode } from '@open-pencil/scene-graph'

import type { FigmaAPI } from '#core/figma-api'
import { findPlacementPosition } from '#core/tools/fork/placement'

import { isInImageHistory, snapshotBeforeOverwrite, type HistorySnapshot } from './history'
import type { ImageGenReference, ImageGenRequest } from './requests'
import { normalizeSize } from './requests'

const IMAGE_MARKER_RE = /\[image\s+\d+\]/i

/** Upload image bytes and build an IMAGE fill (FILL scale mode) for them */
function createImageFill(figma: FigmaAPI, bytes: Uint8Array): Fill {
  const image = figma.createImage(bytes)
  return {
    type: 'IMAGE',
    color: { r: 1, g: 1, b: 1, a: 1 },
    imageHash: image.hash,
    imageScaleMode: 'FILL',
    visible: true,
    opacity: 1
  }
}

function allReferencesFailedError(figma: FigmaAPI, skipped: string[]): Error {
  // Distinguish "node not found" from "node exists but could not provide
  // pixels" — the latter means no IMAGE fill AND no render capability here.
  const unrenderable = skipped.filter((id) => figma.getNodeById(id) !== null)
  let hint = ''
  if (unrenderable.length > 0) {
    const plural = unrenderable.length > 1
    hint = ` — tip: ${plural ? 'these nodes have' : 'this node has'} no IMAGE fill and could not be rendered as a reference (exportImage is unavailable in this environment)`
  }
  return new Error(`Failed to extract all reference image(s): ${skipped.join(', ')}${hint}`)
}

function visibleImageHash(node: SceneNode): string | undefined {
  for (const fill of node.fills) {
    if (fill.type === 'IMAGE' && fill.visible && 'imageHash' in fill) {
      return fill.imageHash
    }
  }
  return undefined
}

async function renderNode(figma: FigmaAPI, nodeId: string): Promise<Uint8Array | null> {
  if (!figma.exportImage) return null
  return figma.exportImage([nodeId], { scale: 1, format: 'PNG' })
}

interface ExtractedImage {
  bytes: Uint8Array | null
  /** Just-in-time usage hint surfaced in the result note (no behavior change) */
  teach?: string
}

/**
 * Extraction semantics per node shape（参考图提取三规则）:
 * - `composite: true` → always the node's rendered appearance (children,
 *   effects, rounded corners included); redundant on plain image nodes —
 *   said so in `teach`.
 * - IMAGE fill, no flag → the original bytes (lossless); children, if any,
 *   are NOT included — said so in `teach`.
 * - No IMAGE fill → rendering is the only sensible extraction, automatic.
 */
async function extractReferenceImage(
  figma: FigmaAPI,
  ref: ImageGenReference
): Promise<ExtractedImage> {
  const raw = figma.graph.getNode(ref.id)
  if (!raw) return { bytes: null }
  const imageHash = visibleImageHash(raw)

  if (ref.composite) {
    const bytes = await renderNode(figma, ref.id)
    if (imageHash && raw.childIds.length === 0) {
      return {
        bytes,
        teach: `reference ${ref.id} ("${raw.name}") already holds a plain image — drop "composite" to use its lossless original bytes`
      }
    }
    return { bytes }
  }

  if (imageHash) {
    const bytes = figma.graph.images.get(imageHash) ?? null
    if (raw.childIds.length > 0) {
      return {
        bytes,
        teach: `reference ${ref.id} ("${raw.name}") contributed only its image bytes — its ${raw.childIds.length} child node(s) (text/decoration) were NOT included; pass "composite":true to reference the full appearance`
      }
    }
    return { bytes }
  }

  return { bytes: await renderNode(figma, ref.id) }
}

interface ProtectedRedirect {
  note: string
  fallbackSize: { width: number; height: number }
}

/**
 * Soft guard against mistaken overwrite targets: history snapshots are
 * frozen records. Instead of failing the call, the caller falls back to
 * generating a NEW node and leaves the protected node untouched — the note
 * tells the agent what happened. Returns undefined when the target may be
 * overwritten normally.
 */
export function protectedRedirect(figma: FigmaAPI, nodeId: string): ProtectedRedirect | undefined {
  const raw = figma.graph.getNode(nodeId)
  if (!raw) return undefined
  let protectedAs: string | undefined
  if (isInImageHistory(figma.graph, raw.id)) {
    protectedAs = 'a generation-history snapshot'
  }
  if (!protectedAs) return undefined
  return {
    note: `Node ${nodeId} ("${raw.name}") is ${protectedAs} and was NOT overwritten — the image was generated as a new canvas node instead, sized like the protected node. To iterate on that image, pass its node id in "references" and omit "replace_id" (or target a normal node).`,
    fallbackSize: { width: Math.round(raw.width), height: Math.round(raw.height) }
  }
}

export interface ExtractedReferences {
  images: Uint8Array[]
  note?: string
}

export async function extractReferenceImages(
  figma: FigmaAPI,
  references: ImageGenReference[],
  prompt: string
): Promise<ExtractedReferences> {
  const images: Uint8Array[] = []
  const skipped: string[] = []
  const teachings: string[] = []
  for (const ref of references) {
    const { bytes, teach } = await extractReferenceImage(figma, ref)
    if (bytes) images.push(bytes)
    else skipped.push(ref.id)
    if (teach) teachings.push(teach)
  }

  if (references.length > 0) {
    // A prompt with [image N] markers misaligns silently when any image drops
    // out — fail loudly instead of letting the model edit the wrong image.
    if (skipped.length > 0 && IMAGE_MARKER_RE.test(prompt)) {
      throw new Error(
        `Failed to extract reference image(s): ${skipped.join(', ')} — the prompt contains [image N] markers that would misalign; fix the references and retry`
      )
    }
    if (images.length === 0) {
      throw allReferencesFailedError(figma, skipped)
    }
  }
  const noteParts = [
    skipped.length > 0
      ? `Used ${images.length}/${references.length} reference image(s); skipped: ${skipped.join(', ')}`
      : '',
    ...teachings
  ].filter(Boolean)
  const note = noteParts.join(' ') || undefined
  return note ? { images, note } : { images }
}

type NodeProxy = NonNullable<ReturnType<FigmaAPI['getNodeById']>>

interface ResolvedOutput {
  target: NodeProxy
  replaced: boolean
  finalWidth: number
  finalHeight: number
}

/**
 * Resolve the output node: the requested target, or a fresh frame when there
 * is no target (or the target was protected-redirected). New frames are created
 * at the request's RAW dimensions — 16px alignment and edge/ratio/pixel clipping
 * are provider/API constraints and apply only to finalWidth/finalHeight (the
 * generation-call size), never to the canvas node. Requests without an explicit
 * size inherit the target node's real dimensions (normalized) for the API size.
 */
function resolveOutputTarget(
  figma: FigmaAPI,
  req: ImageGenRequest,
  redirect: ProtectedRedirect | undefined
): ResolvedOutput {
  let target = req.replaceId && !redirect ? figma.getNodeById(req.replaceId) : null
  const replaced = !!target
  if (!target) {
    const fallbackSize = redirect?.fallbackSize
    // Read the placement position BEFORE creating the frame so the new node
    // itself does not inflate the page bounds; findPlacementPosition always
    // reads fresh (00 #10: batch loops must not hoist this call).
    const frameWidth = req.width ?? fallbackSize?.width ?? 1024
    const frameHeight = req.height ?? fallbackSize?.height ?? 1024
    const position = findPlacementPosition(figma, { width: frameWidth, height: frameHeight })
    target = figma.createFrame()
    target.resize(frameWidth, frameHeight)
    target.x = position.x
    target.y = position.y
    target.name = req.prompt.slice(0, 40) || 'Generated image'
  }

  let finalWidth = req.width ?? 1024
  let finalHeight = req.height ?? 1024
  if (req.width !== undefined && req.height !== undefined) {
    // 显式尺寸：节点已按原始请求值创建，此处只为生图调用归一出 API size
    const normalized = normalizeSize(req.width, req.height)
    if (!('error' in normalized)) {
      finalWidth = normalized.width
      finalHeight = normalized.height
    }
  } else {
    const normalized = normalizeSize(Math.round(target.width), Math.round(target.height))
    if (!('error' in normalized)) {
      finalWidth = normalized.width
      finalHeight = normalized.height
    }
  }
  return { target, replaced, finalWidth, finalHeight }
}

export interface ImageGenBeginResult {
  /** Output node: the requested replace target, or a freshly created frame */
  targetId: string
  /** Final API size (16px-aligned/clamped; explicit dims normalized, else the target's) */
  width: number
  height: number
  canvasWidth: number
  canvasHeight: number
  /** True when filling an existing node (false for a new frame / protected redirect) */
  replaced: boolean
  /** Extracted reference bytes, in references order */
  images: Uint8Array[]
  note?: string
}

/**
 * Begin 段（桥可调）：误传保护 → 参考图提取 → 目标解析。新图请求在此创建
 * 帧——放置每次重读页面 bounds（批量时由后端编排串行调 begin，见
 * placement.ts 头注）。参考图提取失败（含 [image N] 错位防护）抛错，
 * 由 tools.ts 包装为 {error}。
 */
export async function beginImageGen(
  figma: FigmaAPI,
  req: ImageGenRequest
): Promise<ImageGenBeginResult> {
  const redirect = req.replaceId ? protectedRedirect(figma, req.replaceId) : undefined

  const { images, note: skippedNote } = await extractReferenceImages(
    figma,
    req.references ?? [],
    req.prompt
  )
  const note = [redirect?.note, skippedNote].filter(Boolean).join(' ') || undefined

  const { target, replaced, finalWidth, finalHeight } = resolveOutputTarget(figma, req, redirect)

  return {
    targetId: target.id,
    width: finalWidth,
    height: finalHeight,
    canvasWidth: Math.round(target.width),
    canvasHeight: Math.round(target.height),
    replaced,
    images,
    ...(note ? { note } : {})
  }
}

export interface ImageGenCommitResult {
  id: string
  canvasWidth: number
  canvasHeight: number
  snapshot?: HistorySnapshot
}

/**
 * Commit 段（桥可调）：覆盖前快照（snapshotBeforeOverwrite 自带「仅 IMAGE
 * fill 才快照 + 同 hash 去重」闸门——新帧无 IMAGE fill 天然不快照，与源
 * `req.replaceId ? snapshot : undefined` 的净效果一致）→ 写入 IMAGE fill。
 * 目标在 begin→commit 间隙被删 → {error}（生图字节已由后端持有，可换目标重试）。
 */
export function commitImageGen(
  figma: FigmaAPI,
  targetId: string,
  bytes: Uint8Array
): ImageGenCommitResult | { error: string } {
  const target = figma.getNodeById(targetId)
  if (!target) {
    return {
      error: `Node "${targetId}" not found — it was deleted between image generation and placement; retry without replace_id to place as a new node`
    }
  }

  // Preserve the superseded content BEFORE writing the new fill, so no
  // version is ever lost (and a mistaken target stays recoverable).
  const snapshot = snapshotBeforeOverwrite(figma.graph, target.id)

  target.fills = [createImageFill(figma, bytes)]

  return {
    id: target.id,
    canvasWidth: Math.round(target.width),
    canvasHeight: Math.round(target.height),
    ...(snapshot ? { snapshot } : {})
  }
}
