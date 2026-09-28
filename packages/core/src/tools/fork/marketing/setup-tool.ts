/**
 * setup_design ToolDef（T53，S3 §2）：仅「新建」营销设计时调用。
 *
 * 2026-09-27 帧无身份（state-layering wave-2 §6.1/§6.3）：modeId / profileId
 * 参数与 catalog 注入缝（__catalog / __confirmedNewIntent）整体退役——
 * 规制 = 用户层 page-state 文档标量（确认门直写、装配注入 workflow），设计
 * 根不落盘身份，工具新建根帧为静默操作（无确认门、无 awaiting 信封）。
 * brief 按页服务；briefId 仍必填（findBrief 校验 + 关联登记）。
 */

import * as v from 'valibot'

import { defineTool, type ToolDef } from '#core/tools/schema'

import { setupDesign } from './setup'

/** setup_design 声明参数面 */
const setupDesignEntries = {
  briefId: v.pipe(
    v.string(),
    v.description(
      'Id of the 需求单 (design brief) on the current page this design serves — the new design is registered in its 关联设计区.'
    )
  ),
  canvas: v.optional(
    v.pipe(
      v.string(),
      v.description(
        // 14 条物料 id 别名清单——同步手动维护于 MATERIAL_SPECS（同 packages/core/src/tools/fork/marketing/material-specs.ts）；改库后此处需同改。
        'Canvas size override (optional) — pixels: "<width>x" (height grows with content) or "<width>x<height>" (fixed height), e.g. "750x" / "750x2000"; or a built-in material alias, e.g. "long-image" / "ig-square" / "ig-portrait" / "xhs-cover" / "wechat-cover" / "slides-16x9" / "x-post" / "x-header" / "story-9x16" / "ecommerce-main" / "youtube-thumbnail" / "link-card" / "bilibili-cover" / "a4-print". Unrecognized values return { error: "invalid_canvas" } with the material id list in the message, and nothing is created. Omit for the default long-image material (750 wide, height grows with content). Platform hard constraints (safe area / required elements) attached to a hit material are delivered in the success message, not in this description.'
      )
    )
  )
}

export const setupDesignTool = defineTool({
  name: 'setup_design',
  execution: { kind: 'sync', mutation: 'document' },
  exposure: { mcp: false, webmcp: false },
  description:
    'Set up a design workspace: create a NEW marketing design root frame on the current construction page and register it in the 关联设计区 of the 需求单 (design brief) it serves — root and brief let the work continue across turns. Call when the task needs a standardized size AND is complex, multi-step work that may continue in later turns; one-shot outputs (an image asset, a single quick card) go straight to generate_image / render instead. The working mode and style follow the current document settings (shown in the construction-page context line) — do not restate them here. There is no adopt/continue: repeat calls always create another frame (named "<label> 2", "3", ...). Canvas size decision order: (1) the user stated a size explicitly (pixels or a platform name) → pass it as canvas — pixels like "1080x1920" or a preset alias like "xhs-cover"; (2) the request clearly implies a platform (e.g. "做个小红书封面", "an Instagram post") → pass the matching preset alias and tell the user which size you chose; (3) the deliverable is clear but the platform/size is ambiguous (e.g. "做个海报") → call ask_user_question offering candidate sizes before creating anything; (4) the user gave pixels no preset knows → pass the pixels verbatim — free pixel values are always valid; (5) none of the above → omit canvas and the default long-image preset applies (750 wide, HUG height that grows with content). Height null in the result means HUG. Placement is automatic (right of existing page content) and the viewport scrolls to the new frame.',
  input: v.object(setupDesignEntries),
  execute: (figma, args) =>
    setupDesign(figma, {
      briefId: args.briefId,
      ...(args.canvas !== undefined ? { canvas: args.canvas } : {})
    })
})

/** 集成纪律：FORK_TOOLS / pi-backend 暴露面由主 agent 统一接线，本数组是唯一交付面 */
export const SETUP_TOOLS: ToolDef[] = [setupDesignTool]
