/**
 * 2026-09-21 skill-installer v1 批 1：install_skill 桥工具（仓外
 * docs/202609201453-skill-installer-meta-skill-design.md §5 契约 + 运行时事实
 * 快照 docs/202609212224-skill-runtime-facts-snapshot.md）。
 *
 * 形态 = customTools 包装层（不新做 core 工具）——元 skill（内置 studio 层）
 * 把待装 skill 内容 byte-copies 到 staging 区后调本工具落地用户层。
 *
 * 校验面（全部硬拒 + 回报违规清单）：
 *  - name 硬闸 = SDK validateName 规则（≤64、^[a-z0-9-]+$、禁首尾/连续连字符；
 *    SDK 侧仅 warning，本工具唯一硬拒点）
 *  - SKILL.md 存在 + frontmatter name/description 非空
 *  - frontmatter 键 ∈ { name, description, disable-model-invocation }（快照 §1
 *    实证我方装配面零额外解释键；违则拒并回报违规键清单）
 *  - 与内置层现存 skill 撞名即拒（resolveBuiltinSkillsDir 扫描；快照 §3「撞名
 *    先载者胜」+ 设计稿「内置件静默遮蔽不可接受」）
 *  - 用户层同名走 overwrite:true + 备份分支
 *  - 目录内禁 scripts/ 可执行件（v1 硬拒——bash 层2-D 未落地前不放行）
 *  - source_dir 必须位于 `<rootDir>/workspace/skill-install-staging/` 下
 *    （界外拒收——保 workflow 诚实与声明面可核对）
 *  - 文件树条目禁 `..` / 绝对路径 / 符号链接，非常规文件拒
 *  - `.git` 与 `.` 开头隐藏件跳过不随装
 *  - 单文件 ≤5MB、总体积 ≤20MB（数值 v1 施工拍板）
 *
 * 闸门：复用 authz 族（pending-decision store + authz sink 推送 + decision-answer
 * 端点）——卡面 payload = data-authz-request（toolName: 'install_skill'，扩展
 * AuthzRequestNotice 联合判别）渲染将安装的文件清单 + 适配点摘要；
 * allow-once 放行、deny/abort/断连 = 拒装（与 bash 授权同族同待遇）。
 *
 * 写入：`<rootDir>/workspace/.agents/skills/<name>/`；overwrite 时旧目录移入
 * `<rootDir>/workspace/.agents/.skill-backups/<name>/<ts>/`，每 name 留最近 3 份
 * 顺手 prune（设计稿 §10 裁决 2）。
 *
 * 路径判定：工具体内直调 decidePath（load-image.ts 先例，broker P0-1 单一判定
 * 服务——read facet 走 staging 校验、write facet 走 skills/ 写入判定），与
 * key-guard 共享 path-decision 单源，不松 key-guard 任何既有面。
 *
 * 返回：{ 安装路径, 文件清单, name, 生效语义 = 下一会话, 调用方式 = /skill:<name> }。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { parse as parseYaml } from 'yaml'

import { type AuthzNoticeSink } from './authz-guard'
import { decidePath } from './path-decision'
import { resolveSkillsDir, resolveWorkspaceDir } from './paths'
import { type AuthzAnswerPayload, type PendingDecisionStore } from './pending-decision'
import { toToolResult } from './tool-result'

/** frontmatter 白名单（快照 §1：SDK 只读三键、我方零额外键；违键即拒） */
const FRONTMATTER_ALLOWED_KEYS = new Set(['name', 'description', 'disable-model-invocation'])

/** name 硬闸（SDK validateName 同口径——skills.js:61-76 实证） */
const NAME_REGEX = /^[a-z0-9-]+$/
const NAME_MAX_LENGTH = 64

/** 单文件 / 总体积上限（v1 拍板——skill 皆文本小件，留量给 references/assets） */
const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

/** 备份保留份数（设计稿 §10 裁决 2） */
const BACKUP_KEEP = 3

/** staging 子路径 = workspace 下固定子目录 */
const STAGING_PARENT = 'skill-install-staging'

/** 备份目录 = skills/ 兄弟目录（additionalSkillPaths 不喂，永不当 skill 加载） */
const BACKUP_PARENT = '.skill-backups'

