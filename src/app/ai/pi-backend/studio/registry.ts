/**
 * T43 studio 机制——两源扫描 / 同 id 覆盖 / 注册表 / reload。
 *
 * 规格真源：doc/S2-asset-files-spec.md v2 §1（机制总览）/ §2（目录与文件布局）/
 * §8（加载失败与空态）。加载顺序：内置 → 用户目录覆盖 → 校验 → 注册表（内存）。
 * 热重载 v1 降级为显式 `reloadStudio()`（S2 §2 授权；fs.watch 不做，T43-plan D-c）。
 *
 * 路径约定：调用方注入 rootDir（仓库根），内置目录 =
 * `<rootDir>/src/app/ai/pi-backend/studio/`；用户目录 = `~/.dianjing/studio/`
 * （rootDir 注入模型与 service.ts 一致，T24 起在线）。
 *
 * T85（资产 references 按需读取机制）：三类资产 frontmatter 可选 `references`
 * （validate.ts 纯函数校验形态）；本模块加载期做**文件存在性检查**（相对资产文件
 * 所在目录解析）——缺失条目摘出注册资产 + failures 显式条目（S2 §8：frontmatter
 * 病态整条不注册，文件缺失不连坐资产本体），命中条目进 resolvedReferences
 * 内部桶（绝对路径不出后端进程，manifest 不投影）。
 *
 * P2-9（2026-09-07）：目录布局重组——资产本体与 references 子目录同目录
 * （`workflows/<id>/workflow.md + references/`、`profiles/<id>/profile.md + references/`）。
 * 扫描器仅扫子目录：workflows 下形如 id/workflow.md，profiles 下形如 id/profile.md，id = 目录名。
 * references 子目录中的文件不再走资产扫描器（仅 resolveReferences 按需解析）。
 * `base.md` 保持 `studio/base.md` 单文件不变。
 *
 * P2-10 储备（2026-09-07）：`_` 前缀目录扫描时跳过不注册——为 P2-11 seed 模板
 * （用户目录内置 `_example/_seed` 占位）让路，内置与用户同口径。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { readStudioBuiltinDir } from '@/app/orchestration/env'

import { resolveStudioDirs } from '../paths'
import { splitFrontmatter, type ParsedAsset } from './parse'
import {
  referenceBucketKey,
  type StudioAssetReference,
  type StudioBase,
  type StudioFailure,
  type StudioMode,
  type StudioOrigin,
  type StudioProfile,
  type StudioRegistry,
  type StudioWorkflow
} from './types'
import {
  parseReferences,
  validateBase,
  validateProfile,
  validateWorkflow,
  type ValidationIssue
} from './validate'

/** P2-9：资产本体文件名（与目录同构——id 挂到目录名） */
const WORKFLOW_FILENAME = 'workflow.md'
const PROFILE_FILENAME = 'profile.md'

interface Candidate {
  id: string
  origin: StudioOrigin
  path: string
  /** 相对 origin 目录的相对路径，统一正斜杠（failures 数据面用——绝对路径不进注册表，T45；跨平台渲染口径一致） */
  relPath: string
}

/** P2-9：扫描 `parentDir` 下形如 `<id>/<filename>` 的子目录（顶层 .md 一律忽略）。
 *  `_` 前缀目录扫描时跳过不注册（P2-11 seed 模板预留）。返回按 id 排序的目录列表。 */
