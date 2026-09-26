/**
 * Skill 加载诊断面：回答「为什么我放进 skills 目录的件没出现在清单里」。
 *
 * 设计要点：
 *  - 码集单源声明（SKILL_DIAGNOSTIC_CODES + SkillDiagnosticCode 类型），
 *    防死码断言测试静态收集「声明集」与「emit 集」做严格相等校验
 *  - 收集点 = 真实扫描路径：两层 skills 根原始目录 + SDK 成功加载集合做
 *    差集分析。分类语义对齐 SDK loadSkillFromFile 的真实拒收行为——SDK 仅在
 *    description 缺失/为空或 frontmatter 解析抛错时拒收；name 缺失按目录名
 *    兜底加载、name 非法仅记 warning 不拒收。因此：
 *      parse-failed   = 子目录存在但 SKILL.md 缺失 / 无 frontmatter / SDK 解析抛错
 *      no-description = frontmatter 可解析但 description 缺失或为空（SDK 拒收真因）
 *      name-invalid   = 已加载但生效 name 违反命名规则（SDK 仅 warning 不拒收，
 *                       用户需知道该名不合规）
 *      shadowed-by-user = 内置件被用户层同名覆盖
 *  - 禁凭空登记：每条 diagnostic 必须有真实可观察的扫描证据，否则不上报
 *  - 字节安全 fs：纯 fs API，无 shell 拼接
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

import { type Skill, loadSkillsFromDir } from '@earendil-works/pi-coding-agent'

/** 诊断码——单源声明；测试静态扫描源码做声明集 ↔ emit 集严格相等断言 */
export const SKILL_DIAGNOSTIC_CODES = [
  'parse-failed',
  'name-invalid',
  'no-description',
  'shadowed-by-user'
] as const

export type SkillDiagnosticCode = (typeof SKILL_DIAGNOSTIC_CODES)[number]

export type SkillDiagnosticEntry = {
  code: SkillDiagnosticCode
  /** 关联的 skill 名（已加载件 = 生效 name；未加载件 = frontmatter name 或子目录名兜底） */
  skillName?: string
  /** 自由文本补充（如失败原因、目录绝对路径）——内部排查用，UI 不渲染 */
  detail?: string
}

/** 单条 SKILL.md 的 frontmatter 解析：返回 { name, description, hasFrontmatter } */
function parseFrontmatterLight(content: string): {
  name?: string
  description?: string
  hasFrontmatter: boolean
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match || !match[1]) return { hasFrontmatter: false }
  const body = match[1]
  const get = (key: string): string | undefined => {
    const m = body.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
    return m?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  }
  return {
    name: get('name'),
    description: get('description'),
    hasFrontmatter: true
  }
}

/** Agent Skills spec：name 合法性（与 SDK validateName 对齐） */
function isValidName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false
  if (!/^[a-z0-9-]+$/.test(name)) return false
  if (name.startsWith('-') || name.endsWith('-')) return false
  if (name.includes('--')) return false
  return true
}

/**
 * 枚举 skills 根下直接子目录——视为 skill 候选（SDK 契约：skill = 子目录 + 内含 SKILL.md）。
 * 非目录条目（点文件 / 散落 .md）按 SDK 行为忽略，仅子目录为候选。
 * 下划线前缀（_example 等模板草稿）属用户刻意停放的件——不出诊断（产品决策，
 * 避免模板目录被诊断刷屏；SDK 本身并不跳过它们）。
 */
