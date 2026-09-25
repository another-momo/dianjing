/**
 * T45（S4 W1 / T-A3）studio manifest 契约 + 投影（type 单源，前后端
 * `import type` 共用，同 chat-mode.ts 先例——type-shapes 门禁禁止同构重复定义）。
 *
 * GET /api/pi/studio/manifest 的响应形状（T45 由 T24 brand 端点更名改源而来，
 * brand/ 目录同批退役）。信任边界（T24 D7 延伸）：profile 正文不下发前端；
 * failures 的 path 在注册表内已是相对 origin 目录的相对路径（registry.ts），
 * 绝对路径不出后端进程。
 *
 * T87：附加 capabilities + skills 字段——前者是 owner 总开关读面（前端
 * Settings 面板展示），后者是 chips 行数据源（用户选择 /skill:<name> 前缀）。
 * 严格脱敏：skills 只含 name/description，**绝不**透传 filePath/baseDir/sourceInfo。
 */

import type { Capabilities, ManifestSkillEntry } from '../capabilities'
import type { StudioFailure, StudioMode, StudioRegistry } from './types'

/** mode 条目：general 恒在首位 + 每注册 workflow 一条（T62：types 数据面删除；
 *  T65：sizes 尺寸预设清单透传——形状与 StudioMode 全等 → 别名不双写（type-shapes 门禁）） */
export type PiStudioModeEntry = StudioMode

/** profile 摘要（gallery 展示用；P2-4：`modes` 为「适用 mode」列表，P2-10 启用过滤） */
export type PiStudioProfileSummary = {
  id: string
  label: string
  modes: string[]
}

/** 加载失败条目（S2 §8 显式暴露数据面；path 相对 origin 目录） */
export type PiStudioFailureEntry = {
  origin?: 'builtin' | 'user'
  path: string
  kind: StudioFailure['kind']
  reason: string
  hint: string
}

/** T87：能力开关 + skill 列表（脱敏投影）。
 * T96：形状单源到 capabilities.ts Capabilities（builtinTools 三档位 +
 * agentSkills）——字面量重写会与 Capabilities 同构触发 test:type-shapes
 * 重复形状门禁；别名对齐 PiStudioModeEntry = StudioMode 先例 */
export type PiStudioCapabilities = Capabilities

export type PiStudioManifest = {
  modes: PiStudioModeEntry[]
  profiles: PiStudioProfileSummary[]
  failures: PiStudioFailureEntry[]
  capabilities: PiStudioCapabilities
  skills: ManifestSkillEntry[]
}

/**
 * registry → manifest 脱敏投影（纯函数）。
 * deprecated profile 不进选择器数据面（deprecated 语义即「不展示」，S2 §5 字段）；
 * 其文件仍注册在案，failures 之外不另行报告。
 *
 * T87：可选 capabilities/skills 注入——调用方传 capabilities store；
 * 缺省传 undefined 时 capabilities=OFF、skills=[]（向后兼容：t45/manifest-dump
 * 等历史调用面不变）。store.listSkills() 内部已按 agentSkills OFF 返空集，
 * 此处只是把当前态透传给前端。
 */
export function toStudioManifest(
  registry: StudioRegistry,
  capabilities?: { get(): Capabilities; listSkills(): ManifestSkillEntry[] }
): PiStudioManifest {
  const modes: PiStudioModeEntry[] = registry.modes.map((mode) => {
    const entry: PiStudioModeEntry = {
      id: mode.id,
      label: mode.label,
      source: mode.source
    }
    if (mode.subtitle) entry.subtitle = mode.subtitle
    if (mode.sizes) entry.sizes = mode.sizes
    return entry
  })
  const profiles: PiStudioProfileSummary[] = [...registry.profiles.values()]
    .filter((p) => !p.deprecated)
    .map((p) => ({ id: p.id, label: p.label, modes: p.modes }))
  const failures: PiStudioFailureEntry[] = registry.failures.map((f) => ({
    ...(f.origin ? { origin: f.origin } : {}),
    path: f.path,
    kind: f.kind,
    reason: f.reason,
    hint: f.hint
  }))
  const caps: Capabilities = capabilities
    ? capabilities.get()
    : { builtinTools: 'off', agentSkills: false, disabledSkills: [] }
  // 脱敏兜底：白名单取 name/description，不依赖 store 投影的诚信
  // （T45 §信任边界同源约束——filePath/baseDir/sourceInfo 永不跨出后端进程）
  const rawSkills = capabilities ? capabilities.listSkills() : []
  const skills: ManifestSkillEntry[] = rawSkills.map((entry) => ({
    name: String(entry.name),
    description: typeof entry.description === 'string' ? entry.description : ''
  }))
  return {
    modes,
    profiles,
    failures,
    capabilities: {
      builtinTools: caps.builtinTools,
      agentSkills: caps.agentSkills,
      disabledSkills: caps.disabledSkills
    },
    skills
  }
}