const INSTALL_SKILL_DESCRIPTION = `Install a skill from a staging directory into the user-skill folder.

The staging directory must live at \`<rootDir>/workspace/skill-install-staging/<slug>/\` — sources outside this path are rejected (the user-skill install workflow guarantees a contained staging copy). Provide the directory's absolute path and the target skill \`name\` (matching SDK name rules: lowercase letters/digits/hyphens, ≤64 chars, no leading/trailing/consecutive hyphens).

Validation (all hard rejects; errors enumerate every violation):
  - \`name\` follows SDK rules
  - SKILL.md exists with non-empty \`name\` and \`description\` frontmatter keys
  - frontmatter contains only \`name\`, \`description\`, \`disable-model-invocation\` (any other key is rejected)
  - no \`scripts/\` executable directory (v1 hardening — rejected for safety)
  - no symlinks, no \`..\` / absolute entries, no irregular files
  - skipped: \`.\`-prefix entries (including \`.git\`), \`node_modules\`
  - ≤5 MB per file, ≤20 MB total
  - no collision with a built-in skill of the same \`name\`
  - same-name in the user layer requires \`overwrite: true\` (existing dir is moved to backup first; ≤3 backups retained, oldest pruned)

After install the skill loads in the NEXT session (the front-end manifest refreshes on combobox open / new session). Invoke via \`/skill:<name>\` or set \`disable-model-invocation: true\` for explicit-only. The source \`source_dir\` is not modified.`

export interface InstallSkillToolDeps {
  rootDir: string
  /** broker pending-decision 单例（service 装配期注入；与 authz-guard 同实例） */
  store: PendingDecisionStore
  /** 当次 session id（pending 注册键） */
  sessionId: string
  /** per-session authz 直推缝（service.runPrompt 装配期注入 emit） */
  authzSink: AuthzNoticeSink
  /** 内置 skills 目录（可选——无内置层则跳过撞名校验） */
  builtinSkillsDir?: string
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 工具结果 details 形状（错误面 + 成功面并集，测试钉扎用） */
export type InstallSkillDetails = {
  error?: string
  reason?: 'denied' | 'invalid' | 'conflict'
  /** 校验违规清单（reason=invalid 时填） */
  violations?: string[]
  /** 撞名 / overwrite 缺旗标（reason=conflict 时填） */
  conflictWith?: 'builtin' | 'user'
  /** 成功面 */
  path?: string
  files?: string[]
  name?: string
  effectiveNextSession?: true
  invocation?: string
  /** overwrite 时记一笔（备份目录路径） */
  backupPath?: string
}

function invalid(violations: string[]): InstallSkillDetails {
  return { reason: 'invalid', violations }
}

function conflictResult(violation: string, conflictWith: 'builtin' | 'user'): InstallSkillDetails {
  return { error: violation, reason: 'conflict', conflictWith }
}

// ── 公共校验原语（测试直钉；不依赖 SDK 私有导出）──

/** name 硬闸——返回违规清单（与 SDK skills.js validateName 同口径） */
export function validateSkillName(name: string): string[] {
  const errors: string[] = []
  if (name.length === 0) errors.push('name is empty')
  if (name.length > NAME_MAX_LENGTH) {
    errors.push(`name exceeds ${NAME_MAX_LENGTH} characters (${name.length})`)
  }
  if (!NAME_REGEX.test(name)) {
    errors.push('name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)')
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('name must not start or end with a hyphen')
  }
  if (name.includes('--')) {
    errors.push('name must not contain consecutive hyphens')
  }
  return errors
}

/**
 * 自实现 frontmatter 解析——SDK parseFrontmatter 未公开导出（仅 utils/frontmatter.js
 * 内部用，dist/index.ts 不 re-export）。算法按 SDK frontmatter.js 同形复刻：
 * 行归一 → `---` 起首定位 → `\n---` 收尾定位 → yaml.parse。null/undefined 兜底 {}
 * ——SDK 实证 `parsed ?? {}`。
 */
export function parseSkillFrontmatter(raw: string): Record<string, unknown> {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.startsWith('---')) return {}
  const endIndex = normalized.indexOf('\n---', 3)
  if (endIndex === -1) return {}
  const yamlString = normalized.slice(4, endIndex)
  if (yamlString.trim() === '') return {}
  try {
    const parsed: unknown = parseYaml(yamlString)
    if (parsed === null || parsed === undefined) return {}
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // 具名重建替代 Record cast（门禁禁 as Record<string, unknown>）
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(parsed)) result[key] = value
    return result
  } catch {
    return {}
  }
}

