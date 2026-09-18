/**
 * Fork-owned tool registration seam (rebuild/v2).
 *
 * Fork tools are defined as NEW files under this directory and listed in
 * FORK_TOOLS. The upstream registry (registry-core.ts / registry-extended.ts)
 * stays pristine; the only upstream touch point is a single spread in
 * registry.ts (registered patch P22). Precedent in upstream's own style:
 * component-catalog.ts's registerComponentCatalog.
 *
 * W2 登记者：BRIEF_TOOLS（T52 brief 三件套）、SETUP_TOOLS（T53 setup_design）、
 * lookTool（T55）、HERO_TOOLS（T57 prepare_hero_scaffold）、
 * IMAGE_GEN_TOOLS（T54 落图段桥端点——generate_image 本体在 pi-backend
 * 后端段装配，不经此表）。
 * W3 登记者：COMPOSE_TOOLS（T58 compose_backdrop）、
 * ACTIVE_DESIGN_TOOLS（T60 set_active_design——宿主路由声明原语）。
 */
import type { ToolDef } from '#core/tools/schema'

import { IMAGE_GEN_TOOLS } from './image-gen'
import {
  ACTIVE_DESIGN_TOOLS,
  BRIEF_TOOLS,
  COMPOSE_TOOLS,
  HERO_TOOLS,
  SETUP_TOOLS
} from './marketing'
import { lookTool } from './marketing/look'
import { placeImageFromBytesTool } from './place-image-from-bytes'

export const FORK_TOOLS: ToolDef[] = [
  ...BRIEF_TOOLS,
  ...SETUP_TOOLS,
  lookTool,
  ...HERO_TOOLS,
  ...IMAGE_GEN_TOOLS,
  ...COMPOSE_TOOLS,
  ...ACTIVE_DESIGN_TOOLS,
  placeImageFromBytesTool
]
