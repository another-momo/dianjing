/**
 * T43 studio 机制——按类加载期校验（lint）。
 *
 * 规格真源：doc/S2-asset-files-spec.md v2 §3（base）/ §4（workflow）/ §5
 * （profile 引用完整性）。本模块只产出失败原因与修复指引文案，不做注册副作用。
 * 校验失败 = 该文件不注册 + failure 进注册表 failures（S2 §8）。
 *
 * P2-5（2026-09-07）：三处过度校验移除——
 *  - PROFILE_REQUIRED_SECTIONS：内容组织方式不再锁定
 *  - findInvalidHex（启发式抓色值笔误，但正文色相描述可能误伤）
 *  - collectFontRefs（只扫 frontmatter 不扫 body，半吊子校验不如不做）
 *
 * P2-3a（2026-09-07）：references path 扩展名白名单放宽为
 * [.md,.txt,.json,.yaml,.csv]——原先锁 .md 只为文档按需读取，profile/
 * workflow 可能引入文本/json/yaml/csv 资产描述。
 *
 * P2-7（2026-09-07）：version / deprecated 提升为三类资产通用字段。
 *
 * P2-9（2026-09-07）：id 一致性口径调整为「id 必须等于所在目录名」
 * （原「等于文件名去 .md」——workflow.md / profile.md 文件名恒定，id 语义挂到目录名）。
 */

import { ALL_TOOLS, isToolExposed } from '@open-pencil/core/tools'
import { parseCanvasSize } from '@open-pencil/core/tools/fork/marketing/setup'

import { isAssetId, isRecord, type ParsedAsset } from './parse'
import { referencePathProblem } from './reference-path'
import type { StudioAssetReference, StudioSizePreset } from './types'

/**
 * 工具面 AI 可见集——`tools` 白名单存在性闸的判定基。= 注册表全集滤掉
 * eval 档（对 agent 隐藏）与 exposure.ai 关闭件（internal 桥端点不进 agent
 * 面）。判定基取「AI 可见」而非「当前装配面」：装配面是 extended 白名单的
 * 累积产物，本机制正当用途恰是「把注册表内 AI 可见但未放行的工具经 workflow
 * 点名放进来」——以装配面为基会把这类点名误判成不存在。点名 AI 不可见件
 * 则闸 1 拦下（避免闸绿但 SDK setActiveToolsByName 静默忽略的伪成功）。
 */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(
  ALL_TOOLS.filter((tool) => tool.availability !== 'eval' && isToolExposed(tool, 'ai')).map(
    (tool) => tool.name
  )
)

export interface ValidationIssue {
  reason: string
  hint: string
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 通用：id/label + version/deprecated（P2-7 通用化）。
 *  `dirId` = 资产所在目录名 = id（P2-9 新布局：workflow.md/profile.md 文件名恒定，
 *  id 语义挂到目录名；base.md 不走本函数）。 */
export function validateCommon(
  fm: Record<string, unknown>,
  dirId: string,
  kindLabel: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const id = stringField(fm.id)
  if (!id) {
    issues.push({ reason: 'frontmatter 缺 `id`', hint: `补 \`id: ${dirId}\`` })
  } else if (id !== dirId) {
    issues.push({
      reason: `frontmatter id「${id}」与所在目录名「${dirId}」不一致`,
      hint: 'id 必须等于所在目录名——资产按目录布局（`workflows/<id>/workflow.md` 与 `profiles/<id>/profile.md`），覆盖与引用都以它为准'
    })
  } else if (!isAssetId(id)) {
    issues.push({
      reason: `id「${id}」不是合法机读 id`,
      hint: 'id 只允许小写字母/数字/连字符/下划线（如 `watercolor_poster_v2` 或 `longform-hero-kv-first`）'
    })
  }
  if (!stringField(fm.label)) {
    issues.push({ reason: 'frontmatter 缺 `label`', hint: `补 \`label: <${kindLabel}显示名>\`` })
  }
  return issues
}

/** P2-7：version 通用解析（正整数；缺省 undefined = 不产出 issues） */
function parseVersion(fm: Record<string, unknown>, issues: ValidationIssue[]): number | undefined {
  if (!('version' in fm)) return undefined
  const raw = fm.version
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw
  issues.push({
    reason: '`version` 不是正整数',
    hint: '写正整数（如 `version: 3`）或删除该字段'
  })
  return undefined
}

/** P2-7：deprecated 通用解析（仅当显式 true 时为 true，其余默认 false） */
function parseDeprecated(fm: Record<string, unknown>): boolean {
  return fm.deprecated === true
}

/**
 * workflow 校验：step_budget 若存在须正整数；subtitle 提取；sizes 尺寸预设清单
 * （T65 §2.1：非空 [{label, canvas}]，label 非空中文名、canvas 格式 `宽x`/`宽x高`
 * ——canvas 解析单源在 core setup.ts parseCanvasSize）；references 按需参考清单
 * （T85 定谳 1：非空 [{path, description}]，path 白名单扩展名、禁 `..`/绝对/盘符）；
 * tools 工具面收放白名单（非空字符串清单，每个名字必须存在于工具面全集——
 * 存在性是唯一机械闸，打错名进 issues）。
 * P2-7：version/deprecated 通用化从 validateCommon 接收。
 * （T62：type 层级校验段整体删除——未知 frontmatter 键容忍不校验。）
 */
export function validateWorkflow(
  parsed: ParsedAsset & { ok: true },
  dirId: string
): {
  issues: ValidationIssue[]
  stepBudget?: number
  subtitle?: string
  sizes?: StudioSizePreset[]
  references?: StudioAssetReference[]
  tools?: string[]
  version?: number
  deprecated: boolean
} {
  const { frontmatter: fm } = parsed
  const issues = validateCommon(fm, dirId, 'mode')

  let stepBudget: number | undefined
  if ('step_budget' in fm) {
    const raw = fm.step_budget
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
      stepBudget = raw
    } else {
      issues.push({
        reason: '`step_budget` 不是正整数',
        hint: '写正整数（如 `step_budget: 50`）或删除该字段'
      })
    }
  }