/** SKILL.md frontmatter 完整校验（白名单 + name/description 非空） */
export function validateSkillFrontmatter(
  raw: string
):
  | { ok: true; name: string; description: string; disableModelInvocation: boolean }
  | { ok: false; violations: string[] } {
  const frontmatter = parseSkillFrontmatter(raw)
  const allKeys = Object.keys(frontmatter)
  const violations: string[] = []
  for (const key of allKeys) {
    if (!FRONTMATTER_ALLOWED_KEYS.has(key)) {
      violations.push(`frontmatter key not allowed: ${key}`)
    }
  }
  const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : ''
  const description =
    typeof frontmatter['description'] === 'string' ? frontmatter['description'] : ''
  if (name.trim() === '') violations.push('frontmatter name is empty')
  if (description.trim() === '') violations.push('frontmatter description is empty')
  if (violations.length > 0) return { ok: false, violations }
  const disableModelInvocation = frontmatter['disable-model-invocation'] === true
  return { ok: true, name, description, disableModelInvocation }
}

/** 单条 staging 文件扫描产物 */
export interface PlannedFile {
  /** 暂存区相对路径（POSIX 形态） */
  relPath: string
  /** 字节数 */
  size: number
}

/** staging 扫描完整产物：文件清单 + 校验违规 + 字节总和 */
export interface StagingScan {
  files: PlannedFile[]
  violations: string[]
  totalBytes: number
}

/** 路径字面解析（禁 node path.isAbsolute 等平台语义 API）：先统一分隔符再判 */
function hasParentSegment(relPath: string): boolean {
  return relPath.split('/').includes('..')
}

function isAbsoluteRel(relPath: string): boolean {
  if (relPath.startsWith('/')) return true
  if (relPath.length >= 2 && relPath[1] === ':' && /[a-zA-Z]/.test(relPath[0] ?? '')) return true
  return false
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

/** 把绝对路径归一到小写正斜杠形态（与 path-decision compare 同口径） */
function toComparePath(abs: string): string {
  return stripTrailingSep(abs.replaceAll('\\', '/')).toLowerCase()
}

/**
 * 递归扫描 staging 目录（不跟随符号链接）——返回文件清单 + 校验违规。
 *
 * 校验（命中即加入 violations，文件清单跳过该条；保证后续写盘面无越界条目）：
 *  - 跳过 `.` 开头条目（含 .git）
 *  - 跳过 node_modules
 *  - staging 根下一级 `scripts/` 目录硬拒（v1：bash 层2-D 未落地前不放行）
 *  - 符号链接 / 非常规文件 → 拒
 *  - 路径含 `..` 或绝对 → 拒
 *  - 单文件超 MAX_SINGLE_FILE_BYTES → 拒
 *  - 总体积超 MAX_TOTAL_BYTES → 拒（命中即停）
 */
export function scanStaging(stagingAbs: string): StagingScan {
  const out: StagingScan = { files: [], violations: [], totalBytes: 0 }
  const walk = (abs: string, relSegments: string[]): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch (error) {
      out.violations.push(
        `failed to read directory: ${relSegments.join('/') || '/'}: ${toErrorMessage(error)}`
      )
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith('.')) continue
      if (name === 'node_modules') continue
      if (relSegments.length === 0 && name === 'scripts') {
        out.violations.push('scripts/ directory is forbidden in v1 (rejected for safety)')
        continue
      }
      const childAbs = `${abs}${sep}${name}`
      const childRel = [...relSegments, name]
      const relPath = childRel.join('/')
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      const isSymlink = entry.isSymbolicLink()
      if (isSymlink) {
        try {
          const stats = statSync(childAbs)
          isDirectory = stats.isDirectory()
          isFile = stats.isFile()
        } catch {
          out.violations.push(`symlink not followed (broken or unreadable): ${relPath}`)
          continue
        }
      }
      if (isSymlink) {
        out.violations.push(`symbolic link not allowed: ${relPath}`)
        continue
      }
      if (!isDirectory && !isFile) {
        out.violations.push(`irregular file (not dir or regular file): ${relPath}`)
        continue
      }
      if (isDirectory) {
        walk(childAbs, childRel)
        continue
      }
      if (hasParentSegment(relPath) || isAbsoluteRel(relPath)) {
        out.violations.push(`illegal path segment (../ or absolute): ${relPath}`)
        continue
      }
      const stats = statSync(childAbs)
      if (stats.size > MAX_SINGLE_FILE_BYTES) {
        out.violations.push(
          `file exceeds ${MAX_SINGLE_FILE_BYTES / 1024 / 1024} MB limit: ${relPath} (${stats.size} bytes)`
        )
        continue
      }
      out.totalBytes += stats.size
      if (out.totalBytes > MAX_TOTAL_BYTES) {
        out.violations.push(
          `total size exceeds ${MAX_TOTAL_BYTES / 1024 / 1024} MB limit (stops accumulating after violation)`
        )
        return
      }
      out.files.push({ relPath, size: stats.size })
    }
  }
  walk(stagingAbs, [])
  return out
}

