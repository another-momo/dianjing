/**
 * T43（S4 W1 / T-A1）studio 资产文件机制——契约类型。
 *
 * 三类资产（base / workflow / profile）统一「文件即资产」：一个资产 = 一个
 * markdown 文件（frontmatter 元数据 + 正文）。规格真源见仓外
 * doc/S2-asset-files-spec.md v2（§1 机制总览 / §2 目录布局 / §8 加载失败纪律）。
 *
 * T65（owner 2026-09-01 拍板 C）：workflow frontmatter 可选 `sizes: [{label, canvas}]`
 * 尺寸预设清单（label 中文名 + canvas `宽x` 高 HUG / `宽x高` 定高），registry 透传进
 * StudioMode → manifest/catalog 投影；缺席 → 缺省 750 宽 HUG（语义不变）。
 *
 * T85（owner 2026-09-02 拍板「资产 references 按需读取机制」）：三类资产 frontmatter
 * 统一可选 `references: [{path, description}]`——声明即白名单，正文经 load_reference
 * 后端本地工具按需读取（唯一读取缝，pi 内建 read 保持禁用）。path 相对资产文件所在
 * 目录、扩展名白名单（[.md,.txt,.json,.yaml,.csv]，P2-3a）、禁 `..` / 绝对路径 / 盘符；
 * 校验在 validate.ts（纯函数），文件存在性在 registry 加载期检查（缺失条目摘出 +
 * failures 显式条目，S2 §8 不静默）。
 *
 * P2-4（2026-09-07）：profile 的「适用 mode」字段由 `applicable_to` 重命名为 `modes`
 * ——语义清晰（profile 在哪些 mode 下可用），缺省/空数组 = 所有 mode 可用（无限制），
 * 显式填写才限制可用范围。manifest 投影键同步适用 `modes`（PD-17 翻案后 P2-10 启
 * 运行时过滤——chips 菜单与 prompt 注入两层都按 modes 筛选）。
 *
 * P2-6（2026-09-07）：移除 `sections` 字段——唯一消费者 PROFILE_REQUIRED_SECTIONS
 * 已随 P2-5 删除，AI 读 body 全文，代码不需按标题拆分查找。
 *
 * P2-7（2026-09-07）：`version` / `deprecated` 提升为三类资产通用字段。
 *
 * P2-8（2026-09-07）：移除 `hero_composition`——解析后无任何后续读取方（manifest
 * 不投影、运行时不注入、UI 不展示），死代码。
 *
 * P2-9（2026-09-07）：目录布局重组——`workflows/<id>.md` → `workflows/<id>/workflow.md`，
 * `profiles/<id>.md` → `profiles/<id>/profile.md`，id = 目录名（与文件名同构时
 * `workflow.md` / `profile.md` 文件名恒定，id 语义挂到目录名）。references 子目录
 * 与资产本体同目录（`workflows/<id>/references/`），路径写法不变（仍为相对资产目录
 * 的相对路径 `references/xxx.md`）。
 */

import type { CanvasSizePreset } from '@open-pencil/core/tools/fork/marketing/setup'

/** 尺寸预设（T65 §2.1）——形状单源在 core setup.ts（type-shapes 门禁禁同构双写） */
export type StudioSizePreset = CanvasSizePreset

export type StudioAssetKind = 'base' | 'workflow' | 'profile'

/** 资产来源：内置集（随应用分发）或用户目录（~/.dianjing/studio/，同 id 覆盖内置） */
export type StudioOrigin = 'builtin' | 'user'

/**
 * 资产声明的按需参考条目（T85 定谳 1，单源——type-shapes 门禁禁同构双写，
 * 测试 fixture 一律 import 此型）。path 存储形态 = 归一后正斜杠相对路径
 * （validate 期反斜杠归一），load_reference 请求侧同口径归一后匹配。
 * 解析基 = 资产所在目录（`<资产目录>/<id>/`，P2-9 新布局），白名单扩展名
 * （P2-3a：[.md,.txt,.json,.yaml,.csv]）。
 */