  const version = parseVersion(fm, issues)
  const deprecated = parseDeprecated(fm)

  return {
    issues,
    stepBudget,
    subtitle: stringField(fm.subtitle),
    version,
    deprecated,
    ...parseSizes(fm, issues),
    ...parseReferences(fm, issues),
    ...parseTools(fm, issues)
  }
}

/**
 * references 清单解析（T85 定谳 1，三类资产共用）：全部条目合法才产出（任一非法 →
 * 整条不产出，issues 已逐条记录——同 sizes 先例）。path 归一 = 反斜杠转正斜杠后校验
 * （referencePathProblem 见 reference-path.ts，运行期 load-reference 同口径再查一次，
 * 纵深防御），存储归一后形态（索引注入与 load_reference 匹配同口径）。
 */
export function parseReferences(
  fm: Record<string, unknown>,
  issues: ValidationIssue[]
): { references?: StudioAssetReference[] } {
  if (!('references' in fm)) return {}
  const raw = fm.references
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({
      reason: '`references` 不是非空清单',
      hint: '形如 `references: [{path: references/imagery.md, description: 图像决策纪律}]`——或删除该字段'
    })
    return {}
  }
  const before = issues.length
  const references: StudioAssetReference[] = []
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) {
      issues.push({
        reason: '`references` 含非键值条目',
        hint: '每条必须是 `{path, description}` 键值对（如 `{path: references/imagery.md, description: 图像决策纪律}`）'
      })
      continue
    }
    const rawPath = stringField(entry.path)
    const description = stringField(entry.description)
    if (!rawPath) {
      issues.push({
        reason: '`references` 条目缺 `path` 或为空',
        hint: '每条须含相对资产分目录的路径（白名单扩展名：.md/.txt/.json/.yaml/.csv，如 `references/imagery.md`）'
      })
      continue
    }
    const path = rawPath.replaceAll('\\', '/')
    const problem = referencePathProblem(path)
    if (problem) {
      issues.push({
        reason: `\`references\` 条目 path「${rawPath}」${problem}`,
        hint: 'path 只接受相对资产目录的白名单扩展名相对路径——禁 `..`、绝对路径与盘符'
      })
      continue
    }
    if (!description) {
      issues.push({
        reason: `\`references\` 条目「${path}」缺 \`description\` 或为空`,
        hint: '补一行用途描述（索引进 systemPrompt 时随 path 展示，如「图像资产决策与生成纪律」）'
      })
      continue
    }
    references.push({ path, description })
  }
  return issues.length === before ? { references } : {}
}

/**
 * tools 白名单解析（workflow 级工具面收放）：全部条目合法才产出（任一非法 →
 * 整条不产出，issues 已逐条记录——同 references/sizes 先例）。存在性闸：
 * 点名工具必须在工具面全集（core + extended + fork）内，打错名即非法条目。
 */
export function parseTools(
  fm: Record<string, unknown>,
  issues: ValidationIssue[]
): { tools?: string[] } {
  if (!('tools' in fm)) return {}
  const raw = fm.tools
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({
      reason: '`tools` 不是非空清单',
      hint: '形如 `tools: [compose_backdrop]`——只登记本 workflow 专用的条件工具；或删除该字段'
    })
    return {}
  }
  const before = issues.length
  const tools: string[] = []
  for (const entry of raw as unknown[]) {
    const name = typeof entry === 'string' ? entry.trim() : ''
    if (!name) {
      issues.push({
        reason: '`tools` 含非字符串或空条目',
        hint: '每条必须是工具名（如 `compose_backdrop`）'
      })
      continue
    }
    if (!KNOWN_TOOL_NAMES.has(name)) {
      issues.push({
        reason: `\`tools\` 点名的工具「${name}」不在工具面内`,
        hint: '两种可能：①拼写有误——名字须与工具注册表一致（如 `compose_backdrop`、`prepare_hero_scaffold`）；②该工具存在但不向 AI 暴露（仅供内部桥端点，如 `place_image_from_bytes`）——此类工具本机制无法启用，请改用其它已向 AI 暴露的工具'
      })
      continue
    }
    tools.push(name)
  }
  return issues.length === before ? { tools } : {}
}

