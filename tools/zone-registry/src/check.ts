/**
 * Zone registry purity check (rebuild/v2).
 *
 * Verifies the working tree against tools/zone-registry/zones.json:
 *  1. Every upstream file modified vs merge-base is a registered patch
 *     (revoked patches do NOT whitelist).
 *  2. Every deleted upstream file is registered in deletedPaths
 *     (exact match or under a deleted directory prefix); files under
 *     ownedRoots are exempt — they are ours, deleting them needs no
 *     registration (2026-09-05 分区优化方案 §5.3, owner 决策 #7).
 *  3. deletedPaths do not exist on disk.
 *  4. New files (added vs merge-base) live under ownedRoots.
 *  5. Renames are decomposed (old path = deletion, new path = addition);
 *     typechanges (T, e.g. symlink→file) count as modifications;
 *     other unexpected git statuses (C/U/…) fail loudly.
 *  6. T36 registry-health rules (owner 拍板④, hard-fail):
 *     R-exist — every non-revoked patch's file must exist on disk;
 *     R-diff  — every non-revoked patch's file must differ from base
 *               (phantom patches on byte-identical files are violations);
 *     R-mutex — a non-revoked patch's file must not overlap
 *               ownedFiles/stubs/deletedPaths (no double accounting).
 *
 * pendingReclass is planning metadata only (see zones.json $comment):
 * modifications there are governed by rule 1 like everywhere else.
 * LFS fixtures under tests/fixtures/ are covered by rule 1 — the clean
 * filter normalizes real-content-over-pointer to a no-op, while any real
 * content change (e.g. force-added binaries) fails as unregistered.
 *
 * Usage: bun tools/zone-registry/src/check.ts [--base <ref>]  (default base: merge-base with upstream/master)
 *        bun tools/zone-registry/src/check.ts --patches-report [--base <ref>]
 *        bun tools/zone-registry/src/check.ts --drift  （T64：追加 GHOST 等上游活动窗口规则——
 *          输入是外生的上游节奏，owner 2026-09-01 拍板降为雷达，不进 push 门禁；
 *          2026-09-05 方案 §5.1 去 cron 化——改由 ci.yml 非阻断 job 在 push rebuild/** 时跑；
 *          §5.2 补对称规则 PATCH_TARGET_DELETED_UPSTREAM：patch 锚定文件被上游删除即报）
 *          RELOCATION_WATCH（2026-09-05，方案 §6）：搬移台账 advisory——
 *          上游对 relocations[*].oldPath 的后续改动（name-status -M 命中）打移植评估摘要，
 *          永不 fail gate（与 GHOST 同属上游活动窗口规则的轻量侧，不进 push 门禁；默认模式
 *          只打摘要行、--drift 追加每文件明细）；不计 violation、不改退出码）
 *          T28（决策单 #5，轻量过堂机制）：报告模式——逐条补丁输出相对
 *          upstream merge-base 的当前 diff 行数摘要（numstat），供过堂审视
 *          补丁腐烂度；只读报告，恒 exit 0，不参与主检查判红。
 * Exit 0 = clean; exit 1 = violations listed on stderr.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compact } from 'es-toolkit'

/** 向上走到仓根（含 bun.lock 的目录）——lint 禁 import.meta 起两级以上字面值攀爬 */
function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'bun.lock'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`workspace root not found from ${import.meta.url}`)
    dir = parent
  }
}

const root = workspaceRoot()

