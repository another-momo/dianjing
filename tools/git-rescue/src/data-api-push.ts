/**
 * git push 传输全挂时的 Data API 兜底（v2 多文件通用版，2026-09-15 自 _ops 入库）。
 *
 * 适用场景：github.com:443 反复超时（git 传输层挂）但 api.github.com 通——
 * 用 Data API 把本地 HEAD 提交逐对象重建到远端并 FF 更新集成分支：
 * 逐文件 blob → 整 tree（base_tree + 全路径条目，GitHub 自动构中间树）→
 * commit（作者/提交者/时间戳逐字节复刻，sha 才一致）→ PATCH ref force=false。
 * 每步 sha 与本地对象比对，任何一步不符即抛错中止。
 *
 * 前置条件：HEAD = 要推的提交；其父提交已在远端；与远端是 FF 关系。
 * 用法：bun tools/git-rescue/src/data-api-push.ts（仓内任意 cwd 可跑）。
 * 实证：2026-09-09 .git 灭失重建；2026-09-15 两度 github.com:443 四连败兜底成功；
 * 同日三连败首用本仓版连撞三盲区（删除/重命名、脏树、detached HEAD 复用脚本
 * 须 commit 化），皆已修。
 */
import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'another-momo/dianjing'
const BRANCH = 'rebuild/mode-arch'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = execSync('git rev-parse --show-toplevel', { cwd: SCRIPT_DIR }).toString().trim()
const PAYLOAD = join(tmpdir(), `data-api-push-payload-${process.pid}.json`)

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: REPO_ROOT }).toString()
}
function gitBytes(args: string): Buffer {
  return execSync(`git ${args}`, { cwd: REPO_ROOT })
}
interface GhShaResponse {
  sha: string
}
interface GhRefResponse {
  object: { sha: string }
}
function ghAPI(method: string, endpoint: string, payload: unknown): unknown {
  writeFileSync(PAYLOAD, JSON.stringify(payload), 'utf8')
  const out = execSync(`gh api -X ${method} ${endpoint} --input "${PAYLOAD}"`).toString()
  const parsed: unknown = JSON.parse(out)
  return parsed
}
function isoFrom(epochSec: string, tz: string): string {
  const ms = Number(epochSec) * 1000 + (Number(tz.slice(0, 3)) * 60 + Number(tz.slice(3))) * 60000
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${tz.slice(0, 3)}:${tz.slice(3)}`
  )
}

const localTree = git('rev-parse "HEAD^{tree}"').trim()
const localCommit = git('rev-parse HEAD').trim()
const parent = git('rev-parse "HEAD^"').trim()
const parentTree = git(`rev-parse "${parent}^{tree}"`).trim()
const files = git('diff-tree --no-commit-id --no-renames --name-status -r HEAD')
  .trim()
  .split('\n')
  .filter(Boolean)
console.log(
  `本地对象：commit=${localCommit.slice(0, 9)} tree=${localTree.slice(0, 9)} parent=${parent.slice(0, 9)} 文件 ${files.length} 件`
)

// 1) 逐文件 blob——A/M 按 sha 取对象库内容（工作树脏时盘读与 HEAD 分叉、
//    blob sha 校验必炸），D 以 sha:null 条目从树中删除；
//    --no-renames 使 R 自然拆 D+A 无需专判
const entries: Array<{ path: string; mode: string; type: string; sha: string | null }> = []
for (const line of files) {
  const [status, path] = line.split('\t')
  if (status === 'D') {
    entries.push({ path, mode: '100644', type: 'blob', sha: null })
    console.log('delete ✅', path)
    continue
  }
  const localBlob = git(`rev-parse "HEAD:${path}"`).trim()
  const content = gitBytes(`cat-file blob ${localBlob}`).toString('base64')
  const blob = ghAPI('POST', `repos/${REPO}/git/blobs`, {
    content,
    encoding: 'base64'
  }) as GhShaResponse
  if (blob.sha !== localBlob) {
    throw new Error(`blob sha 不符 ${path}：远端 ${blob.sha} != 本地 ${localBlob}`)
  }
  entries.push({ path, mode: '100644', type: 'blob', sha: localBlob })
  console.log('blob ✅', path)
}

// 2) tree——以 parent tree 为基座，全路径条目（GitHub 自动构中间树）
const tree = ghAPI('POST', `repos/${REPO}/git/trees`, {
  base_tree: parentTree,
  tree: entries
}) as GhShaResponse
if (tree.sha !== localTree) throw new Error(`tree sha 不符：远端 ${tree.sha} != 本地 ${localTree}`)
console.log('tree ✅', localTree.slice(0, 9))

// 3) commit——作者/提交者/时间戳逐字节复刻，sha 才会一致
const raw = git('cat-file commit HEAD')
const author = /^author (.*) <(.*)> (\d+) ([+-]\d{4})$/m.exec(raw)
const committer = /^committer (.*) <(.*)> (\d+) ([+-]\d{4})$/m.exec(raw)
if (!author || !committer) throw new Error('cat-file 输出未匹配 author/committer 行')
const message = raw.slice(raw.indexOf('\n\n') + 2)
const commit = ghAPI('POST', `repos/${REPO}/git/commits`, {
  message,
  tree: localTree,
  parents: [parent],
  author: { name: author[1], email: author[2], date: isoFrom(author[3], author[4]) },
  committer: {
    name: committer[1],
    email: committer[2],
    date: isoFrom(committer[3], committer[4])
  }
}) as GhShaResponse
if (commit.sha !== localCommit) {
  throw new Error(`commit sha 不符：远端 ${commit.sha} != 本地 ${localCommit}`)
}
console.log('commit ✅', localCommit.slice(0, 9))

// 4) FF 更新分支引用（force=false 非 FF 即拒）
const ref = ghAPI('PATCH', `repos/${REPO}/git/refs/heads/${BRANCH}`, {
  sha: localCommit,
  force: false
}) as GhRefResponse
if (ref.object.sha !== localCommit) throw new Error(`ref 更新后指向 ${ref.object.sha}，非预期`)
console.log(`ref ✅ ${BRANCH} -> ${localCommit.slice(0, 9)}（push 事件等效，CI 应已触发）`)

unlinkSync(PAYLOAD)
