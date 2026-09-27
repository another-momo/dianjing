/**
 * marketing 工具导出（T52 brief 三件套 / T53 setup_design / T57 hero scaffold /
 * T58 compose_backdrop）。
 * 集成纪律：FORK_TOOLS（fork/index.ts）与 pi-backend 暴露面由主 agent 集成期
 * 统一接线。
 */

import type { ToolDef } from '#core/tools/schema'

import { appendBriefConclusionTool, createBriefTool, readBriefTool } from './tools'

export const BRIEF_TOOLS: ToolDef[] = [createBriefTool, readBriefTool, appendBriefConclusionTool]

export { COMPOSE_TOOLS } from './compose-tools'
export { HERO_TOOLS } from './hero-tools'
export { SETUP_TOOLS } from './setup-tool'
export { appendBriefConclusionTool, createBriefTool, readBriefTool } from './tools'