interface Zones {
  ownedRoots: string[]
  ownedFiles: string[]
  stubs: string[]
  pendingReclass: string[]
  patches: {
    id: string
    file: string
    reason: string
    disposition: string
    /** T28（决策单 #5）：上次过堂日期（YYYY-MM-DD），轻量机制——登记即视为过堂 */
    lastReviewed?: string
  }[]
  deletedPaths: string[]
  /** T32：tarball/tarball 替换式合并的结构化登记——byte 一致的拷贝走此字段
   *  而非 ownedFile 兜底，机器可解析；每条记录锚定上游 base SHA + paths +
   *  deletedPaths + 登记任务号 + 上次过堂日期。 */
  upstreamMergeTarball?: Array<{
    base: string
    paths: string[]
    deletedPaths: string[]
    task: string
    lastReviewed: string
  }>
  /** 搬移台账（2026-09-05，方案 §6，owner 拍板建立机制）：登记历史搬移事件——
   *  上游旧位置 → fork 新家园（空数组 = 纯裁撤无继承者）。与 deletedPaths 互补
   *  （deletedPaths 管删除事实，本表管搬移意图与去向）。check.ts RELOCATION_WATCH
   *  规则据此对 upstreamBase..upstream/master name-status diff 做命中——
   *  目录前缀用 startsWith，文件精确匹配，rename 的 from/to 都算。advisory：
   *  只打摘要，不改退出码、不计入 violation 数。 */
  relocations?: Array<{
    oldPath: string
    newPaths: string[]
    since: string
    note: string
  }>
}

interface Rename {
  oldPath: string
  newPath: string
}

interface Changes {
  modified: string[]
  added: string[]
  deleted: string[]
  violations: string[]
}

function git(args: string[]): string {
  const quoted = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
  return execSync(`git ${quoted}`, { cwd: root, encoding: 'utf8' }).trim()
}

function resolveBase(): string {
  const baseIdx = process.argv.indexOf('--base')
  if (baseIdx !== -1) return process.argv[baseIdx + 1]
  // In-progress merge: the base is the being-merged head (MERGE_HEAD), not the old
  // merge-base — otherwise every upstream change in flight shows up as an
  // unregistered modification and the merge commit can never pass pre-commit.
  let mergeHead = ''
  try {
    mergeHead = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  } catch {
    mergeHead = '' // no in-progress merge — rev-parse exits 1
  }
  const base = mergeHead || git(['merge-base', 'HEAD', 'upstream/master'])
  if (!base) {
    console.error('[zones] cannot resolve merge-base with upstream/master')
    process.exit(1)
  }
  return base
}

