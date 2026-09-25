/**
 * T87：Agent 能力总开关（pi 原生 skill 支持 + 内建工具同闸）。
 * T96：单开关拆分为两个正交面——builtinTools 三档位（off/readonly/full）
 * 控内建工具装配，agentSkills 布尔独控 skill 加载（预研 §4.2）。
 * T91o：expandSkillText 宿主侧 /skill:name 就地展开（未知名透传）。
 *
 * 存储：.dianjing/pi-agent/capabilities.json（tmp+rename 原子写；坏 JSON
 * 降级 DEFAULTS——同 image-gen/credentials 纪律但无敏感字段，0o600 仅对齐设置文件
 * 既存卫生标准；绝无任何 key/secret 字段）。
 *
 * 双键语义（T96，owner 任务卡）：
 *  - builtinTools: 'off' | 'readonly' | 'full' ——session 装配门控：
 *    off → noTools:'builtin'；readonly → tools:[read/grep/find/ls]；
 *    full → 省略字段走 SDK 默认（read/bash/edit/write）。缺省 'full'
 *    （2026-09-22 owner 拍板翻转——内测期以 full 档考验授权/安全机制；
 *    存量 capabilities.json 有显式值不跟随，全员强翻需另做版本迁移）
 *  - agentSkills: boolean ——skill 加载开关（pi SDK 路径 noSkills），
 *    与 builtinTools 解耦。缺省 true（2026-09-18 同批翻转）。
 *  - disabledSkills: string[] ——负向 override，只记被关闭的 skill 名；
 *    缺省/缺失 = [] = 全启用。被禁件不进 listSkills（chips/manifest 不可见）、
 *    不进 expandSkillText（按未知名透传）、不进 session 装配的 available_skills
 *    段、不可被 /skill:name 调用。被禁名对应的 skill 卸载后再装回保持禁用
 *    ——不校验名字存在性（负向韧性）。
 *
 * v1 → v2 迁移：旧文件 {version:1, agentSkills} 读盘时按旧同闸语义映射
 * builtinTools = agentSkills ? 'full' : 'off'；写盘恒 version:3。
 * v2 → v3 迁移：旧 v2 文件读盘时 disabledSkills 落 []（旧版无此键，缺省全启用）。
 *
 * 脱敏边界（T45 同源约束）：
 *  - getCapabilitiesForManifest() 投影只用 name + description，**绝不返回**
 *    filePath / baseDir / sourceInfo——这些是宿主内部坐标系，下发前端
 *    即泄漏内部路径（与 T45 §信任边界同质）。
 *  - 扫描面双源：用户层 `${rootDir}/studio/skills`（resolveSkillsDir）+
 *    内置层 builtinSkillsDir（resolveBuiltinSkillsDir 的产物，可选——缺省
 *    即无内置层）；合并先到先得（用户层赢同名），与 SDK loadSkills 的
 *    collision 语义（skillMap 先扫者赢）及 service.ts additionalSkillPaths
 *    [userDir, builtinDir] 顺序一致，用户层可覆盖内置默认。
 *    agentDir 仅用于 capabilities.json 持久化，不承担 skill 扫描。
 *  - 用 loadSkillsFromDir 逐目录扫描，不暴露 SDK 默认扫描假设。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Skill, loadSkillsFromDir } from '@earendil-works/pi-coding-agent'

import { CAPABILITIES_DEFAULTS } from './capabilities-defaults'
import { resolveSkillsDir } from './paths'

/**
 * 持久化形状：版本号字段防升级期旧文件残留。布尔外不留用户可调字段——
 * 扩展面走新键 + 版本号 + 读时兼容（坏文件/缺字段 → 落到 OFF）。
 * T96：v2 增 builtinTools；v1 文件读盘时按旧同闸语义迁移（见 readFromDisk）。
 * v3：增 disabledSkills 负向 override；v2 文件读盘时 disabledSkills 落 []。
 */
interface CapabilitiesFile {
  version: 3
  builtinTools: BuiltinToolsLevel
  agentSkills: boolean
  disabledSkills: string[]
}

/** T96：内建工具三档位（off 无内建 / readonly 只读四件 / full SDK 默认全集） */
export type BuiltinToolsLevel = 'off' | 'readonly' | 'full'

const BUILTIN_TOOLS_LEVELS: readonly BuiltinToolsLevel[] = ['off', 'readonly', 'full']

// 2026-09-22 owner 拍板翻转：builtinTools readonly→full（内测期考验安全机制）。
// DEFAULTS 只兜新装/文件缺失/坏文件降级，存量显式值不跟随。
// 字面量单源在 capabilities-defaults.ts（前端设置面板瞬态初值同源共用）。
const DEFAULTS: CapabilitiesFile = { version: 3, ...CAPABILITIES_DEFAULTS }

