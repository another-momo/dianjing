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
        'Canvas size override (optional) — a free value: "<width>x" (height grows with content) or "<width>x<height>" (fixed height), e.g. "750x" / "750x2000". Invalid format returns { error: "invalid_canvas" } and nothing is created. Omit for the 750-wide HUG default.'
      )
    )
  )
}

export const setupDesignTool = defineTool({
  name: 'setup_design',
  execution: { kind: 'sync', mutation: 'document' },
  exposure: { mcp: false, webmcp: false },
  description:
    'Set up a design workspace: create a NEW marketing design root frame on the current construction page and register it in the 关联设计区 of the 需求单 (design brief) it serves — root and brief let the work continue across turns. Call when the task needs a standardized size AND is complex, multi-step work that may continue in later turns; one-shot outputs (an image asset, a single quick card) go straight to generate_image / render instead. The working mode and style follow the current document settings (shown in the construction-page context line) — do not restate them here. There is no adopt/continue: repeat calls always create another frame (named "<label> 2", "3", ...). Canvas size: pass the canvas param when the user asked for a specific size; with neither, the default is 750-wide with HUG height (grows with content). Height null in the result means HUG. Placement is automatic (right of existing page content) and the viewport scrolls to the new frame.',
  input: v.object(setupDesignEntries),
  execute: (figma, args) =>
    setupDesign(figma, {
      briefId: args.briefId,
      ...(args.canvas !== undefined ? { canvas: args.canvas } : {})
    })
})

/** 集成纪律：FORK_TOOLS / pi-backend 暴露面由主 agent 统一接线，本数组是唯一交付面 */
export const SETUP_TOOLS: ToolDef[] = [setupDesignTool]