/** 内置层撞名扫描：列 builtinSkillsDir 下含 SKILL.md 的子目录名 */
export function listBuiltinSkillNames(builtinSkillsDir: string): string[] {
  const names: string[] = []
  if (!existsSync(builtinSkillsDir)) return names
  let entries: Dirent[]
  try {
    entries = readdirSync(builtinSkillsDir, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    const skillMd = `${builtinSkillsDir}${sep}${entry.name}${sep}SKILL.md`
    if (existsSync(skillMd)) names.push(entry.name)
  }
  return names
}

function buildAdapterSummary(scan: StagingScan, description: string): string {
  const trimmed = description.length > 200 ? `${description.slice(0, 197)}...` : description
  return [
    'files: ' + scan.files.length,
    'total size: ' + (scan.totalBytes / 1024).toFixed(1) + ' KB',
    'description: ' + trimmed
  ].join('\n')
}

function timestampForBackup(date: Date): string {
  const pad = (n: number, w = 2): string => n.toString().padStart(w, '0')
  return (
    `${date.getFullYear().toString().padStart(4, '0')}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  )
}

/** formId 后缀：测试可注入确定性；缺省 = 随机 8 hex */
function defaultRandomFormId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** 备份 prune——按 mtime 倒序裁尾到 BACKUP_KEEP 份 */
function pruneBackups(backupRoot: string, name: string): void {
  const parent = `${backupRoot}${sep}${name}`
  if (!existsSync(parent)) return
  const entries = readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((entry) => {
      const abs = `${parent}${sep}${entry.name}`
      try {
        const stats = statSync(abs)
        return { abs, mtimeMs: stats.mtimeMs }
      } catch {
        return { abs, mtimeMs: 0 }
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const toRemove = entries.slice(BACKUP_KEEP)
  for (const entry of toRemove) {
    try {
      rmSync(entry.abs, { recursive: true, force: true })
    } catch (error) {
      // 备份是 nice-to-have，prune 失败不阻断主流程——但必须留痕（禁静默吞）
      console.warn(
        '[install-skill] 备份 prune 失败（不阻断安装）',
        entry.abs,
        toErrorMessage(error)
      )
    }
  }
}

/** runInstall 分段校验的失败面（details 直返调用方） */
type ValidationFailure = { ok: false; details: InstallSkillDetails }

/** 步骤 2-3：路径判定（read facet）+ staging 根下限定（归一化前缀比对，禁平台路径 API） */
function resolveStagingDir(
  sourceDir: string,
  rootDir: string
): { ok: true; stagingAbs: string } | ValidationFailure {
  const workspaceDir = resolveWorkspaceDir(rootDir)
  const srcDecision = decidePath(sourceDir, {
    facet: 'read',
    rootDir,
    cwd: workspaceDir,
    homeDir: rootDir // 测试隔离：homeDir = rootDir（绝对无碰撞的假根）
  })
  if (!srcDecision.ok) {
    return { ok: false, details: { error: srcDecision.error, reason: 'denied' } }
  }
  const stagingAbs = srcDecision.absolutePath
  const stagingRootCompare = toComparePath(join(workspaceDir, STAGING_PARENT))
  const stagingAbsCompare = toComparePath(stagingAbs)
  const insideStaging =
    stagingAbsCompare === stagingRootCompare ||
    stagingAbsCompare.startsWith(stagingRootCompare + '/')
  if (!insideStaging) {
    return {
      ok: false,
      details: invalid([
        `source_dir must be inside <rootDir>/workspace/${STAGING_PARENT}/ (got ${stagingAbs})`
      ])
    }
  }
  if (!existsSync(stagingAbs)) {
    return { ok: false, details: invalid([`source_dir does not exist: ${stagingAbs}`]) }
  }
  if (!statSync(stagingAbs).isDirectory()) {
    return { ok: false, details: invalid([`source_dir is not a directory: ${stagingAbs}`]) }
  }
  return { ok: true, stagingAbs }
}

type ValidSkillFrontmatter = Extract<ReturnType<typeof validateSkillFrontmatter>, { ok: true }>

/** 步骤 4-5：staging 扫描 + SKILL.md frontmatter 校验（白名单 + name 对齐参数） */
function validateStagingContent(
  stagingAbs: string,
  name: string
): { ok: true; scan: StagingScan; fm: ValidSkillFrontmatter } | ValidationFailure {
  const scan = scanStaging(stagingAbs)
  if (scan.violations.length > 0) return { ok: false, details: invalid(scan.violations) }
  let fm: ReturnType<typeof validateSkillFrontmatter>
  try {
    fm = validateSkillFrontmatter(readFileSync(`${stagingAbs}${sep}SKILL.md`, 'utf-8'))
  } catch (error) {
    return { ok: false, details: invalid([`failed to read SKILL.md: ${toErrorMessage(error)}`]) }
  }
  if (!fm.ok) return { ok: false, details: invalid(fm.violations) }
  if (fm.name !== name) {
    return {
      ok: false,
      details: invalid([`frontmatter name "${fm.name}" does not match requested name "${name}"`])
    }
  }
  return { ok: true, scan, fm }
}

/** 步骤 6：撞名校验（内置层硬拒；用户层同名需 overwrite 旗标） */
function checkNameCollision(args: {
  name: string
  overwrite: boolean
  builtinSkillsDir?: string
  skillsDir: string
}): { ok: true; userTargetDir: string; userExists: boolean } | ValidationFailure {
  const { name, overwrite, builtinSkillsDir, skillsDir } = args
  if (builtinSkillsDir !== undefined && listBuiltinSkillNames(builtinSkillsDir).includes(name)) {
    return {
      ok: false,
      details: conflictResult(
        `Skill name "${name}" collides with a built-in skill — built-in skills cannot be overwritten.`,
        'builtin'
      )
    }
  }
  const userTargetDir = `${skillsDir}${sep}${name}`
  const userExists = existsSync(userTargetDir)
  if (userExists && !overwrite) {
    return {
      ok: false,
      details: conflictResult(
        `Skill "${name}" already exists in the user layer — pass overwrite:true to replace (the existing directory will be moved to backup first).`,
        'user'
      )
    }
  }
  return { ok: true, userTargetDir, userExists }
}

/**
 * 全流程可测入口（测试直钉——defineTool 包装的 execute() 会先校验 toolCallId
 * 形态；runInstall 是纯逻辑入口，测试可注入 store / sink / 时间）
 */
export async function runInstall(args: {
  sourceDir: string
  name: string
  overwrite: boolean
  rootDir: string
  store: PendingDecisionStore
  sessionId: string
  authzSink: AuthzNoticeSink
  builtinSkillsDir?: string
  /** 测试注入 formId 后缀（确定随机串）；缺省 = 随机 hex */
  formIdSuffix?: string
  /** 测试注入时间（备份时间戳）；缺省 = new Date() */
  now?: Date
}): Promise<InstallSkillDetails> {
  const {
    sourceDir,
    name,
    overwrite,
    rootDir,
    store,
    sessionId,
    authzSink,
    builtinSkillsDir,
    formIdSuffix,
    now
  } = args
  const currentTime = now ?? new Date()

  // 1. name 硬闸
  const nameErrors = validateSkillName(name)
  if (nameErrors.length > 0) return invalid(nameErrors)

  // 2-3. 路径判定 + staging 根下限定
  const stagingResolution = resolveStagingDir(sourceDir, rootDir)
  if (!stagingResolution.ok) return stagingResolution.details
  const { stagingAbs } = stagingResolution

  // 4-5. staging 扫描 + frontmatter 校验
  const content = validateStagingContent(stagingAbs, name)
  if (!content.ok) return content.details
  const { scan, fm } = content

  // 6. 撞名校验
  const skillsDir = resolveSkillsDir(rootDir)
  const collision = checkNameCollision({
    name,
    overwrite,
    ...(builtinSkillsDir !== undefined ? { builtinSkillsDir } : {}),
    skillsDir
  })
  if (!collision.ok) return collision.details
  const { userTargetDir, userExists } = collision

  // 7. 闸门：注册 authz pending（卡面 = 文件清单 + 适配点摘要）
  const formId = `install-skill-${formIdSuffix ?? defaultRandomFormId()}`
  const files = scan.files.map((f) => f.relPath)
  const registration = store.registerAuthz(sessionId, formId)
  if (registration.alreadyPending) {
    return {
      error:
        'Install skill not run: another form or authorization request is still awaiting the user; wait for it to resolve before retrying.',
      reason: 'denied'
    }
  }
  // 先注册后推卡：alreadyPending 早返时若已推卡，UI 会挂一张永远无人能决的死卡
  authzSink.emit?.({
    type: 'data-authz-request',
    id: formId,
    data: {
      formId,
      kind: 'authz',
      toolName: 'install_skill',
      sourceDir: stagingAbs,
      name,
      overwrite,
      files,
      adapterSummary: buildAdapterSummary(scan, fm.description)
    }
  })

  let answer: AuthzAnswerPayload
  try {
    answer = await registration.promise
  } catch {
    authzSink.emit?.({
      type: 'data-authz-decision',
      id: formId,
      data: { formId, kind: 'authz', decision: 'deny' }
    })
    return {
      error:
        'Install skill not run: the authorization request was aborted (run cancelled or client disconnected) — unattended runs default to deny.',
      reason: 'denied'
    }
  }
  authzSink.emit?.({
    type: 'data-authz-decision',
    id: formId,
    data: { formId, kind: 'authz', decision: answer.decision }
  })

  if (answer.decision !== 'allow-once') {
    // allow-rule 在 install_skill 不启用（无规则记忆）；其它（deny）→ 拒装
    const note = answer.note ? ` User note: ${answer.note}` : ''
    return {
      error:
        `Install skill denied by the user: ${name}. ` +
        `Reason: the user declined the authorization request.${note}`,
      reason: 'denied'
    }
  }

  // 8. 写入（overwrite 时先备份整目录）
  // join 折叠 ..；目标目录不可预建——Windows MoveFile 拒 rename 到已存在目录（EPERM）
  const backupRoot = join(skillsDir, '..', BACKUP_PARENT)
  let backupPath: string | undefined
  if (userExists) {
    const ts = timestampForBackup(currentTime)
    const target = join(backupRoot, name, ts)
    mkdirSync(join(backupRoot, name), { recursive: true })
    renameSync(userTargetDir, target)
    backupPath = target
    pruneBackups(backupRoot, name)
  }
  mkdirSync(userTargetDir, { recursive: true })

  for (const file of files) {
    const relSegments = file.split('/')
    const fromAbs = `${stagingAbs}${sep}${relSegments.join(sep)}`
    const toAbs = `${userTargetDir}${sep}${relSegments.join(sep)}`
    mkdirSync(dirname(toAbs), { recursive: true })
    const data = readFileSync(fromAbs, 'utf-8')
    writeFileSync(toAbs, data)
  }

  return {
    path: userTargetDir,
    files,
    name,
    effectiveNextSession: true,
    invocation: `/skill:${name}`,
    ...(backupPath ? { backupPath } : {})
  }
}

export function createInstallSkillTool(deps: InstallSkillToolDeps) {
  return defineTool({
    name: 'install_skill',
    label: 'Install Skill',
    description: INSTALL_SKILL_DESCRIPTION,
    parameters: Type.Object({
      source_dir: Type.String({
        description:
          'Absolute path to the staging directory (must be inside <rootDir>/workspace/skill-install-staging/)'
      }),
      name: Type.String({
        description:
          'Target skill name (SDK name rules: lowercase letters/digits/hyphens, ≤64 chars)'
      }),
      overwrite: Type.Optional(
        Type.Boolean({
          description:
            'Set true to overwrite an existing user-layer skill of the same name (existing dir is moved to backup first)'
        })
      )
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const detail = await runInstall({
        sourceDir: params.source_dir,
        name: params.name,
        overwrite: params.overwrite === true,
        rootDir: deps.rootDir,
        store: deps.store,
        sessionId: deps.sessionId,
        authzSink: deps.authzSink,
        ...(deps.builtinSkillsDir !== undefined ? { builtinSkillsDir: deps.builtinSkillsDir } : {})
      })
      return toToolResult(detail)
    }
  })
}
