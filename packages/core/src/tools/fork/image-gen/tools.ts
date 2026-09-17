/**
 * T54（Phase 3 W2/T-B3）：generate_image 落图段 core ToolDef（桥可调）。
 *
 * 双段执行（S3 §4 / 01 B.3 裁决 2）：AI 可见的 generate_image 在 pi-backend
 * 进程执行（provider HTTP 直发、凭证不出后端）；这两个 core 工具是落图段的
 * 桥端点——图像字节经桥进出（base64），凭证永不进桥 payload。
 *
 * 不对 AI 直接暴露：T72 起以机器可读标记落地（现形：`exposure` 三面全关）
 * ——agent 工具集（pi-backend tools.ts 按 isToolExposed(def,'ai') 过滤）与
 * MCP 注册面按此过滤；桥执行面不过滤（编排器经 bridge RPC 按名调用，
 * tool-handlers.ts 的 ALL_TOOLS 分发不受影响）。
 */

import * as v from 'valibot'

import { decodeBase64, encodeBase64 } from '#core/bytes'
import { defineTool } from '#core/tools/schema'

import { beginImageGen, commitImageGen } from './apply'
import { parseReferences, type ImageGenReference } from './requests'

export const imageGenBegin = defineTool({
  name: 'image_gen_begin',
  execution: { kind: 'async', mutation: 'document' },
  // T72：注册面机器可读过滤（agent 工具集 / MCP 均不透出）
  exposure: { ai: false, mcp: false, webmcp: false },
  description:
    'INTERNAL pipeline segment — called by the pi-backend generate_image orchestrator, not meant for direct AI use. Resolves the output target (creating and auto-placing a new frame when no valid replace target is given), extracts reference images (base64), and reports the final API size. Pair with image_gen_commit after the backend has generated the image bytes.',
  input: v.object({
    prompt: v.pipe(v.string(), v.description('Generation prompt')),
    width: v.optional(
      v.pipe(v.number(), v.description('Requested width (raw; normalized for the API call)'))
    ),
    height: v.optional(
      v.pipe(v.number(), v.description('Requested height (raw; normalized for the API call)'))
    ),
    replace_id: v.optional(
      v.pipe(v.string(), v.description('Existing node whose fill gets replaced'))
    ),
    references: v.optional(
      v.pipe(
        v.string(),
        v.description('JSON array of node ids or {"id":"...","composite":true} entries')
      )
    )
  }),
  execute: async (figma, { prompt, width, height, replace_id, references }) => {
    let rawRefs: unknown
    if (references !== undefined) {
      try {
        rawRefs = JSON.parse(references)
      } catch {
        return { error: 'Invalid JSON in references' }
      }
    }
    const refs = parseReferences(rawRefs)
    if ('error' in refs) return { error: refs.error }
    try {
      const beginOpts: {
        prompt: string
        width?: number
        height?: number
        replaceId?: string
        references?: ImageGenReference[]
      } = { prompt }
      if (width !== undefined) beginOpts.width = width
      if (height !== undefined) beginOpts.height = height
      if (replace_id) beginOpts.replaceId = replace_id
      if (refs.length > 0) beginOpts.references = refs
      const result = await beginImageGen(figma, beginOpts)
      return {
        id: result.targetId,
        width: result.width,
        height: result.height,
        canvasWidth: result.canvasWidth,
        canvasHeight: result.canvasHeight,
        replaced: result.replaced,
        images: result.images.map((bytes) => encodeBase64(bytes)),
        ...(result.note ? { note: result.note } : {})
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
})

export const imageGenCommit = defineTool({
  name: 'image_gen_commit',
  execution: { kind: 'sync', mutation: 'document' },
  exposure: { ai: false, mcp: false, webmcp: false },
  description:
    'INTERNAL pipeline segment — called by the pi-backend generate_image orchestrator, not meant for direct AI use. Writes generated image bytes (base64) into the target node resolved by image_gen_begin, snapshotting the previous image into the page generation-history container first (only IMAGE fills; same-hash dedupe).',
  input: v.object({
    id: v.pipe(v.string(), v.description('Target node id from image_gen_begin')),
    image_data: v.pipe(v.string(), v.description('Base64-encoded generated image bytes'))
  }),
  execute: (figma, { id, image_data }) => {
    return commitImageGen(figma, id, decodeBase64(image_data))
  }
})
