/**
 * brief 三件套 ToolDef（T52，S3 §3）：create_brief / read_brief /
 * append_brief_conclusion。
 *
 * 与源仓（feature/agent-backend @ 5d38aa4e tools/marketing.ts）的差异：
 * - registry（WeakMap+clock）已删除，「活跃设计」尚不存在（T60 落地）——
 *   定位依据 = 可选 briefId 参数 > 当前页唯一 brief > 歧义结构，绝不静默取第一个。
 * - create_brief 幂等收窄：页上唯一 brief → {created:false}；多 brief 无定位
 *   依据 → {created:false, ambiguous:true, candidates}（不新建也不静默绑错）。
 * - 创建走共享 findPlacementPosition（页面 bounds 右侧 +100、y 跟随），
 *   创建后 scrollAndZoomIntoView。
 * - 错误契约 {error} / note 形态，不抛异常。
 */

import * as v from 'valibot'

import type { FigmaAPI } from '#core/figma-api'
import { findPlacementPosition } from '#core/tools/fork/placement'
import { defineTool } from '#core/tools/schema'

import {
  BRIEF_ESTIMATED_HEIGHT,
  BRIEF_WIDTH,
  appendToBriefAIZone,
  createBrief,
  findBrief,
  syncBriefDesignEntries
} from './brief'
import { readBrief, updateBriefContent } from './brief-edit'
import { BRIEF_TEXTS } from './texts'

/** Page (CANVAS) name owning a node — for reporting where a bound design lives. */
function pageNameOf(graph: FigmaAPI['graph'], nodeId: string): string | undefined {
  let current = graph.getNode(nodeId)
  while (current) {
    if (current.type === 'CANVAS') return current.name
    current = current.parentId ? graph.getNode(current.parentId) : undefined
  }
  return undefined
}

const AMBIGUOUS_NOTE =
  'Multiple 需求单 on this page and no briefId was given — ask the user which one to use (then pass briefId). Do NOT create another brief.'

export const readBriefTool = defineTool({
  name: 'read_brief',
  execution: { kind: 'sync', mutation: 'none' },
  exposure: { mcp: false, webmcp: false },
  description:
    'Read the 需求单 (design brief) in one call — content text, material entries (each with imageNodeId for `look`, caption, hasImage), AI conclusions (with per-design attribution), and the designs registered in its 关联设计区 (id + name/mode/type projections; deleted designs are tombstoned, not removed). Pass briefId when several briefs exist on the page; without it the page must contain exactly one brief, otherwise the result is { brief: null, ambiguous: true, candidates } — ask the user which brief to use, do NOT create another one. Returns { brief: null } when no brief exists — a normal state, not an error; the marketing workflow then creates one with create_brief. Prefer this over find_nodes + describe when looking for the brief.',
  input: v.object({
    briefId: v.optional(
      v.pipe(
        v.string(),
        v.description(
          'Brief frame id to read. Required when the page hosts several briefs (see the ambiguous result); omit when there is only one.'
        )
      )
    )
  }),
  execute: (figma, { briefId }) => {
    const graph = figma.graph
    const resolution = findBrief(figma, briefId)
    if (resolution.status === 'ambiguous') {
      return {
        brief: null,
        ambiguous: true,
        candidates: resolution.candidates,
        note: AMBIGUOUS_NOTE
      }
    }
    if (resolution.status === 'not-found') {
      return { brief: null, error: `Brief "${resolution.briefId}" not found on this document.` }
    }
    if (resolution.status === 'none') return { brief: null }

    const view = readBrief(figma, resolution.brief.id)
    if (!view) {
      return {
        brief: null,
        error:
          'The 需求单 exists but its structure is broken (a zone was deleted or predates zone markers) — ask the user whether to recreate it.'
      }
    }
    return {
      briefId: view.briefId,
      // T91a：从 view.designs（合并后的）按 registered:true 筛出 brief 权威绑定
      // 列表。`rootFrameId` 字段保留——这是 brief→design 的绑定证明，agent
      // 不需要，但保留便于老 prompt 兼容。`uniqueId` 字段同时输出供跨重启
      // 寻址。
      boundDesigns: view.designs
        .filter((d) => d.registered)
        .map((d) => ({
          rootFrameId: d.designId,
          uniqueId: d.uniqueId,
          name: graph.getNode(d.designId)?.name ?? BRIEF_TEXTS.deletedMark,
          page: pageNameOf(graph, d.designId) ?? null
        })),
      // T91a：designs 字段已合并 registered + unregistered 视图；每条带
      // uniqueId（跨持久化稳定寻址键）。
      designs: view.designs,
      content: view.content,
      materials: view.materials.map((material) => ({
        entryId: material.entryId,
        imageNodeId: material.imageNodeId,
        caption: material.caption,
        hasImage: material.imageHash !== null
      })),
      conclusions: view.conclusions
    }
  }
})

