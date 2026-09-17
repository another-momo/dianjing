/**
 * prepare_hero_scaffold ToolDef（T57，S3 §7）：标题前置克隆源 + 几何记录落盘。
 *
 * 与源仓（feature/agent-backend @ 5d38aa4e）的差异：
 * - hero_bleed 更名 underlap_px（无别名）；新增 transition_zone_px 参数
 *   （> underlap 时钳到 underlap，结果带 clamped: true）。
 * - 克隆源显式传 source_node_id，不再扫描 HeroContent。
 * - 信封 note 只带事实；旧「Next: generate_image … compose_backdrop …」
 *   指令链删除不移植。
 *
 * 集成纪律：FORK_TOOLS / pi-backend 暴露面由主 agent 统一接线，本数组是唯一交付面。
 */

import * as v from 'valibot'

import { defineTool, type ToolDef } from '#core/tools/schema'

import {
  DEFAULT_TRANSITION_ZONE_PX,
  DEFAULT_UNDERLAP_PX,
  MAX_UNDERLAP_PX,
  prepareHeroScaffold
} from './hero-scaffold'

export const prepareHeroScaffoldTool = defineTool({
  name: 'prepare_hero_scaffold',
  execution: { kind: 'sync', mutation: 'document' },
  exposure: { mcp: false, webmcp: false },
  description:
    "Pixel-first hero pipeline, step 1: clone the ALREADY-RENDERED headline layout (source_node_id — the headline is locked before any skeleton exists, so this tool never scans for a HeroContent slot) into a temporary scaffold frame sized exactly like the final hero image (source width × source height + underlap_px), placed as a page-level sibling to the RIGHT of existing page content (never inside the root — a hug-height root would be inflated). The scaffold carries a geometry record ({width, height, underlapPx, transitionZonePx} in pluginData) that compose_backdrop reads later instead of loose params — call prepare_hero_scaffold BEFORE compose_backdrop and pass the same underlap_px you intend for the final hero. transition_zone_px (soft blend band at the hero bottom) is clamped to underlap_px when larger — the result then carries clamped: true. Clone coordinates are copied verbatim (the source occupies the scaffold's top source-height px, no conversion needed). Idempotent: re-call after the copy changed to refresh the geometry record and re-clone the children; an already-generated IMAGE fill on the scaffold is preserved, otherwise fills reset to white.",
  input: v.object({
    root_id: v.pipe(
      v.string(),
      v.description(
        'Node id of the root frame (the long-image canvas). Structural check only: must be a FRAME with auto-layout (layoutMode ≠ NONE).'
      )
    ),
    source_node_id: v.pipe(
      v.string(),
      v.description(
        'Node id of the already-rendered headline layout frame — its children are deep-cloned verbatim into the scaffold. Must be a FRAME with at least one child.'
      )
    ),
    underlap_px: v.optional(
      v.pipe(
        v.number(),
        v.minValue(0),
        v.maxValue(MAX_UNDERLAP_PX),
        v.description(
          'How many pixels the final hero image extends PAST the headline slot (default 100, max 1000). The scaffold is source height + underlap tall; the cloned copy occupies its top source-height px.'
        )
      ),
      DEFAULT_UNDERLAP_PX
    ),
    transition_zone_px: v.optional(
      v.pipe(
        v.number(),
        v.minValue(0),
        v.description(
          'Height of the soft blend band at the hero bottom (default 100). Clamped to underlap_px when larger.'
        )
      ),
      DEFAULT_TRANSITION_ZONE_PX
    )
  }),
  execute: (figma, args) =>
    prepareHeroScaffold(figma, {
      rootId: args.root_id,
      sourceNodeId: args.source_node_id,
      underlapPx: args.underlap_px,
      transitionZonePx: args.transition_zone_px
    })
})

/** 集成纪律：FORK_TOOLS / pi-backend 暴露面由主 agent 统一接线，本数组是唯一交付面 */
export const HERO_TOOLS: ToolDef[] = [prepareHeroScaffoldTool]