export type Capabilities = {
  /** 内建工具档位；service.ts 装配据此切换 noTools/tools */
  builtinTools: BuiltinToolsLevel
  /** skill 加载开关；service.ts 装配据此切换 noSkills（与 builtinTools 解耦） */
  agentSkills: boolean
  /** 负向 override：被关闭的 skill 名清单；缺省 = [] = 全启用 */
  disabledSkills: string[]
}

/**
 * 投影脱敏后的 skill 条目（manifest 透传前端 chips 用）。
 * 注意：仅投影 name/description；filePath/baseDir 永不跨出后端进程。
 * T91g：形状单源到 SDK Skill 的 Pick——字面量写法与 design-jsx/schema.ts
 * DesignJSXNamedDefinition 同构，触发 test:type-shapes 重复形状门禁
 * （CI run 33838280417）；Pick 既消重复又锚定投影来源。
 */
export type ManifestSkillEntry = Pick<Skill, 'name' | 'description'>

/**
 * 管理面（settings 面板）单条 skill 形状——脱敏投影基础上加 source 标记
 * （赢家层归属）+ enabled 标记（是否在 disabledSkills 中）。
 * 交叉扩展 ManifestSkillEntry 复用同名字段，避免触发 type-shapes 门禁。
 */
export type ManagedSkillEntry = ManifestSkillEntry & {
  source: 'user' | 'builtin'
  enabled: boolean
}

export type CapabilitiesStore = {
  /** 进程级内存缓存；缺省 = DEFAULTS；返回纯值对象（解构给 service.ts / GET 端点共用） */
  get(): Capabilities
  /**
   * PUT 写入：agentSkills 非布尔 → 抛错；builtinTools 给了就必须是三档字面量
   * （缺省保留旧值——兼容只写 agentSkills 的调用面）；正常路径落盘 + 更新缓存；
   * 返回最新 Capabilities（含校验后的归一值）。
   * disabledSkills 不动——与 builtinTools 缺省保留同模式。
   */
  set(input: { agentSkills: unknown; builtinTools?: unknown }): Capabilities
  /**
   * 扫描能力开关打开时实际可见的 skill 列表（脱敏投影）。
   * OFF 时返回 []——避免在能力未授权时泄露已扫到的 skill 存在性。
   * 被禁件过滤——disabledSkills 中的 skill 不进 chips/manifest。
   */
  listSkills(): ManifestSkillEntry[]
  /**
   * 管理面全量清单（含被禁件）——不受 agentSkills 全局闸影响；
   * 用于 settings 面板「已安装 skill」列表展示与单件启停。
   */
  listSkillsForManagement(): ManagedSkillEntry[]
  /**
   * PUT 写入被禁件清单——非 string[] 抛 TypeError（路由层转 400）；
   * 去重保序归一；写盘（保留既有 builtinTools/agentSkills）；
   * 返回新集合。不校验名字存在性（被禁名对应 skill 卸载后再装回保持禁用）。
   */
  setDisabledSkills(input: unknown): string[]
  /**
   * T91o：宿主侧 skill 展开。pi SDK `_expandSkillCommand`（agent-session.js:953）
   * 只认「整条消息以 /skill: 开头 + skill 名到首个 ASCII 空格止」，两个硬限制：
   * 名后直接贴中文（无空格）→ skillName 吞掉整段正文、查无此 skill 透传；
   * 提及在句中/句尾 → startsWith 不过、整条透传。透传后模型只拿到字面
   * /skill: 文本，退化成 find/read/ls 猎 SKILL.md——.dianjing/skills 是
   * 隐藏目录、fd 默认不搜隐藏目录，永远猎不到（owner 情况①②实测）。
   * 本方法解除双限制：文本内全部 `/skill:<name>` 提及就地展开为 SDK 同款
   * `<skill>` 块（位置自由、一条消息可激活多个 skill）；未知名透传（SDK
   * 同语义）；agentSkills OFF 时不展开（与 SDK noSkills 查无 skill 透传
   * 同语义）；被禁件按未知名透传（与 SDK 行为一致）。
   * 展开后文本不再以 /skill: 开头，SDK 侧自然 passthrough 不
   * 二次展开。
   */
  expandSkillText(text: string): string
}