// Working tree vs base (covers staged + unstaged; untracked handled separately)
function collectChanges(base: string): Changes {
  const changes: Changes = { modified: [], added: [], deleted: [], violations: [] }
  // T32：-M 启用 rename detection，让 collectRenames 能捕到 R 行
  const diff = git(['diff', '--name-status', '-M', base, '--'])
  for (const line of diff ? diff.split('\n') : []) {
    const parts = line.split('\t')
    const status = parts[0]
    if (status === 'M' || status === 'T') changes.modified.push(parts[1])
    else if (status === 'A') changes.added.push(parts[1])
    else if (status === 'D') changes.deleted.push(parts[1])
    else if (status.startsWith('R')) {
      // T32：rename 仍送 D+A 给原规则（checkDeletedRegistered 已能识别 deletedPaths
      //   或 tarball.deletedPaths；checkAdded 已能识别 tarball.paths 或 ownedFile），
      //   同时由 collectRenames 单独捕获供 checkRenames 做交叉一致性判定。
      changes.deleted.push(parts[1])
      changes.added.push(parts[2])
    } else {
      changes.violations.push(`UNEXPECTED git status "${status}" for ${parts.slice(1).join(' → ')}`)
    }
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
  for (const line of untracked ? untracked.split('\n') : []) {
    if (line) changes.added.push(line)
  }
  return changes
}

/**
 * T32：抽取 rename 记录供 checkRenames 做交叉一致性判定。
 *  - 与 collectChanges 共享 `git diff --name-status -M` 输出，重复执行可接受（只读）；
 *  - 返回 [{oldPath, newPath}] 数组。
 */
function collectRenames(base: string): Rename[] {
  const diff = git(['diff', '--name-status', '-M', base, '--'])
  const renames: Rename[] = []
  for (const line of diff ? diff.split('\n') : []) {
    const parts = line.split('\t')
    if (parts[0].startsWith('R')) renames.push({ oldPath: parts[1], newPath: parts[2] })
  }
  return renames
}

/**
 * T32 L1：tarball/tarball 替换式合并的结构化白名单——
 *  凡 added/deleted 命中 upstreamMergeTarball[*].paths/deletedPaths ，
 *  视为已合规登记；同时校验各 tarball 的 base SHA 本地可达。
 */
function checkUpstreamMergeTarball(zones: Zones): string[] {
  const tarballs = zones.upstreamMergeTarball ?? []
  const violations: string[] = []
  for (const t of tarballs) {
    // 校验 base SHA 本地可达
    try {
      git(['rev-parse', '-q', '--verify', t.base])
    } catch {
      violations.push(
        `upstreamMergeTarball base "${t.base}" (task ${t.task}) not reachable locally`
      )
    }
  }
  return violations
}

/**
 * T32 L2：rename 交叉一致性——每对 (oldPath, newPath) 须满足：
 *   - oldPath 命中 zones.deletedPaths（含子目录）或某 tarball.deletedPaths
 *   - newPath 命中 zones.ownedRoots/ownedFiles/stubs 或某 patches.file 或某 tarball.paths
 *   两端都缺则报 RENAME but not registered。
 */
function checkRenames(zones: Zones, renames: Rename[]): string[] {
  if (renames.length === 0) return []
  const tarballs = zones.upstreamMergeTarball ?? []
  const tarballDeleted = new Set(tarballs.flatMap((t) => t.deletedPaths))
  const tarballPaths = new Set(tarballs.flatMap((t) => t.paths))
  const patchedFiles = new Set(
    zones.patches.filter((p) => p.disposition !== 'revoked').map((p) => p.file)
  )
  const owned = new Set([...zones.ownedFiles, ...zones.stubs])
  return renames
    .filter(({ oldPath, newPath }) => {
      const oldOk =
        tarballDeleted.has(oldPath) ||
        zones.deletedPaths.some(
          (d) => oldPath === d || oldPath.startsWith(d.endsWith('/') ? d : `${d}/`)
        )
      const newOk =
        tarballPaths.has(newPath) ||
        owned.has(newPath) ||
        zones.ownedRoots.some((r) => newPath.startsWith(r)) ||
        patchedFiles.has(newPath)
      return !oldOk || !newOk
    })
    .map(
      ({ oldPath, newPath }) =>
        `RENAME but not registered: ${oldPath} → ${newPath} (register old in deletedPaths/tarball.deletedPaths AND new in patches/ownedFiles/tarball.paths)`
    )
}

/**
 * T32 L3：上游已删的 follow 文件本地若仍残留，视为 GHOST——根治 T10 留 vector-edit
 *  死目录这类历史遗留。用 upstream/master..upstreamBase log 列出上游自上次合并以来
 *  所有 deleted 文件，磁盘上仍存在且不属于我们自有的，报警。
 *
 * T64（owner 2026-09-01 拍板）：本规则输入 = 上游活动窗口（外生移动靶——上游任何
 *  删除都会在我们零改动时转红），从 push 门禁降为 drift 雷达，仅 --drift 模式执行
 * （nightly upstream-drift.yml + 失败自动建 issue）；push gate 只留静态 base diff 规则。
 *  T63 实证：上游 be942783 i18n 重构删除两 dialogs 文件即触发本规则转红 run 33460844556。
 */
function checkGhostDeleted(zones: Zones, base: string): string[] {
  // upstreamBase = 我们本地与上游的 merge-base（base 是它或 MERGE_HEAD）
  let upstreamBase = base
  try {
    upstreamBase = git(['merge-base', 'HEAD', 'upstream/master'])
    // oxlint-disable-next-line open-pencil/no-silent-catch
  } catch {
    // 没有 upstream/master 配置（CI 上游 fetch 后必有，本机可能没有）——降级用 base
  }
  // 列出 upstream 自 upstreamBase 以来的所有 deleted 文件（不论我们在不在 base）
  let deletedByUpstream = ''
  try {
    deletedByUpstream = git([
      'log',
      '--diff-filter=D',
      '--name-only',
      '--pretty=format:',
      `${upstreamBase}..upstream/master`
    ])
    // oxlint-disable-next-line open-pencil/no-silent-catch
  } catch {
    // upstream/master 不可达——跳过本次核查
    return []
  }
  // 豁免面与三态登记对齐（04-porting-discipline.md §5）：owned（含过渡态，如
  // AppTextButton.vue 上游删但本地 importer 在用）/ patch（base 改动登记）/
  // tarball.paths（byte 一致白名单）。三者已脱离 follow 区范畴，ghost 不归本检查管。
  const patchedFiles = new Set(
    zones.patches.filter((p) => p.disposition !== 'revoked').map((p) => p.file)
  )
  const owned = new Set([...zones.ownedFiles, ...zones.stubs])
  const tarballPaths = new Set((zones.upstreamMergeTarball ?? []).flatMap((t) => t.paths))
  const candidates = compact(deletedByUpstream ? deletedByUpstream.split('\n') : [])
  return candidates
    .filter((p) => existsSync(resolve(root, p)))
    .filter((p) => !zones.ownedRoots.some((r) => p.startsWith(r)))
    .filter((p) => !patchedFiles.has(p))
    .filter((p) => !owned.has(p))
    .filter((p) => !tarballPaths.has(p))
    .map(
      (p) =>
        `GHOST deleted file from upstream: ${p} still exists locally (remove or move under ownedRoots, or register a patch if importer-dependent)`
    )
}

/**
 * PATCH_TARGET_DELETED_UPSTREAM（2026-09-05 分区优化方案 §5.2，Batch 0）：
 *  对称补盲——checkGhostDeleted 的豁免面把 patch 目标排除在外（patch 文件本地
 *  仍存在，不归 ghost 管），导致 patch 锚定文件被上游删除时零信号（实证：P49
 *  tests/e2e/chat/panel.spec.ts 被上游拆成 7 个 spec、P74 src/app/editor/
 *  clipboard/system.ts 被拆成目录，均已删数日无人知）。
 *  规则：每条 active patch（revoked 除外）的 file 若落在 upstreamBase..
 *  upstream/master 的 D 集（git diff --name-status --diff-filter=D），即报——
 *  锚点已没了，patch 需重锚后继文件或退役。upstream ref/base 推导与
 *  checkGhostDeleted 同口径；与 GHOST 同属上游活动窗口规则，仅 --drift 模式执行。
 */
function checkPatchTargetDeletedUpstream(zones: Zones, base: string): string[] {
  let upstreamBase = base
  try {
    upstreamBase = git(['merge-base', 'HEAD', 'upstream/master'])
    // oxlint-disable-next-line open-pencil/no-silent-catch
  } catch {
    // 没有 upstream/master 配置（CI 上游 fetch 后必有，本机可能没有）——降级用 base
  }
  let deletedByUpstream = ''
  try {
    deletedByUpstream = git([
      'diff',
      '--name-only',
      '--diff-filter=D',
      `${upstreamBase}..upstream/master`
    ])
    // oxlint-disable-next-line open-pencil/no-silent-catch
  } catch {
    // upstream/master 不可达——跳过本次核查
    return []
  }
  const deletedSet = new Set(compact(deletedByUpstream ? deletedByUpstream.split('\n') : []))
  if (deletedSet.size === 0) return []
  return zones.patches
    .filter((p) => p.disposition !== 'revoked')
    .filter((p) => deletedSet.has(p.file))
    .map(
      (p) =>
        `PATCH_TARGET_DELETED_UPSTREAM: ${p.id} ${p.file} deleted upstream since merge-base ${upstreamBase.slice(0, 8)} (patch anchor gone — re-anchor onto the successor file or retire the patch)`
    )
}

/**
 * RELOCATION_WATCH（2026-09-05，方案 §6，owner 拍板建立机制）：
 *  搬移台账 advisory——遍历 zones.relocations[*] 对 upstreamBase..upstream/master
 *  的 name-status diff（-M 启用 rename detection）做命中：
 *  - oldPath 以 / 结尾视为目录前缀——diff 行 path 用 startsWith 匹配；
 *  - oldPath 不以 / 结尾视为文件精确匹配；
 *  - rename 的 from/to 都算命中（status R + parts[1] 与 parts[2] 分别参与判定）。
 *  命中即打印移植评估摘要：
 *  - 默认模式只打一行摘要「[zones][watch] RELOCATION: <oldPath> 上游有改动（N 文件）→
 *    移植评估 → <newPaths 逗号连接 | 已裁撤>：{note}」；
 *  - --drift 模式追加每文件明细（status + path）；
 *  - 永不改退出码、永不计入 violation 数（与 GHOST 同属上游活动窗口规则的轻量侧——
 *    外生移动靶，owner 拍板不进 push 门禁；callers 不消费返回值仅消费 console.log）。
 *  upstream/master 不可达（无 fetch / 无 remote 配置）静默跳过——本规则对环境
 *  零依赖，CI 本地不一致不显红。
 */
function checkRelocationWatch(zones: Zones, base: string): void {
  const relocations = zones.relocations ?? []
  if (relocations.length === 0) return
  let upstreamBase = base
  try {
    upstreamBase = git(['merge-base', 'HEAD', 'upstream/master'])
    // oxlint-disable-next-line open-pencil/no-silent-catch
  } catch {
    // 没有 upstream/master 配置（CI 上游 fetch 后必有，本机可能没有）——降级用 base
  }
  let upstreamDiff = ''
  try {
    upstreamDiff = git(['diff', '--name-status', '-M', `${upstreamBase}..upstream/master`])
    // oxlint-disable-next-line open-pencil/no-silent-catch
  } catch {
    // upstream/master 不可达——advisory 静默跳过，不打印、不报错
    return
  }
  if (!upstreamDiff) return
  const driftMode = process.argv.includes('--drift')
  type Hit = { status: string; path: string }
  for (const r of relocations) {
    const hits: Hit[] = []
    const isDir = r.oldPath.endsWith('/')
    for (const line of upstreamDiff.split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      const status = parts[0]
      // rename 行 parts[1]=from, parts[2]=to；其他行 parts[1]=path
      const candidates = status.startsWith('R') ? [parts[1], parts[2]] : [parts[1]]
      const matched = candidates.some((p) => (isDir ? p.startsWith(r.oldPath) : p === r.oldPath))
      if (!matched) continue
      // rename 一行算两文件（from + to），明细模式各报一条便于搬运审计
      if (status.startsWith('R')) {
        hits.push({ status: `${status} (from)`, path: parts[1] })
        hits.push({ status: `${status} (to)`, path: parts[2] })
      } else {
        hits.push({ status, path: parts[1] })
      }
    }
    if (hits.length === 0) continue
    const dest = r.newPaths.length === 0 ? '已裁撤' : r.newPaths.join(', ')
    console.log(
      `[zones][watch] RELOCATION: ${r.oldPath} 上游有改动（${hits.length} 文件）→ 移植评估 → ${dest}：${r.note}`
    )
    if (driftMode) {
      for (const h of hits) console.log(`  - ${h.status}\t${h.path}`)
    }
  }
}

/**
 * T32 L4：tarball drift——本地文件 byte 与 tarball.paths 收录的版本不一致即违规。
 *  tarball 语义 = 与 base 字节一致（04-porting-discipline.md §5.2），任何本地改动
 *  都破坏该语义：小改应转 patch、大改应转 ownedFile（owner 拍板），改完前判红。
 *  （收口评审 F1：初版为 warn 不阻断——等于把 tarball 文件的未登记修改从 T31 前
 *  的红灯降成警告，门禁被削弱；实测升红时零 drift，无副作用。）
 */
function checkDriftTarball(zones: Zones): string[] {
  const tarballs = zones.upstreamMergeTarball ?? []
  if (tarballs.length === 0) return []
  const violations: string[] = []
  for (const t of tarballs) {
    for (const path of t.paths) {
      try {
        const localSha = git(['hash-object', path])
        const upstreamSha = git(['ls-tree', t.base, path]).split(/\s+/)[2]
        if (localSha && upstreamSha && localSha !== upstreamSha) {
          violations.push(
            `TARBALL_DRIFT: ${path} (task ${t.task}) drifted from base ${t.base.slice(0, 8)} — reclassify to patch or ownedFile`
          )
        }
        // oxlint-disable-next-line open-pencil/no-silent-catch
      } catch {
        // 文件不存在或 base 不可达——跳过
      }
    }
  }
  return violations
}

/**
 * T36 R-exist（owner 拍板④）：非 revoked patch 的 file 必须在磁盘存在。
 *  杀 P8 类——目标文件已删（甚至在 deletedPaths 里）仍挂活 patch 的僵尸登记。
 */
function checkPatchFilesExist(zones: Zones): string[] {
  return zones.patches
    .filter((p) => p.disposition !== 'revoked')
    .filter((p) => !existsSync(resolve(root, p.file)))
    .map(
      (p) =>
        `PATCH file missing on disk: ${p.id} ${p.file} (remove the patch entry or restore the file)`
    )
}

/**
 * T36 R-diff（owner 拍板④）：非 revoked patch 的 file 相对 base 必须有 diff。
 *  杀 P45/P60/P61 类幻影/空挂——与 base 字节一致的 patch 没有登记意义（无本地 hunk）。
 *  豁免：revoked 条目（墓碑无 diff 要求）；tarball.paths 内路径（byte 一致是 tarball
 *  的登记语义，不归 patch 管）。文件不存在时跳过（由 R-exist 单点报告，避免双报）。
 *  基线沿用 resolveBase（含 MERGE_HEAD 合并中情形）。
 *  实现：分批 git diff --name-only（Windows 命令行长度兜底），一次拿有 diff 的文件集。
 */
function checkPatchRealDiff(zones: Zones, base: string): string[] {
  const tarballPaths = new Set((zones.upstreamMergeTarball ?? []).flatMap((t) => t.paths))
  const active = zones.patches.filter((p) => p.disposition !== 'revoked')
  const targets = active
    .map((p) => p.file)
    .filter((f) => !tarballPaths.has(f))
    .filter((f) => existsSync(resolve(root, f)))
  if (targets.length === 0) return []
  const withDiff = new Set<string>()
  for (let i = 0; i < targets.length; i += 40) {
    const out = git(['diff', '--name-only', base, '--', ...targets.slice(i, i + 40)])
    for (const line of out ? out.split('\n') : []) {
      if (line) withDiff.add(line)
    }
  }
  return active
    .filter(
      (p) => !tarballPaths.has(p.file) && existsSync(resolve(root, p.file)) && !withDiff.has(p.file)
    )
    .map(
      (p) =>
        `PATCH has no diff vs base: ${p.id} ${p.file} (byte-identical to base — remove the phantom patch or make the change it claims)`
    )
}

/**
 * RELOCATIONS_VALID（2026-09-05，方案 §6，owner 拍板建立机制）：
 *  搬移台账 zones.json 自身质量硬规则（与 R-exist/R-diff/R-mutex 同口径——审
 *  登记元数据本身，非上游活动窗口）：
 *  - oldPath 非空——空串会让 RELOCATION_WATCH 误命中所有路径（startsWith('') 恒真）；
 *  - oldPath 不重复——同 oldPath 两份登记，第二份永远被第一份的目录前缀/精确匹配
 *    屏蔽，watch 不可观测；触发即登记意图冲突，需人工合并（决定哪份语义为准、
 *    另一份删除或 newPaths 合并）。
 *  不审 newPaths/since/note（note 自由文本、newPaths 可空 = 已裁撤、since 是批次
 *  标签无机器语义）——它们不影响匹配正确性。
 */
function checkRelocationsValid(zones: Zones): string[] {
  const relocations = zones.relocations ?? []
  const seen = new Map<string, number>()
  const violations: string[] = []
  relocations.forEach((r, i) => {
    if (!r.oldPath) {
      violations.push(
        `RELOCATION oldPath empty at index ${i} (register the upstream path being relocated from, or drop the entry)`
      )
    } else if (seen.has(r.oldPath)) {
      violations.push(
        `RELOCATION oldPath duplicated: ${r.oldPath} at index ${i} (already at index ${seen.get(r.oldPath)} — merge the two entries into one)`
      )
    } else {
      seen.set(r.oldPath, i)
    }
  })
  return violations
}

/**
 * T36 R-mutex（owner 拍板④）：非 revoked patch 的 file 不得与 ownedFiles/stubs/
 *  deletedPaths 重叠。杀 P98-P102 类双重记账（fork 新文件同时挂 ownedFile + patch）
 *  与 P8 类「已删仍挂 patch」。patch 语义 = 上游内容的本地 hunk；owned/deleted 语义
 *  与之互斥——同一文件只能居其一。
 */
function checkPatchMutex(zones: Zones): string[] {
  const owned = new Set([...zones.ownedFiles, ...zones.stubs])
  return zones.patches
    .filter((p) => p.disposition !== 'revoked')
    .filter(
      (p) =>
        owned.has(p.file) ||
        zones.deletedPaths.some(
          (d) => p.file === d || p.file.startsWith(d.endsWith('/') ? d : `${d}/`)
        )
    )
    .map(
      (p) =>
        `PATCH overlaps owned/deleted registration: ${p.id} ${p.file} (a file is either a patch on upstream content or owned/deleted — never both)`
    )
}

function checkModified(zones: Zones, modified: string[]): string[] {
  const patchedFiles = new Set(
    zones.patches.filter((p) => p.disposition !== 'revoked').map((p) => p.file)
  )
  const owned = new Set([...zones.ownedFiles, ...zones.stubs])
  // tarball 文件的本地修改由 checkDriftTarball 判红（单一职责，避免双报）
  const tarballPaths = new Set((zones.upstreamMergeTarball ?? []).flatMap((t) => t.paths))
  return modified
    .filter(
      (file) =>
        !patchedFiles.has(file) &&
        !owned.has(file) &&
        !tarballPaths.has(file) &&
        // Merge-base is MERGE_HEAD during any in-progress merge, including merges
        // of our own branches (spike/*, merge/*) — files under ownedRoots are ours
        // (never upstream), so conflict-resolution edits there are not patches.
        !zones.ownedRoots.some((r) => file.startsWith(r))
    )
    .map(
      (file) => `MODIFIED but not registered: ${file} (register a patch in zones.json or revert)`
    )
}

function checkDeletedRegistered(zones: Zones, deleted: string[]): string[] {
  return deleted
    .filter(
      (file) =>
        // ownedRoot 删除豁免（2026-09-05 分区优化方案 §5.3，owner 决策 #7，规则口径
        // 变化）：ownedRoot 下的文件是我们的自有文件（从不来自上游），删除无需登记
        // deletedPaths——口径从「删了必须登记」放宽为「ownedRoot 内删除免登记」。
        // 已登记的条目不受影响（本规则只审未登记方向），前缀口径与 checkModified/
        // checkAdded 的 ownedRoots 判定一致。
        !zones.ownedRoots.some((r) => file.startsWith(r)) &&
        !zones.deletedPaths.some(
          (d) => file === d || file.startsWith(d.endsWith('/') ? d : `${d}/`)
        )
    )
    .map(
      (file) =>
        `DELETED but not registered: ${file} (add the path to deletedPaths in zones.json or restore)`
    )
}

function checkDeletedAbsent(zones: Zones): string[] {
  return zones.deletedPaths
    .filter((p) => existsSync(resolve(root, p)))
    .map((p) => `DELETED path still exists: ${p}`)
}

function checkAdded(zones: Zones, added: string[]): string[] {
  const owned = new Set([...zones.ownedFiles, ...zones.stubs])
  // T32：tarball.paths 是 byte 一致拷贝的结构化登记，命中即视为合规（无需 ownedFile 兜底）
  const tarballPaths = new Set((zones.upstreamMergeTarball ?? []).flatMap((t) => t.paths))
  return added
    .filter(
      (file) =>
        !owned.has(file) &&
        !tarballPaths.has(file) &&
        !zones.ownedRoots.some((r) => file.startsWith(r))
    )
    .map((file) => `ADDED outside ownedRoots: ${file} (add an owned root or move the file)`)
}

/**
 * T28（决策单 #5）：过堂报告——每条补丁相对 base 的当前 diff 行数。
 * 只读：任何 git/文件错误降级为「?」，报告模式恒 exit 0。
 */
function patchesReport(zones: Zones, base: string): void {
  console.log(`[zones] patches report (base ${base.slice(0, 8)})——过堂用，不参与判红：`)
  let totalAdd = 0
  let totalDel = 0
  for (const p of zones.patches) {
    let numstat = ''
    try {
      numstat = git(['diff', '--numstat', base, '--', p.file])
    } catch {
      numstat = ''
    }
    const lines = compact(numstat ? numstat.split('\n') : [])
    let add = 0
    let del = 0
    let binary = false
    for (const line of lines) {
      const [a, d] = line.split('\t')
      if (a === '-' || d === '-') {
        binary = true // 二进制文件 numstat 给 '-'（图片/ico 等）
        continue
      }
      add += Number(a) || 0
      del += Number(d) || 0
    }
    totalAdd += add
    totalDel += del
    const size = binary ? 'binary' : `+${add}/-${del}`
    const revoked = p.disposition === 'revoked' ? ' [revoked]' : ''
    const reviewed = p.lastReviewed ? ` reviewed=${p.lastReviewed}` : ' reviewed=?'
    console.log(`  ${p.id}\t${size}\t${p.file}${revoked}${reviewed}`)
  }
  console.log(
    `[zones] patches total: +${totalAdd}/-${totalDel} across ${zones.patches.length} patch(es)`
  )
}

function main() {
  const zones: Zones = JSON.parse(
    readFileSync(resolve(root, 'tools/zone-registry/zones.json'), 'utf8')
  )
  const base = resolveBase()
  // T28：报告模式先行——只输出过堂摘要即返回，主检查流程不受影响
  if (process.argv.includes('--patches-report')) {
    patchesReport(zones, base)
    process.exit(0)
  }
  const changes = collectChanges(base)
  // T32：rename 交叉一致性 + tarball drift（F1 收口评审：drift 判红，不 warn）
  const renames = collectRenames(base)
  // RELOCATION_WATCH（2026-09-05，方案 §6）：搬移台账 advisory，先于 violations 装配——
  // 自带 console.log、不返回值，永不进 violations；默认模式只打摘要，--drift 追加每文件明细
  checkRelocationWatch(zones, base)
  // 装配顺序——violations 在前、Renames/Ghost/Drift 在中、Tarball 白名单在后兜底 ADDED；
  // T36 登记健康三规则（R-exist/R-diff/R-mutex）殿后——它们审的是 zones.json 自身质量。
  // T64：GHOST 窗口规则仅 --drift 雷达模式执行（owner 2026-09-01 拍板，函数头注在案）
  const violations = [
    ...changes.violations,
    ...checkRenames(zones, renames),
    ...checkModified(zones, changes.modified),
    ...checkDeletedRegistered(zones, changes.deleted),
    ...checkDeletedAbsent(zones),
    ...(process.argv.includes('--drift') ? checkGhostDeleted(zones, base) : []),
    ...(process.argv.includes('--drift') ? checkPatchTargetDeletedUpstream(zones, base) : []),
    ...checkDriftTarball(zones),
    ...checkUpstreamMergeTarball(zones),
    ...checkAdded(zones, changes.added),
    ...checkPatchFilesExist(zones),
    ...checkPatchRealDiff(zones, base),
    ...checkPatchMutex(zones),
    ...checkRelocationsValid(zones)
  ]

  if (violations.length > 0) {
    console.error(`[zones] ${violations.length} violation(s):`)
    for (const v of violations) console.error(`  - ${v}`)
    process.exit(1)
  }
  console.log(
    `[zones] clean: ${changes.modified.length} modified (all registered), ${changes.added.length} added (owned), ${changes.deleted.length} deleted (all registered), ${renames.length} renamed (cross-checked), base ${base.slice(0, 8)}`
  )
}

main()