function listSkillSubdirs(rootDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(rootDir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = join(rootDir, entry)
    try {
      if (!statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    if (entry.startsWith('_')) continue
    out.push(entry)
  }
  return out
}

/**
 * 收集单层（用户层或内置层）诊断：parse-failed / no-description / name-invalid。
 * 三者均按「原始扫描 vs SDK 成功加载」差集 + 边界条件产出，禁止凭空登记。
 *
 * 未加载候选的分类（对齐 SDK 拒收语义——SDK 仅因 description 空 / 解析抛错拒收）：
 *  - 无 SKILL.md（且子树无已加载嵌套件——否则视为容器目录，不是坏件）→ parse-failed
 *  - SKILL.md 无 frontmatter 块 / 读取失败 → parse-failed
 *  - frontmatter 可解析但 description 缺失或为空 → no-description（SDK 拒收真因）
 *  - frontmatter 表面合法但 SDK 仍拒收（YAML 解析抛错等）→ parse-failed
 * 已加载件的检查：
 *  - 生效 name 违反命名规则（frontmatter name 非法或目录名兜底仍非法；
 *    SDK 仅记 warning 不拒收）→ name-invalid
 */
function collectLayerDiagnostics(
  rootDir: string | undefined,
  loadedSkills: Skill[]
): SkillDiagnosticEntry[] {
  const diagnostics: SkillDiagnosticEntry[] = []
  if (!rootDir || !existsSync(rootDir)) return diagnostics

  const candidates = listSkillSubdirs(rootDir)
  const loadedByBaseDir = new Map<string, Skill>()
  for (const skill of loadedSkills) {
    loadedByBaseDir.set(skill.baseDir, skill)
  }

  for (const entry of candidates) {
    const fullPath = join(rootDir, entry)
    const loaded = loadedByBaseDir.get(fullPath)
    if (loaded) {
      // 已加载：唯一可观察的异常 = 生效 name 不合规（SDK warning 级，不拒收）
      if (!isValidName(loaded.name)) {
        diagnostics.push({
          code: 'name-invalid',
          skillName: loaded.name,
          detail: `${fullPath} 的生效 name 不符合命名规则（仅小写字母、数字、连字符）`
        })
      }
      continue
    }
    // 未加载 = parse-failed 或 no-description——读 SKILL.md frontmatter 判定
    const skillMdPath = join(fullPath, 'SKILL.md')
    if (!existsSync(skillMdPath)) {
      // 容器目录场景：SDK 会递归子目录找嵌套 skill——子树有已加载件则该目录
      // 是正常容器而非坏件，不上报
      const hasLoadedDescendant = loadedSkills.some((s) =>
        s.baseDir.startsWith(`${fullPath}${sep}`)
      )
      if (hasLoadedDescendant) continue
      diagnostics.push({
        code: 'parse-failed',
        skillName: entry,
        detail: `${fullPath} 缺少 SKILL.md`
      })
      continue
    }
    let content: string
    try {
      content = readFileSync(skillMdPath, 'utf8')
    } catch (error) {
      diagnostics.push({
        code: 'parse-failed',
        skillName: entry,
        detail: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    const fm = parseFrontmatterLight(content)
    if (!fm.hasFrontmatter) {
      diagnostics.push({
        code: 'parse-failed',
        skillName: entry,
        detail: `${fullPath} 缺少 YAML frontmatter`
      })
      continue
    }
    if (!fm.description || fm.description.trim() === '') {
      // SDK 真实拒收因：description 缺失或为空（validateDescription 拒收）
      diagnostics.push({
        code: 'no-description',
        skillName: fm.name ?? entry,
        detail: `${fullPath} 的 frontmatter description 缺失或为空`
      })
      continue
    }
    // frontmatter 表面合法但 SDK 仍拒收（YAML 解析抛错等）——归 parse-failed
    diagnostics.push({
      code: 'parse-failed',
      skillName: fm.name ?? entry,
      detail: `${fullPath} 未能被加载（请检查 SKILL.md 内容）`
    })
  }

  return diagnostics
}

/**
 * 收集 shadowed-by-user：内置层被用户层同名覆盖时上报一条（内置件本身
 * 在 listSkillsForManagement 中不可见——UI 通过诊断块告知用户「这里有件
 * 但被你的同名件挡了」）。
 */
function collectShadowedDiagnostics(
  userSkills: Skill[],
  builtinSkills: Skill[]
): SkillDiagnosticEntry[] {
  const userNames = new Set(userSkills.map((s) => s.name))
  const diagnostics: SkillDiagnosticEntry[] = []
  for (const builtin of builtinSkills) {
    if (userNames.has(builtin.name)) {
      diagnostics.push({
        code: 'shadowed-by-user',
        skillName: builtin.name,
        detail: `${builtin.baseDir} 被同名用户件覆盖`
      })
    }
  }
  return diagnostics
}

/**
 * 收集入口：双源扫描 + 差集分析 + 覆盖检测，返回按码序稳定的诊断列表。
 * 调用方在加载完成后（listSkillsForManagement 同缝）调用，把诊断挂到 GET 响应。
 */
export function collectSkillDiagnostics({
  userSkillsDir,
  builtinSkillsDir
}: {
  userSkillsDir: string | undefined
  builtinSkillsDir: string | undefined
}): SkillDiagnosticEntry[] {
  const userResult =
    userSkillsDir && existsSync(userSkillsDir)
      ? loadSkillsFromDir({ dir: userSkillsDir, source: 'user' })
      : { skills: [] as Skill[], diagnostics: [] }
  const builtinResult =
    builtinSkillsDir && existsSync(builtinSkillsDir)
      ? loadSkillsFromDir({ dir: builtinSkillsDir, source: 'builtin' })
      : { skills: [] as Skill[], diagnostics: [] }

  const out: SkillDiagnosticEntry[] = []
  out.push(...collectLayerDiagnostics(userSkillsDir, userResult.skills))
  out.push(...collectLayerDiagnostics(builtinSkillsDir, builtinResult.skills))
  out.push(...collectShadowedDiagnostics(userResult.skills, builtinResult.skills))

  // 稳定性：按 (code, skillName) 排序——便于测试与前端 diff
  out.sort((a, b) => {
    if (a.code !== b.code) return a.code.localeCompare(b.code)
    return (a.skillName ?? '').localeCompare(b.skillName ?? '')
  })
  return out
}
