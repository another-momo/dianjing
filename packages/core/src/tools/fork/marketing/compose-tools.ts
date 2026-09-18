/**
 * compose_backdrop ToolDef（T58，S3 §8）：消费 T57 几何记录的长图背景合成。
 *
 * 与源仓（feature/agent-backend tools/marketing/compose-backdrop.ts）的差异：
 * - canvas_width/hero_height/hero_bleed 散参删除——管线内几何只读 scaffold
 *   的 pluginData 几何记录（缺记录/畸形 → geometry_missing 引导回
 *   prepare_hero_scaffold）；外部来源从来源节点与根 frame 推导。
 * - 新增 scaffold_id / discard_hero 参数；隐式收养与 stray-image 侦测删除。
 * - 信封 note 只带事实 + WARNING；旧「Re-call…/Verify with look…」指令链
 *   删除不移植（归 workflow Fix Playbook）。
 *
 * 集成纪律：FORK_TOOLS / pi-backend 暴露面由主 agent 统一接线，本数组是唯一交付面。
 */

import * as v from 'valibot'

import { defineTool, type ToolDef } from '#core/tools/schema'

import { COMPOSE_TEXTS, composeBackdrop } from './compose-backdrop'

export const composeBackdropTool = defineTool({
  name: 'compose_backdrop',
  execution: { kind: 'async', mutation: 'document' },
  exposure: { mcp: false, webmcp: false },
  description: COMPOSE_TEXTS.toolDescription,
  input: v.object({
    root_id: v.pipe(v.string(), v.description(COMPOSE_TEXTS.paramRootId)),
    scaffold_id: v.optional(v.pipe(v.string(), v.description(COMPOSE_TEXTS.paramScaffoldId))),
    hero_image_from: v.optional(
      v.pipe(v.string(), v.description(COMPOSE_TEXTS.paramHeroImageFrom))
    ),
    discard_hero: v.optional(
      v.pipe(v.boolean(), v.description(COMPOSE_TEXTS.paramDiscardHero)),
      false
    ),
    canvas_height: v.optional(
      v.pipe(
        v.number(),
        v.minValue(200),
        v.maxValue(20000),
        v.description(COMPOSE_TEXTS.paramCanvasHeight)
      )
    ),
    hero_color: v.optional(v.pipe(v.string(), v.description(COMPOSE_TEXTS.paramHeroColor)))
  }),
  execute: (figma, args) =>
    composeBackdrop(figma, {
      rootId: args.root_id,
      scaffoldId: args.scaffold_id,
      heroImageFrom: args.hero_image_from,
      discardHero: args.discard_hero,
      canvasHeight: args.canvas_height,
      heroColor: args.hero_color
    })
})

/** 集成纪律：FORK_TOOLS / pi-backend 暴露面由主 agent 统一接线，本数组是唯一交付面 */
export const COMPOSE_TOOLS: ToolDef[] = [composeBackdropTool]