function listAssetDirs(parentDir: string): string[] {
  if (!existsSync(parentDir)) return []
  try {
    return readdirSync(parentDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 内置 → 用户顺序收集候选；同 id 用户覆盖内置（S2 §2 分层覆盖）。
 *  P2-9：扫描的是 `parentDir/<id>/<filename>`（目录名 = id），与原 `parentDir/*.md` 同口径。 */
function collectCandidates(
  builtinDir: string,
  userDir: string,
  subdir: string,
  filename: string
): Candidate[] {
  const byId = new Map<string, Candidate>()
  for (const [dir, origin] of [
    [join(builtinDir, subdir), 'builtin'],
    [join(userDir, subdir), 'user']
  ] as const) {
    for (const id of listAssetDirs(dir)) {
      byId.set(id, {
        id,
        origin,
        path: join(dir, id, filename),
        relPath: join(subdir, id, filename).replaceAll('\\', '/')
      })
    }
  }
  return [...byId.values()]
}

function readAndParse(candidate: Candidate): ParsedAsset {
  let raw: string
  try {
    raw = readFileSync(candidate.path, 'utf8')
  } catch (e) {
    return {
      ok: false,
      reason: `文件读取失败：${e instanceof Error ? e.message : String(e)}`,
      hint: '检查文件权限与编码（须为 utf-8）'
    }
  }
  return splitFrontmatter(raw)
}

function fail(
  failures: StudioFailure[],
  candidate: Candidate | null,
  kind: StudioFailure['kind'],
  reason: string,
  hint: string
): void {
  failures.push({
    path: candidate?.relPath ?? 'base.md',
    ...(candidate ? { origin: candidate.origin } : {}),
    kind,
    reason,
    hint
  })
}

/** resolvedReferences 桶（加载期累计，随注册表返回——内部面，manifest 不投影） */
type ResolvedBuckets = Map<string, Map<string, string>>

/**
 * T85 定谳 1/2：references 存在性检查与绝对路径解析。解析基 = **资产所在目录**
 * （P2-9 新布局：`workflows|profiles/<id>/`，references 子目录与资产本体同目录）。
 * 声明 `references/imagery.md` 即 `workflows|profiles/<id>/references/imagery.md`。
 * 命中 → 留在注册资产 + 进 resolved 桶；缺失 → 条目摘出 + failures 显式条目
 * （文件缺失不连坐资产本体——frontmatter 病态已在 validate 段整条拦下）。
 */
function resolveReferences(
  references: StudioAssetReference[] | undefined,
  candidate: Candidate,
  kind: 'base' | 'workflow' | 'profile',
  resolved: ResolvedBuckets,
  failures: StudioFailure[]
): StudioAssetReference[] | undefined {
  if (!references) return undefined
  const kept: StudioAssetReference[] = []
  for (const ref of references) {
    const abs = join(dirname(candidate.path), ref.path)
    if (existsSync(abs)) {
      kept.push(ref)
      let bucket = resolved.get(referenceBucketKey(kind, candidate.id))
      if (!bucket) {
        bucket = new Map()
        resolved.set(referenceBucketKey(kind, candidate.id), bucket)
      }
      bucket.set(ref.path, abs)
    } else {
      fail(
        failures,
        candidate,
        kind,
        `references 声明的「${ref.path}」文件不存在`,
        `补齐该文件（资产目录布局：workflows|profiles/${candidate.id}/${ref.path}），或从 frontmatter 删除该条声明`
      )
    }
  }
  return kept.length > 0 ? kept : undefined
}

/** base 唯一槽位：用户覆盖内置；双源皆缺 → 显式缺失态（S2 §8） */
function loadBase(
  builtinDir: string,
  userDir: string,
  resolved: ResolvedBuckets,
  failures: StudioFailure[]
): StudioBase | null {
  const baseCandidates = [
    {
      id: 'base',
      origin: 'builtin' as const,
      path: join(builtinDir, 'base.md'),
      relPath: 'base.md'
    },
    { id: 'base', origin: 'user' as const, path: join(userDir, 'base.md'), relPath: 'base.md' }
  ].filter((c) => existsSync(c.path))
  const baseCandidate = baseCandidates.at(-1) // 用户覆盖内置
  if (!baseCandidate) {
    fail(
      failures,
      null,
      'base',
      'base.md 缺失（内置集与用户目录均无）',
      'base 是所有 mode 共享的行为基座（每回合必组装，S2 §3）——补 `studio/base.md`'
    )
    return null
  }
  const parsed = readAndParse(baseCandidate)
  if (!parsed.ok) {
    fail(failures, baseCandidate, 'base', parsed.reason, parsed.hint)
    return null
  }
  if (parsed.frontmatter.id !== undefined && parsed.frontmatter.id !== 'base') {
    fail(
      failures,
      baseCandidate,
      'base',
      'base.md 的 frontmatter id 不是 `base`',
      'base 全局唯一：写 `id: base` 或删除 id 字段'
    )
    return null
  }
  // T85：base 同享 references 机制（校验同三类口径；病态 → base 不注册，同 id 错硬失败先例）
  // P2-7：version/deprecated 通用化由 validateBase 承载
  const referenceIssues: ValidationIssue[] = []
  const baseReferenceParse = parseReferences(parsed.frontmatter, referenceIssues)
  if (referenceIssues.length > 0) {
    for (const issue of referenceIssues) {
      fail(failures, baseCandidate, 'base', issue.reason, issue.hint)
    }
    return null
  }
  const { version, deprecated } = validateBase(parsed)
  const keptReferences = resolveReferences(
    baseReferenceParse.references,
    baseCandidate,
    'base',
    resolved,
    failures
  )
  const entry: StudioBase = {
    kind: 'base',
    id: 'base',
    body: parsed.body,
    origin: baseCandidate.origin,
    path: baseCandidate.path
  }
  if (keptReferences) entry.references = keptReferences
  if (version !== undefined) entry.version = version
  if (deprecated) entry.deprecated = deprecated
  return entry
}

/** workflows 先于 profiles 校验：modes 引用完整性需要已注册 mode 集合 */
function loadWorkflows(
  builtinDir: string,
  userDir: string,
  resolved: ResolvedBuckets,
  failures: StudioFailure[]
): Map<string, StudioWorkflow> {
  const workflows = new Map<string, StudioWorkflow>()
  for (const candidate of collectCandidates(builtinDir, userDir, 'workflows', WORKFLOW_FILENAME)) {
    const parsed = readAndParse(candidate)
    if (!parsed.ok) {
      fail(failures, candidate, 'workflow', parsed.reason, parsed.hint)
      continue
    }
    const { issues, stepBudget, subtitle, sizes, references, version, deprecated } =
      validateWorkflow(parsed, candidate.id)
    if (issues.length > 0) {
      for (const issue of issues) fail(failures, candidate, 'workflow', issue.reason, issue.hint)
      continue
    }
    const keptReferences = resolveReferences(references, candidate, 'workflow', resolved, failures)
    const workflowEntry: StudioWorkflow = {
      kind: 'workflow',
      id: candidate.id,
      label: String(parsed.frontmatter.label),
      body: parsed.body,
      origin: candidate.origin,
      path: candidate.path
    }
    if (subtitle) workflowEntry.subtitle = subtitle
    if (stepBudget !== undefined) workflowEntry.stepBudget = stepBudget
    if (sizes) workflowEntry.sizes = sizes
    if (keptReferences) workflowEntry.references = keptReferences
    if (version !== undefined) workflowEntry.version = version
    if (deprecated) workflowEntry.deprecated = deprecated
    workflows.set(candidate.id, workflowEntry)
  }
  return workflows
}

function loadProfiles(
  builtinDir: string,
  userDir: string,
  knownModeIds: ReadonlySet<string>,
  resolved: ResolvedBuckets,
  failures: StudioFailure[]
): Map<string, StudioProfile> {
  const profiles = new Map<string, StudioProfile>()
  for (const candidate of collectCandidates(builtinDir, userDir, 'profiles', PROFILE_FILENAME)) {
    const parsed = readAndParse(candidate)
    if (!parsed.ok) {
      fail(failures, candidate, 'profile', parsed.reason, parsed.hint)
      continue
    }
    const { issues, modes, version, deprecated, references } = validateProfile(
      parsed,
      candidate.id,
      knownModeIds
    )
    if (issues.length > 0) {
      for (const issue of issues) fail(failures, candidate, 'profile', issue.reason, issue.hint)
      continue
    }
    const keptReferences = resolveReferences(references, candidate, 'profile', resolved, failures)
    const profileEntry: StudioProfile = {
      kind: 'profile',
      id: candidate.id,
      label: String(parsed.frontmatter.label),
      modes,
      deprecated,
      body: parsed.body,
      origin: candidate.origin,
      path: candidate.path
    }
    if (version !== undefined) profileEntry.version = version
    if (keptReferences) profileEntry.references = keptReferences
    profiles.set(candidate.id, profileEntry)
  }
  return profiles
}

/**
 * 纯函数加载：给定内置/用户两目录，产出完整注册表（含 failures）。
 * 测试经本函数注入 fixture 目录，不依赖真实文件布局。
 */
export function loadStudioFromDirs(builtinDir: string, userDir: string): StudioRegistry {
  const failures: StudioFailure[] = []
  const resolved: ResolvedBuckets = new Map()
  const base = loadBase(builtinDir, userDir, resolved, failures)
  const workflows = loadWorkflows(builtinDir, userDir, resolved, failures)
  const knownModeIds = new Set<string>(['general', ...workflows.keys()])
  const profiles = loadProfiles(builtinDir, userDir, knownModeIds, resolved, failures)

  // ── mode 投影（PD-16：文件存在 = mode 可用；general 走 workflows/general.md
  //    统一走 workflow 派生，source 标记为 general 保持首位与历史语义；
  //    general.md 缺失时回退硬编码 general entry——保持「general 恒在」语义）──
  const modes: StudioMode[] = []
  const generalWorkflow = workflows.get('general')
  if (generalWorkflow) {
    const mode: StudioMode = {
      id: generalWorkflow.id,
      label: generalWorkflow.label,
      source: 'general' as const
    }
    if (generalWorkflow.subtitle) mode.subtitle = generalWorkflow.subtitle
    if (generalWorkflow.sizes) mode.sizes = generalWorkflow.sizes
    modes.push(mode)
  } else {
    // 回退：general.md 缺失（罕见，仅发生于用户删除或 fixture 场景）——保持
    // 「general 恒在」语义不破；不投影 sizes（无来源）
    modes.push({ id: 'general', label: '通用设计', source: 'general' })
  }
  for (const w of workflows.values()) {
    if (w.id === 'general') continue // 已在首位登记
    const mode: StudioMode = {
      id: w.id,
      label: w.label,
      source: 'workflow' as const
    }
    if (w.subtitle) mode.subtitle = w.subtitle
    if (w.sizes) mode.sizes = w.sizes
    modes.push(mode)
  }

  // 默认集整体缺失/全坏（S2 §8）：零注册成功且有失败 → 记整体态供错误条消费
  if (base === null && workflows.size === 0 && profiles.size === 0 && failures.length > 0) {
    failures.push({
      path: '.',
      origin: 'builtin',
      kind: 'studio',
      reason: 'studio 默认集整体缺失/全坏（无任何资产注册成功）',
      hint: '检查内置 studio/ 目录是否随应用分发；逐条修复上方文件级失败后重新加载'
    })
  }

  return { base, workflows, profiles, modes, failures, resolvedReferences: resolved }
}

// ── 进程级单例（启动加载 + 显式 reload；T43-plan D-c：fs.watch 不做）──

let current: StudioRegistry | null = null
let currentKey: string | null = null

function defaultDirs(rootDir: string): { builtinDir: string; userDir: string } {
  // 内置资产目录可被宿主经 env 显式改写：Electron 打包形态下内置资产随
  // extraResources 平铺到 resources/app/studio，rootDir（=userData）+ 源
  // 码树子路径的缺省解析找不到，由宿主注入真实位置；未注入时维持缺省。
  return resolveStudioDirs(rootDir, readStudioBuiltinDir())
}

/** 启动/重载加载（幂等）；rootDir = 仓库根（与 service.ts 的 rootDir 约定一致） */
export function reloadStudio(rootDir: string): StudioRegistry {
  const { builtinDir, userDir } = defaultDirs(rootDir)
  current = loadStudioFromDirs(builtinDir, userDir)
  currentKey = `${builtinDir}|${userDir}`
  return current
}

/**
 * 读当前注册表。未加载时按 rootDir 惰性加载一次；rootDir 缺省且从未加载 →
 * 抛错（调用方必须先经 reloadStudio(rootDir) 初始化——与 service 启动序一致）。
 */
export function getStudioRegistry(rootDir?: string): StudioRegistry {
  if (rootDir) {
    const { builtinDir, userDir } = defaultDirs(rootDir)
    const key = `${builtinDir}|${userDir}`
    if (current === null || currentKey !== key) return reloadStudio(rootDir)
    return current
  }
  if (current === null) {
    throw new Error('studio 注册表未初始化——先经 reloadStudio(rootDir) 加载')
  }
  return current
}