export function createCapabilitiesStore({
  agentDir,
  rootDir,
  builtinSkillsDir
}: {
  agentDir: string
  rootDir: string
  /** 内置层 skills 目录（resolveBuiltinSkillsDir 的产物）；缺省 = 无内置层、单源用户层 */
  builtinSkillsDir?: string
}): CapabilitiesStore {
  const filePath = join(agentDir, 'capabilities.json')
  let cache: Capabilities | null | undefined

  /**
   * 归一 disabledSkills 字段——非数组或含非字符串元素 → 降级 []；
   * 数组元素去重保序归一。整文件其余字段照常解析，不整文件降级。
   */
  function normalizeDisabledSkills(input: unknown): string[] {
    if (!Array.isArray(input)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of input) {
      if (typeof item !== 'string') continue
      if (seen.has(item)) continue
      seen.add(item)
      out.push(item)
    }
    return out
  }

  function readFromDisk(): Capabilities {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
        version?: unknown
        builtinTools?: unknown
        agentSkills?: unknown
        disabledSkills?: unknown
      }
      // T96 v1 → v2 迁移：旧单开关语义是「skill + 内建工具同闸」——
      // agentSkills true 等价于 builtinTools 'full'，false 等价于 'off'
      if (raw.version === 1 && typeof raw.agentSkills === 'boolean') {
        return {
          builtinTools: raw.agentSkills ? 'full' : 'off',
          agentSkills: raw.agentSkills,
          disabledSkills: []
        }
      }
      if (
        raw.version === 2 &&
        typeof raw.builtinTools === 'string' &&
        (BUILTIN_TOOLS_LEVELS as readonly string[]).includes(raw.builtinTools) &&
        typeof raw.agentSkills === 'boolean'
      ) {
        // v2 文件无 disabledSkills 字段——按 v3 语义缺省 []
        return {
          builtinTools: raw.builtinTools as BuiltinToolsLevel,
          agentSkills: raw.agentSkills,
          disabledSkills: []
        }
      }
      if (
        raw.version === 3 &&
        typeof raw.builtinTools === 'string' &&
        (BUILTIN_TOOLS_LEVELS as readonly string[]).includes(raw.builtinTools) &&
        typeof raw.agentSkills === 'boolean'
      ) {
        // v3 文件 disabledSkills 字段单独降级——非数组或含非字符串元素 → []
        // 其余字段照常解析，不整文件降级
        return {
          builtinTools: raw.builtinTools as BuiltinToolsLevel,
          agentSkills: raw.agentSkills,
          disabledSkills: normalizeDisabledSkills(raw.disabledSkills)
        }
      }
      return {
        builtinTools: DEFAULTS.builtinTools,
        agentSkills: DEFAULTS.agentSkills,
        disabledSkills: DEFAULTS.disabledSkills
      }
    } catch {
      // ENOENT / 坏 JSON → 缺省 DEFAULTS（capabilities 面 fail-safe，
      // 缺配置/坏文件不落半残状态；兜底值已抬为 full+true——2026-09-22 拍板）
      return {
        builtinTools: DEFAULTS.builtinTools,
        agentSkills: DEFAULTS.agentSkills,
        disabledSkills: DEFAULTS.disabledSkills
      }
    }
  }

  function get(): Capabilities {
    if (cache === null || cache === undefined) cache = readFromDisk()
    return {
      builtinTools: cache.builtinTools,
      agentSkills: cache.agentSkills,
      disabledSkills: [...cache.disabledSkills]
    }
  }

  function writeToDisk(next: Capabilities): void {
    mkdirSync(agentDir, { recursive: true })
    // 写盘恒 version:3（迁移在读盘完成，落盘即新形状）
    const doc: CapabilitiesFile = {
      version: 3,
      builtinTools: next.builtinTools,
      agentSkills: next.agentSkills,
      disabledSkills: [...next.disabledSkills]
    }
    const tmpPath = `${filePath}.tmp`
    // 0o600 与 settings 文件齐平（capabilities 不含敏感字段，但同目录
    // 其他文件（auth.json/image-gen.json）已是 0o600，统一防越权读）
    writeFileSync(tmpPath, JSON.stringify(doc, null, 2), { mode: 0o600 })
    renameSync(tmpPath, filePath)
  }

  function set(input: { agentSkills: unknown; builtinTools?: unknown }): Capabilities {
    if (typeof input.agentSkills !== 'boolean') {
      throw new TypeError('agentSkills must be boolean')
    }
    if (input.builtinTools !== undefined) {
      if (
        typeof input.builtinTools !== 'string' ||
        !(BUILTIN_TOOLS_LEVELS as readonly string[]).includes(input.builtinTools)
      ) {
        throw new TypeError('builtinTools must be "off" | "readonly" | "full"')
      }
    }
    const current = get()
    const next: Capabilities = {
      // builtinTools 缺省时保留旧值——兼容只写 agentSkills 的调用面（T96 前形状）
      builtinTools: (input.builtinTools as BuiltinToolsLevel | undefined) ?? current.builtinTools,
      agentSkills: input.agentSkills,
      // disabledSkills 不动——与 builtinTools 缺省保留同模式（管理面单件 toggle 走 setDisabledSkills）
      disabledSkills: current.disabledSkills
    }
    writeToDisk(next)
    cache = next
    return next
  }

  function projectSkill(skill: Skill): ManifestSkillEntry {
    // 脱敏：仅透传 name/description；缺 description 兜空串（chips 渲染统一）
    return {
      name: skill.name,
      description: typeof skill.description === 'string' ? skill.description : ''
    }
  }

  /**
   * 可见 skill 合集（双源合并）：用户层先于内置层扫描，同名先到先得——
   * 与 SDK loadSkills 的 collision 语义（skillMap 先扫者赢）及 service.ts
   * additionalSkillPaths [userDir, builtinDir] 顺序一致；chips 清单、宿主
   * 展开、SDK 运行时装配三面因此看到同一份赢家。
   *
   * 返回 { skill, source }[]——source 字段携带合并赢家层归属（管理面
   * listSkillsForManagement 需要 source 标记来源层）。
   */
  function loadVisibleSkillsWithSource(): Array<{ skill: Skill; source: 'user' | 'builtin' }> {
    const merged = new Map<string, { skill: Skill; source: 'user' | 'builtin' }>()
    const sources = [
      [resolveSkillsDir(rootDir), 'user'],
      [builtinSkillsDir, 'builtin']
    ] as const
    for (const [dir, source] of sources) {
      if (!dir || !existsSync(dir)) continue
      for (const skill of loadSkillsFromDir({ dir, source }).skills) {
        if (!merged.has(skill.name)) merged.set(skill.name, { skill, source })
      }
    }
    return [...merged.values()]
  }

  /** 脱敏 source 标记（带 source 字段的合并合集）——管理面用 */
  function listSkillsForManagement(): ManagedSkillEntry[] {
    const caps = get()
    const disabled = new Set(caps.disabledSkills)
    return loadVisibleSkillsWithSource().map(({ skill, source }) => ({
      ...projectSkill(skill),
      source,
      enabled: !disabled.has(skill.name)
    }))
  }

  function listSkills(): ManifestSkillEntry[] {
    const caps = get()
    if (!caps.agentSkills) return []
    const disabled = new Set(caps.disabledSkills)
    return loadVisibleSkillsWithSource()
      .filter(({ skill }) => !disabled.has(skill.name))
      .map(({ skill }) => projectSkill(skill))
  }

  /** SKILL.md frontmatter 剥离（SDK stripFrontmatter 未导出；frontmatter = 文件头 --- 包裹块） */
  function stripSkillFrontmatter(content: string): string {
    return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  }

  function expandSkillText(text: string): string {
    if (!get().agentSkills) return text
    const merged = loadVisibleSkillsWithSource()
    if (merged.length === 0) return text
    const disabled = new Set(get().disabledSkills)
    return text.replace(
      /\/skill:([A-Za-z0-9_-]+)/g,
      (match: string, name: string, offset: number, whole: string) => {
        const entry = merged.find((m) => m.skill.name === name)
        // 未知 skill 名透传（SDK _expandSkillCommand 同语义）；
        // 被禁件同样按未知名透传（与 SDK noSkills 查无 skill 透传同语义）
        if (!entry || disabled.has(entry.skill.name)) return match
        const skill = entry.skill
        // 与 SDK 展开块同构（agent-session.js:965）：模型经 location/baseDir
        // 读取 skill 引用的相对资源
        const body = stripSkillFrontmatter(readFileSync(skill.filePath, 'utf8'))
        const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
        // 就地展开的呼吸间隔：紧贴前后的正文（尤其中文混排无空格）用空行
        // 隔开，让 skill 块在消息体内边界清晰
        const before = offset > 0 && !/\s/.test(whole[offset - 1]) ? '\n\n' : ''
        const afterIndex = offset + match.length
        const after = afterIndex < whole.length && !/\s/.test(whole[afterIndex]) ? '\n\n' : ''
        return `${before}${block}${after}`
      }
    )
  }

  function setDisabledSkills(input: unknown): string[] {
    if (!Array.isArray(input)) {
      throw new TypeError('disabledSkills must be an array of strings')
    }
    const normalized = normalizeDisabledSkills(input)
    const current = get()
    const next: Capabilities = {
      builtinTools: current.builtinTools,
      agentSkills: current.agentSkills,
      disabledSkills: normalized
    }
    writeToDisk(next)
    cache = next
    return [...normalized]
  }

  return { get, set, listSkills, listSkillsForManagement, setDisabledSkills, expandSkillText }
}
