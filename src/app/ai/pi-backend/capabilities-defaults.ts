/**
 * capabilities 缺省值单源（前后端共用——capabilities.ts 含 node:fs 无法被
 * 前端 value-import，字面量须落在零依赖文件里）：
 *  - 后端：capabilities.ts DEFAULTS 兜新装/文件缺失/坏文件降级
 *  - 前端：AgentSettingsPanel 瞬态初值（manifest 拉取到达前的首帧渲染）
 */
import { type Capabilities } from './capabilities'

export const CAPABILITIES_DEFAULTS: Capabilities = {
  builtinTools: 'full',
  agentSkills: true,
  // 负向 override：只记被关闭的 skill 名；缺省/缺失 = [] = 全启用
  disabledSkills: []
}
