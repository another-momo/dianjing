/**
 * 2026-09-19 broker P0-1 判定面收编（仓外
 * docs/202609181745-agent-permission-broker-design.md §4.3）：load_image
 * 原位三态裁决（原 decideWorkspacePath）收编为 facet 两态判定服务
 * decidePath——本批无行为变化（读/写 facet 语义暂相同），facet 先入签名
 * 供后续分叉（读界外翻 allow 等拍板项落地时在读 facet 分叉）。
 *
 * 判定顺序（现行语义原位搬迁）：protectedWriteRoots（key-guard 写侧三根）
 * 命中 deny → workspace 子树 allow → 其余（出界）deny。归一化走
 * ./path-normalize.ts 单一真源（normalizePathDual），本档不重述算法。
 *
 * deny 侧带 absolutePath 与 denyCause（protected / outside）——P0-2 shadow
 * 观测（./path-observe.ts）消费：日志行需绝对路径与「出界 vs 名单命中」
 * 判别，判定单源在本档、观测层不复制判定。对工具层（load_image /
 * export_image_to_file 只读 ok/error/reason）是纯增量字段，行为零变化。
 */

import { homedir } from 'node:os'

import { protectedWriteRoots } from './key-guard'
import { normalizePathDual } from './path-normalize'
import { resolveWorkspaceDir } from './paths'

/** 读/写 facet——现行两态语义相同，入签名供后续分叉（读界外 allow 等） */
export type PathFacet = 'read' | 'write'

export interface PathDecisionOptions {
  facet: PathFacet
  rootDir: string
  /** 相对路径解析基点（缺省 = workspace 目录，与 session cwd 同点） */
  cwd?: string
  homeDir?: string
}

export type PathDecision =
  | { ok: true; /** 绝对路径（大小写保留，供真实 IO） */ absolutePath: string }
  | {
      ok: false
      error: string
      reason: 'denied'
      /** 绝对路径（大小写保留）——deny 侧同样带出，供观测/日志层消费 */
      absolutePath: string
      /** deny 来源：protected = 写侧三根命中；outside = 出 workspace 界 */
      denyCause: 'protected' | 'outside'
    }

/** key-guard isWriteHit 同算法：normalized 本身是受保护目录或其后代 */
function hitsProtectedRoot(compare: string, protectedCompare: ReadonlySet<string>): boolean {
  for (const target of protectedCompare) {
    if (compare === target) return true
    if (compare.startsWith(target + '/')) return true
  }
  return false
}

/**
 * facet 两态判定（broker 落地前：无 ask，出界即 deny；本批 read/write 同语义）：
 *   allow = workspace 子树；deny = protectedWriteRoots 命中（facet 防自植）；
 *   其余一律 deny（出界）。
 */
export function decidePath(input: string, opts: PathDecisionOptions): PathDecision {
  const cwd = opts.cwd ?? resolveWorkspaceDir(opts.rootDir)
  const homeDir = opts.homeDir ?? homedir()
  const { compare, absolute } = normalizePathDual(input, cwd, homeDir)
  const protectedCompare = new Set(
    protectedWriteRoots(opts.rootDir).map((p) => normalizePathDual(p, cwd, homeDir).compare)
  )
  if (hitsProtectedRoot(compare, protectedCompare)) {
    return {
      ok: false,
      reason: 'denied',
      absolutePath: absolute,
      denyCause: 'protected',
      error:
        'Access denied: this path is in the protected agent configuration area and is not accessible to agent tools.'
    }
  }
  const workspaceCompare = normalizePathDual(
    resolveWorkspaceDir(opts.rootDir),
    cwd,
    homeDir
  ).compare
  if (compare === workspaceCompare || compare.startsWith(workspaceCompare + '/')) {
    return { ok: true, absolutePath: absolute }
  }
  return {
    ok: false,
    reason: 'denied',
    absolutePath: absolute,
    denyCause: 'outside',
    error: `Path outside workspace: ${absolute}. Move the file into the workspace directory and retry.`
  }
}
