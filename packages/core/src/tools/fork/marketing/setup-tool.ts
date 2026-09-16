/**
 * setup_design ToolDef（T53，S3 §2）：仅「新建」营销设计时调用。
 *
 * catalog / confirmedNewIntent 不走 schema（不进模型视野），由宿主随 args
 * 外层注入：__catalog = SetupCatalog 的 JSON 串、__confirmedNewIntent =
 * 'true' 字符串（T22 document_id 注入同缝；pi-backend 侧接线属集成期主
 * agent 领土）。本 wrapper 只做提取与类型转置，不把注入缝参数名写进任何
 * 用户可见文案。catalog 未注入（降级路径）：仅 modeId='general' 且不带
 * profileId 可用，其余返回 catalog_unavailable 结构化错误（MCP 外壳已裁撤，
 * 降级语义保留；详见 setup.ts:resolveMode）。
 *
 * T91b 新建意图确认：args 一次性 `__confirmedNewIntent` 与 document root
 * pluginData `newIntentConfirmed` 二者其一为真即放行——后者由用户在前端
 * ChatNewIntentCard 点确认后经 `/api/pi/intent-confirm` 写入。任一未成立
 * 时返 `awaiting_new_intent_confirmation` 信封（非错误），前端 ChatPanel
 * 主动拦截展示确认卡。A3 B6：纯 general（无 profileId）静默放行——无
 * workflow/profile 绑定，无高风险参数，不需确认。
 */

import { defineTool, type ToolDef } from '#core/tools/schema'

import { setupDesign, type SetupCatalog } from './setup'

/** 宿主注入的 catalog JSON 串 → 快照对象；解析失败按未注入处理（宿主 bug 不炸画布） */
function parseInjectedCatalog(raw: unknown): SetupCatalog | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    return JSON.parse(raw) as SetupCatalog
  } catch {
    return undefined
  }
}

export const setupDesignTool = defineTool({
  name: 'setup_design',
  mutates: true,
  description:
    'Set up a design workspace: create a NEW marketing design root frame with a normalized canvas size and register it in the 关联设计区 of the 需求单 (design brief) it serves — root and brief let the work continue across turns. Call when the task needs a standardized size AND is complex, multi-step work that may continue in later turns; one-shot outputs (an image asset, a single quick card) go straight to generate_image / render instead. Mode binding needs out-of-band confirmation: for a specialized mode (any modeId other than "general", or any profileId) the host confirms the new-design intent first — without confirmation the call returns { status: "awaiting_new_intent_confirmation" } (an awaiting envelope, not an error) and the host prompts the user; once confirmed, the next call proceeds. A plain "general" workspace (no profileId) proceeds without confirmation. There is no adopt/continue here: repeat calls always create another frame (named "<label> 2", "3", ...). The new root becomes the conversation\'s current design target (the `[当前设计目标 …]` context line) for subsequent turns. Canvas size: each mode may declare size presets in the host catalog (modes[].sizes — pick the preset whose label matches the user intent, e.g. 小红书长图), overridable via the canvas param; with neither, the default is 750-wide with HUG height (grows with content). Height null in the result means HUG. Placement is automatic (right of existing page content) and the viewport scrolls to the new frame.',
  params: {
    modeId: {
      type: 'string',
      required: true,
      description:
        'Design mode id — "general" for a plain general workspace (no workflow binding, always valid; no out-of-band confirmation required when no profileId is given), or a mode id from the host studio catalog (specialized mode — host confirms new-design intent first).'
    },
    profileId: {
      type: 'string',
      description:
        'Style profile id from the host studio catalog (optional). Setting any profileId forces out-of-band confirmation regardless of modeId.'
    },
    briefId: {
      type: 'string',
      required: true,
      description:
        'Id of the 需求单 (design brief) this design serves — the new design is bound to it and registered in its 关联设计区.'
    },
    canvas: {
      type: 'string',
      description:
        'Canvas size override (optional) — a canvas value from the mode\'s sizes presets in the host catalog, or a free value: "<width>x" (height grows with content) or "<width>x<height>" (fixed height), e.g. "750x" / "750x2000". Invalid format returns { error: "invalid_canvas" } and nothing is created. Omit to use the mode\'s first preset, or the 750-wide HUG default when the mode has no presets.'
    }
  },
  execute: (figma, args) => {
    const injected: Record<string, unknown> = args
    return setupDesign(
      figma,
      {
        modeId: args.modeId,
        profileId: args.profileId,
        briefId: args.briefId,
        canvas: args.canvas,
        confirmedNewIntent: injected.__confirmedNewIntent === 'true'
      },
      parseInjectedCatalog(injected.__catalog)
    )
  }
})

/** 集成纪律：FORK_TOOLS / pi-backend 暴露面由主 agent 统一接线，本数组是唯一交付面 */
export const SETUP_TOOLS: ToolDef[] = [setupDesignTool]
