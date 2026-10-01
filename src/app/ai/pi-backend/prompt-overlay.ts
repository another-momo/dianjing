/**
 * studio 注册表 → prompt overlay 输入适配（纯函数单源）。仅运行于后端进程，
 * 前端不复制；profile 正文不下发前端（studio/manifest.ts 信任边界）。
 */

import type { StudioRegistry } from './studio/types'

export type StudioStyleProfileEntry = {
  id: string
  markdown: string
}

/**
 * profiles = { id, markdown: body }——正文只进 prompt，不出本模块服务端边界。
 * profiles 不过滤 deprecated（与 manifest 投影不同）：已被选中的 profile 遭
 * 废弃后仍注入 prompt（前端下拉已隐藏，会话内选择保持有效）。
 */
export function studioOverlayInput(registry: StudioRegistry): {
  profiles: StudioStyleProfileEntry[]
} {
  const profiles = [...registry.profiles.values()].map((p) => ({ id: p.id, markdown: p.body }))
  return { profiles }
}