export interface StudioAssetReference {
  /** 相对资产分目录的相对路径（如 `references/imagery.md`）；白名单扩展名，禁 `..` / 绝对路径 / 盘符 */
  path: string
  /** 非空一行用途描述——assembleTurn 索引注入时随 path 列出 */
  description: string
}

export interface StudioBase {
  kind: 'base'
  id: 'base'
  body: string
  /** 按需参考声明（T85；缺席 = 无） */
  references?: StudioAssetReference[]
  /** P2-7：版本号（正整数；缺省不投影） */
  version?: number
  /** P2-7：是否已废弃（true 时从 manifest 数据面摘出；T45 投影纪律同 workflow 不一致） */
  deprecated?: boolean
  origin: StudioOrigin
  path: string
}

export interface StudioWorkflow {
  kind: 'workflow'
  id: string
  label: string
  subtitle?: string
  stepBudget?: number
  /** 尺寸预设清单（T65：frontmatter `sizes`；首条 = 首选预设；缺席 → 缺省 750 宽 HUG） */
  sizes?: StudioSizePreset[]
  /** 按需参考声明（T85；缺席 = 无） */
  references?: StudioAssetReference[]
  /** P2-7：版本号（正整数；缺省不投影） */
  version?: number
  /** P2-7：是否已废弃 */
  deprecated?: boolean
  body: string
  origin: StudioOrigin
  path: string
}

export interface StudioProfile {
  kind: 'profile'
  id: string
  label: string
  /**
   * P2-4：profile 适用的 mode id 列表（语义「在哪些 mode 下可用」）。
   * 缺省或空数组 = 所有 mode 可用（无限制），显式填写才限制可用范围。
   * P2-10：运行时按此字段过滤（chips 菜单 + prompt 注入）；manifest 投影仍全量。
   */
  modes: string[]
  /** P2-7：版本号（正整数；缺省不投影） */
  version?: number
  /** P2-7：是否已废弃（true 时从 manifest 数据面摘出；registry 仍注册在案） */
  deprecated: boolean
  /** 按需参考声明（T85；缺席 = 无） */
  references?: StudioAssetReference[]
  body: string
  origin: StudioOrigin
  path: string
}

/** 加载失败显式暴露条目（S2 §8：失败文件 + 原因 + 修复指引） */
export interface StudioFailure {
  /** 相对 origin 目录的相对路径（base 双源同缺时为 `base.md`、整体态为 `.`）——
   *  绝对路径不进注册表，manifest 投影因此天然脱敏（T45，T24 D7 信任边界延伸） */
  path: string
  /** 失败文件来源；base 双源同缺等无单一来源时缺省 */
  origin?: StudioOrigin
  kind: StudioAssetKind | 'studio'
  reason: string
  hint: string
}

/** mode 投影（PD-16：文件存在 = mode 可用；general 为无文件的内置特例） */
export interface StudioMode {
  id: string
  label: string
  subtitle?: string
  /** workflow 来源 mode 透传 frontmatter sizes（T65）；general 无此字段（消费侧走缺省 750 宽 HUG） */
  sizes?: StudioSizePreset[]
  source: 'general' | 'workflow'
}

export interface StudioRegistry {
  base: StudioBase | null
  workflows: ReadonlyMap<string, StudioWorkflow>
  profiles: ReadonlyMap<string, StudioProfile>
  /** general 恒在 + 每个成功注册的 workflow 派生一个 mode */
  modes: StudioMode[]
  failures: StudioFailure[]
  /**
   * T85 内部面（registry 加载期填充，供 load_reference 允许集解析）：
   * 桶键 `${kind}:${id}`（`base:base` / `workflow:<id>` / `profile:<id>`）→
   * 声明 path → 存在性已检的解析绝对路径。**绝对路径不进 manifest 投影**
   * （T45 脱敏纪律延伸，同 failures.path 相对路径口径——manifest.ts 不读本字段）。
   */
  resolvedReferences: ReadonlyMap<string, ReadonlyMap<string, string>>
}

/** resolvedReferences 桶键（T85；registry 写入侧与 assembleTurn 消费侧共用单源） */
export function referenceBucketKey(kind: StudioAssetKind, id: string): string {
  return `${kind}:${id}`
}