/** sizes 清单解析：全部条目合法才产出（任一非法 → 整条不注册，issues 已逐条记录） */
function parseSizes(
  fm: Record<string, unknown>,
  issues: ValidationIssue[]
): { sizes?: StudioSizePreset[] } {
  if (!('sizes' in fm)) return {}
  const raw = fm.sizes
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({
      reason: '`sizes` 不是非空预设清单',
      hint: '形如 `sizes: [{label: 电商详情长图, canvas: 750x}]`——label 中文名 + canvas `宽x`（高度随内容）或 `宽x高`（定高）'
    })
    return {}
  }
  const before = issues.length
  const sizes: StudioSizePreset[] = []
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) {
      issues.push({
        reason: '`sizes` 含非键值条目',
        hint: '每条预设必须是 `{label, canvas}` 键值对（如 `{label: 小红书长图, canvas: 1080x}`）'
      })
      continue
    }
    const label = stringField(entry.label)
    const canvas = stringField(entry.canvas)
    if (!label) {
      issues.push({
        reason: '`sizes` 条目缺 `label` 或为空',
        hint: '每条预设须含中文名（如 `{label: 小红书长图, canvas: 1080x}`）'
      })
      continue
    }
    if (!canvas || parseCanvasSize(canvas) === null) {
      issues.push({
        reason: `\`sizes\` 条目「${label}」的 canvas 格式非法`,
        hint: 'canvas 只接受 `宽x`（如 750x，高度随内容）或 `宽x高`（如 750x2000，定高）'
      })
      continue
    }
    sizes.push({ label, canvas })
  }
  return issues.length === before ? { sizes } : {}
}

/**
 * profile 校验：modes 引用完整性（引用的 mode 必须存在于注册表或为 general，P2-4
 * 字段名由 applicable_to 改为 modes，缺省/空数组 = 所有 mode 可用，校验通过）；
 * references 按需参考清单（T85 定谳 1，与 workflow 同口径）。节结构不锁——P2-5
 * 移除了 PROFILE_REQUIRED_SECTIONS、findInvalidHex、collectFontRefs。
 *
 * `knownModeIds` 由 registry 在 workflow 注册完成后传入（含 general）。
 */
export function validateProfile(
  parsed: ParsedAsset & { ok: true },
  dirId: string,
  knownModeIds: ReadonlySet<string>
): {
  issues: ValidationIssue[]
  modes: string[]
  version?: number
  deprecated: boolean
  references?: StudioAssetReference[]
} {
  const { frontmatter: fm } = parsed
  const issues = validateCommon(fm, dirId, 'profile')

  let modes: string[] = []
  if ('modes' in fm) {
    if (!Array.isArray(fm.modes) || fm.modes.some((v) => typeof v !== 'string')) {
      issues.push({
        reason: '`modes` 不是字符串列表',
        hint: '形如 `modes: [longform-hero-kv-first, longform-structure-first]`——省略或留空 = 所有 mode 可用'
      })
    } else {
      modes = fm.modes as string[]
      for (const modeId of modes) {
        if (!knownModeIds.has(modeId)) {
          issues.push({
            reason: `modes 引用了不存在的 mode「${modeId}」`,
            hint: 'mode id = workflows/ 下的目录名（或 general）；检查拼写，或先补对应 workflow 资产'
          })
        }
      }
    }
  }

  const version = parseVersion(fm, issues)
  const deprecated = parseDeprecated(fm)

  return {
    issues,
    modes,
    version,
    deprecated,
    ...parseReferences(fm, issues)
  }
}

/**
 * base 校验：id 必为 'base'（由 registry.loadBase 单独硬判定）；version/deprecated
 * 通用化（P2-7）+ references（T85）。label 免要求（T46 免 label schema），
 * 故不走 validateCommon。
 */
export function validateBase(parsed: ParsedAsset & { ok: true }): {
  issues: ValidationIssue[]
  version?: number
  deprecated: boolean
  references?: StudioAssetReference[]
} {
  const { frontmatter: fm } = parsed
  const issues: ValidationIssue[] = []
  const version = parseVersion(fm, issues)
  const deprecated = parseDeprecated(fm)
  return { issues, version, deprecated, ...parseReferences(fm, issues) }
}
