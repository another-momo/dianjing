/**
 * Doc binding check (rebuild/v2).
 *
 * Enforces the one-to-one binding between narrative documents and
 * their records/ counterparts. Per 05-process.md §4 and D11:
 *
 *   - Any change to `docs/archive/rebuild-campaign/<file>.md` MUST be
 *     accompanied by a change to the corresponding records/ counterpart
 *     under the same archive tree.
 *   - Spike files: `docs/archive/rebuild-campaign/spikes/<file>.zh.md` ↔
 *     `docs/archive/rebuild-campaign/records/narrative/spikes/<file>.zh.md`
 *   - README.md / tracker.md: same basename in narrative/
 *
 * The narrative tree moved from docs/rebuild/ to
 * docs/archive/rebuild-campaign/ on 2026-09-06 (frozen). Path strings in
 * the matching regex below were updated mechanically to point at the
 * archive root; since the tree is frozen, this check effectively
 * becomes a no-op on fresh commits and stays live only to guard against
 * accidental edits during the freeze window.
 *
 *   Exemptions:
 *   - records/* changes (no required counterpart)
 *   - changes that introduce a new narrative file (the new counterpart
 *     is added in the same commit)
 *
 *   T27 语义修正（注释此前与代码不一致，按 fail-safe 方向对齐为严格语义）：
 *   - commit message 里的 `[no-record]` **不是豁免**——代码从不放行违规，
 *     该标记只改变日志文案（提示性）。绑定违规一律 fail。
 *   - 删除 narrative 文件必须同步删除对应 records 档案（此前被误判为
 *     「新增」而放行，产生孤儿 records——已修正为显式检查删除方向）。
 *
 * Usage: bun tools/zone-registry/src/check/bindings.ts [--base <ref>] (default: HEAD)
 * Exit 0 = clean; exit 1 = violations listed on stderr.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compact } from 'es-toolkit'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')

interface Violation {
  file: string
  rule: string
  message: string
}

const baseArgIdx = process.argv.indexOf('--base')
const base = baseArgIdx !== -1 ? process.argv[baseArgIdx + 1] : 'HEAD'

function git(args: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function getChangedFiles(): { changed: string[]; deleted: Set<string> } {
  // 默认 base=HEAD：
  //   - CI 场景（hook 触发于 commit 之后）：看 HEAD~1..HEAD（即上一次 commit 的所有变更）
  //   - pre-commit hook 场景：用户 git add 后看 staged vs HEAD——已 staged 但未 commit 的改动也会被检出
  //   - 未 add 的 working tree 改动：依赖 oxlint / CI 兜底
  // T27：--name-status 区分删除方向——被删的 narrative 不能再靠
  // existsSync=false 蒙混成「新增豁免」，其 records 档案必须同删（防孤儿）
  const diff = git(`diff --name-status ${base}`)
  const untracked = git('ls-files --others --exclude-standard')
  const changed = new Set<string>()
  const deleted = new Set<string>()
  for (const line of compact(diff.split('\n'))) {
    const [status, ...paths] = line.split('\t')
    const file = paths.at(-1)
    if (!file) continue
    changed.add(file)
    if (status === 'D') deleted.add(file)
  }
  for (const line of compact(untracked.split('\n'))) changed.add(line)
  return { changed: Array.from(changed), deleted }
}

function getCommitMessage(): string {
  return git('log -1 --format=%B')
}

function isNarrative(file: string): { counterpart: string | null; isNew: boolean } {
  // 排除 records/ 自身修改
  if (file.startsWith('docs/archive/rebuild-campaign/records/')) {
    return { counterpart: null, isNew: false }
  }
  // 排除 tasks/ 自身（task 维度独立，不与文件维度绑定）
  if (file.startsWith('docs/archive/rebuild-campaign/tasks/')) {
    return { counterpart: null, isNew: false }
  }
  // D36（2026-08-28 owner 拍板）：高频活文档豁免——tracker.md 不再强制
  // narrative 同 commit 追加；档案 records/narrative/tracker.md 保留停更不删。
  // 规则文见 docs/archive/rebuild-campaign/05-process.md §4.10 豁免条款
  if (file === 'docs/archive/rebuild-campaign/tracker.md') {
    return { counterpart: null, isNew: false }
  }
  // 排除 check-bindings.ts / package.json 等基础设施（check:docs /
  // check:tasks 已退役；原豁免字符串保留供 git 历史可读）
  if (
    file.startsWith('tools/zone-registry/') ||
    file === 'package.json' ||
    file === '.github/workflows/ci.yml'
  ) {
    return { counterpart: null, isNew: false }
  }

  // 匹配 docs/archive/rebuild-campaign/<file>.md 或 spikes/<file>.zh.md
  const narrativeMatch = file.match(/^docs\/archive\/rebuild-campaign\/(.+\.md)$/)
  if (!narrativeMatch) {
    return { counterpart: null, isNew: false }
  }

  const inner = narrativeMatch[1]
  return {
    counterpart: `docs/archive/rebuild-campaign/records/narrative/${inner}`,
    isNew: false
  }
}

function main(): void {
  const commitMsg = getCommitMessage()
  // T27：[no-record] 仅提示性标记，不豁免（见文件头「T27 语义修正」）
  const hasMarker = /\[no-record\]/i.test(commitMsg)

  const { changed, deleted } = getChangedFiles()
  if (changed.length === 0) {
    console.log('check-bindings: 无变更，跳过')
    process.exit(0)
  }

  const violations: Violation[] = []

  for (const file of changed) {
    const { counterpart } = isNarrative(file)
    if (!counterpart) continue

    // 检查 counterpart 是否也在变更列表里（修改或删除都算「同步处置」）
    const counterpartChanged = changed.includes(counterpart)

    // T27：删除方向显式处理——narrative 被删时 records 档案必须同删，
    // 否则留孤儿（此前 existsSync=false 被误判为「新增文件」而整体放行）
    if (deleted.has(file)) {
      if (!counterpartChanged && existsSync(resolve(root, counterpart))) {
        violations.push({
          file,
          rule: 'binding',
          message: `narrative 文件 ${file} 已删除，但对应 records ${counterpart} 仍残留。请同步删除（孤儿档案不留）`
        })
      }
      continue
    }

    // 新增文件：检查文件是否存在于 working tree（被 staged）
    const isNewFile = !existsSync(resolve(root, file))

    if (!counterpartChanged && !isNewFile) {
      // 进一步：counterpart 可能本来就存在但未修改——这就是违规
      const exists = existsSync(resolve(root, counterpart))
      if (exists) {
        violations.push({
          file,
          rule: 'binding',
          message: `narrative 文件 ${file} 已修改，但对应 records ${counterpart} 未修改。请同步更新`
        })
      } else {
        // counterpart 也不存在——可能是新增 narrative 文件但忘记建对应档案
        violations.push({
          file,
          rule: 'binding',
          message: `新增 narrative 文件 ${file}，但缺少对应 records ${counterpart}。请同时创建`
        })
      }
    }
  }

  if (violations.length === 0) {
    if (hasMarker) {
      console.log(
        `check-bindings: ${changed.length} 文件变更（含 [no-record] 提示标记），binding 全绿`
      )
    } else {
      console.log(`check-bindings: ${changed.length} 文件变更，binding 全绿`)
    }
    process.exit(0)
  }

  console.error(`check-bindings: ${violations.length} 处 binding 违规`)
  if (hasMarker) {
    console.error('  注：[no-record] 不是豁免（T27 语义修正）——绑定违规一律拒收')
  }
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}: ${v.message}`)
  }
  process.exit(1)
}

main()