export const createBriefTool = defineTool({
  name: 'create_brief',
  execution: { kind: 'sync', mutation: 'document' },
  exposure: { mcp: false, webmcp: false },
  description:
    "Create a 需求单 (design brief) frame on the canvas with the four-zone structure (内容区 / 素材区 / AI结论区 / 关联设计区), placed to the right of existing content. The marketing workflow calls this directly when read_brief reports none exists — no need to ask the user first. Pass the user's original request verbatim as initial_content — it is transcribed into the content zone as-is (never embellished, paraphrased, or expanded); beyond that transcription the AI never invents brief content. Idempotent: when the page already has exactly one brief, nothing is created and the result is { briefId, created: false }. When the page has MULTIPLE briefs there is no way to tell which one to extend — the result is { created: false, ambiguous: true, candidates }; ask the user instead of creating yet another one.",
  input: v.object({
    initial_content: v.optional(
      v.pipe(
        v.string(),
        v.description(
          "The user's original request text, VERBATIM — seeded into the content zone so the brief captures the requirement as the user stated it. Never embellish or expand."
        )
      )
    )
  }),
  execute: (figma, { initial_content }) => {
    const resolution = findBrief(figma)
    if (resolution.status === 'ambiguous') {
      return {
        created: false,
        ambiguous: true,
        candidates: resolution.candidates,
        note: AMBIGUOUS_NOTE
      }
    }
    if (resolution.status === 'ok') return { briefId: resolution.brief.id, created: false }

    const position = findPlacementPosition(figma, {
      width: BRIEF_WIDTH,
      height: BRIEF_ESTIMATED_HEIGHT
    })
    const brief = createBrief(figma, position.x, position.y)
    if (typeof initial_content === 'string' && initial_content.trim()) {
      updateBriefContent(figma, brief.id, initial_content.trim())
    }
    const proxy = figma.getNodeById(brief.id)
    if (proxy) figma.viewport.scrollAndZoomIntoView([proxy])
    return { briefId: brief.id, created: true }
  }
})

export const appendBriefConclusionTool = defineTool({
  name: 'append_brief_conclusion',
  execution: { kind: 'sync', mutation: 'document' },
  exposure: { mcp: false, webmcp: false },
  description:
    'Append one confirmed conclusion line to the AI结论区 of the 需求单 (design brief) — locked direction, confirmed campaign facts, or a one-line material description. Styling and placement are handled automatically; pass only the conclusion text (one line, no leading "·"). Append-only by design: existing lines cannot be edited or removed. Pass design_id to attribute the line to that design (it lands in the design\'s own group); pass briefId when several briefs exist on the page, otherwise the result is { ok: false, ambiguous: true, candidates }. Returns { ok: false } when no brief exists — create one first with create_brief.',
  input: v.object({
    text: v.pipe(
      v.string(),
      v.description('One conclusion line, e.g. "方向A：水彩萌趣（嫩绿 #A8D5BA / 米白 #F5EFE0）".')
    ),
    briefId: v.optional(
      v.pipe(
        v.string(),
        v.description('Brief frame id — required when the page hosts several briefs.')
      )
    ),
    design_id: v.optional(
      v.pipe(
        v.string(),
        v.description(
          "Design root frame id this conclusion belongs to — the line is grouped under that design's name so one brief serving several designs keeps per-design conclusions."
        )
      )
    )
  }),
  execute: (figma, { text, briefId, design_id }) => {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, note: 'Pass the conclusion text.' }
    }
    const resolution = findBrief(figma, briefId)
    if (resolution.status === 'ambiguous') {
      return { ok: false, ambiguous: true, candidates: resolution.candidates, note: AMBIGUOUS_NOTE }
    }
    if (resolution.status === 'not-found') {
      return { ok: false, error: `Brief "${resolution.briefId}" not found on this document.` }
    }
    if (resolution.status === 'none') {
      return { ok: false, note: 'No 需求单 exists in this document.' }
    }
    const brief = resolution.brief
    // Mutating path: physically backfill designs-zone entries for designs whose
    // pointer targets this brief (read side surfaces them as registered:false).
    syncBriefDesignEntries(figma, brief.id)

    const designNode = design_id ? figma.graph.getNode(design_id) : undefined
    const design = designNode ? { id: designNode.id, name: designNode.name } : undefined
    const appended = appendToBriefAIZone(figma, brief.id, text.trim(), design)
    return appended
      ? { ok: true }
      : { ok: false, note: 'The brief exists but its AI结论区 could not be located.' }
  }
})
