/**
 * 2026-09-19 broker P0-1 判定面收编 + A线尾单件1（仓外
 * docs/202609181745-agent-permission-broker-design.md §4.1/§4.3，拍板 1）：
 * facet 两态判定服务 decidePath——
 *  - read facet（本批翻正）：敏感名单命中 → deny；名单外全 allow（含
 *    workspace 界外——读族界外静默 allow，内置资产读白名单判定态消亡）。
 *    敏感名单 = 凭据四件 + ~/.ssh/** + ~/.aws/** + 任意路径 basename 恰
 *    .env 或以 .env. 开头 + *.pem 扩展名（fail-safe 过挡，workspace 内
 *    同名文件亦拒——过挡现状保留）。
 *  - write facet（不动）：protectedWriteRoots（写侧三根）命中 deny →
 *    workspace 子树 allow → 界外 deny。
 *
 * 名单与判定单源在本档（A线尾单自 key-guard.ts 收编：protectedCredentialFiles /
 * protectedWriteRoots / sensitiveReadDirPaths / hitsSensitiveDirCompare /
 * isSensitiveNameCompare / CREDENTIAL_READ_DENY_REASON /
 * SENSITIVE_READ_DENY_REASON）——key-guard 读侧 import 本档共享判定，
 * 禁两处维护。归一化走 ./path-normalize.ts 单一真源（normalizePathDual），
 * 本档不重述算法。
 *
 * PathDecision shape（A线尾单扩）：ok 侧新增 outside 分类标记（read facet
 * 界外 allow 流量的观测信号——path-observe 消费；write facet 恒 false，
 * 界外写本就 deny）；deny 侧 denyCause 三值 = 'protected'（写侧三根 /
 * 读侧凭据四件）/ 'sensitive'（读侧敏感名单）/ 'outside'（界外写）。
 * deny 侧带 absolutePath——P0-2 shadow 观测（./path-observe.ts）消费：
 * 判定单源在本档、观测层不复制判定。对工具层（load_image /
 * export_image_to_file 只读 ok/error/reason/absolutePath）是纯增量字段。
 */

import { homedir } from 'node:os'
import { sep } from 'node:path'

import { normalizePathDual } from './path-normalize'
import {
  resolveAgentDir,
  resolveKeyEnvPath,
  resolvePiBackendTokenPath,
  resolveWorkspaceDir
} from './paths'

/** 读/写 facet */
export type PathFacet = 'read' | 'write'

export interface PathDecisionOptions {
  facet: PathFacet
  rootDir: string
  /** 相对路径解析基点（缺省 = workspace 目录，与 session cwd 同点） */
  cwd?: string
  homeDir?: string
}

export type PathDecision =
  | {
      ok: true
      /** 绝对路径（大小写保留，供真实 IO） */
      absolutePath: string
      /**
       * 界外分类标记（2026-09-19 A线尾单新增）：路径不在 workspace 子树。
       * read facet 界外静默 allow 后本字段是观测层区分界外读流量的唯一
       * 信号；write facet 恒 false（界外写 deny，走不到 ok）。
       */
      outside: boolean
    }
  | {
      ok: false
      error: string
      reason: 'denied'
      /** 绝对路径（大小写保留）——deny 侧同样带出，供观测/日志层消费 */
      absolutePath: string
      /**
       * deny 来源：protected = 写侧三根（write facet）/ 凭据四件（read
       * facet）；sensitive = 读侧敏感名单（~/.ssh、~/.aws、.env、.pem）；
       * outside = 界外写（write facet 专属——read facet 界外已 allow）
       */
      denyCause: 'protected' | 'sensitive' | 'outside'
    }

// ── 名单单源（2026-09-19 A线尾单自 key-guard.ts 收编）──

/** image-gen 凭据文件名（image-gen/credentials.ts:63 `join(agentDir, 'image-gen.json')`） */
const IMAGE_GEN_CREDENTIAL_FILENAME = 'image-gen.json'

/** mcp 接入阶段 1 凭据文件名（mcp-connections/store.ts `join(agentDir, 'mcp-connections.json')`） */
const MCP_CONNECTIONS_FILENAME = 'mcp-connections.json'

/** `<base>${sep}<name>` —— 名单路径拼接（rootDir 与 filenames 单源全在 paths.ts） */
function joinWithSep(base: string, name: string): string {
  return `${base}${sep}${name}`
}

/**
 * 凭据五件绝对路径（rootDir 下）：
 *  - pi-agent/auth.json（provider key 明文）
 *  - pi-agent/image-gen.json（image-gen apiKey 明文，image-gen/credentials.ts:63）
 *  - pi-agent/mcp-connections.json（MCP 接入凭据：headers/env 值含第三方 key，
 *    凭据防线收编；mcp-connections/store.ts）
 *  - key-env（自助注入文件）
 *  - pi-backend-token（standalone 模式鉴权 token）
 */
export function protectedCredentialFiles(rootDir: string): string[] {
  const agentDir = resolveAgentDir(rootDir)
  return [
    resolveKeyEnvPath(rootDir),
    resolvePiBackendTokenPath(rootDir),
    joinWithSep(agentDir, 'auth.json'),
    joinWithSep(agentDir, IMAGE_GEN_CREDENTIAL_FILENAME),
    joinWithSep(agentDir, MCP_CONNECTIONS_FILENAME)
  ]
}

/**
 * 写侧 deny 面（绝对路径）——pi-agent/** 与 workspace/.pi/** 与
 * workspace/.agents/** 三个目录的后代均不可由 agent 写（双注关 trust 后
 * 已惰性，纵深防御；.agents = 2026-09-18 重排后的用户扩展层，自植面）。
 * 读侧不经本面（读侧名单 = 凭据四件 + 敏感名单，见 decidePath read facet）。
 */
export function protectedWriteRoots(rootDir: string): string[] {
  const workspaceDir = resolveWorkspaceDir(rootDir)
  return [
    resolveAgentDir(rootDir),
    joinWithSep(workspaceDir, '.pi'),
    joinWithSep(workspaceDir, '.agents')
  ]
}

/** 读侧敏感目录（homeDir 下 .ssh / .aws）——目录本体及后代均 deny */
export function sensitiveReadDirPaths(homeDir: string): string[] {
  return [joinWithSep(homeDir, '.ssh'), joinWithSep(homeDir, '.aws')]
}

/**
 * 凭据四件读侧 deny 文案（自 key-guard 收编）——凭据归产品 Settings 面板管。
 */
export const CREDENTIAL_READ_DENY_REASON =
  'Access denied: this path stores API credentials/tokens and is protected from agent access. ' +
  'Do not read, search, or infer credential files — if credentials need inspection or changes, direct the user to the Settings panel.'

/**
 * 读侧敏感名单 deny 文案（自 key-guard 收编）——与凭据四件区分：名单面 =
 * 系统/凭据类敏感文件（~/.ssh、~/.aws、.env、.pem），不归产品 Settings
 * 面板管，引导用户自行处理。
 */
export const SENSITIVE_READ_DENY_REASON =
  'Access denied: this path is a sensitive system or credential file (SSH/AWS config, .env, PEM key material) and is protected from agent reads and searches. ' +
  'Do not read, search, or infer its contents — if the file needs inspection or changes, ask the user to handle it directly.'

/** 集合命中判定：compare 本身是集合成员或其后代 */
function hitsProtectedRoot(compare: string, protectedCompare: ReadonlySet<string>): boolean {
  for (const target of protectedCompare) {
    if (compare === target) return true
    if (compare.startsWith(target + '/')) return true
  }
  return false
}

/**
 * 读侧敏感目录命中（自 key-guard 收编）：compare 是敏感目录本体/后代；
 * includeAncestors（grep 搜根语义）追加反向——敏感目录是 compare 后代时
 * 搜索会捞出敏感内容（祖先向判定）。
 */
export function hitsSensitiveDirCompare(
  compare: string,
  sensitiveDirCompare: ReadonlySet<string>,
  includeAncestors: boolean
): boolean {
  for (const dir of sensitiveDirCompare) {
    if (compare === dir || compare.startsWith(dir + '/')) return true
    if (includeAncestors && dir.startsWith(compare + '/')) return true
  }
  return false
}

/**
 * 读侧敏感文件名（自 key-guard 收编）：basename 恰为 .env 或以 .env. 开头、
 * 或 .pem 扩展名——任意路径（fail-safe 过挡，workspace 内同名文件亦拒）。
 * 入参 = normalizePathDual compare 串（全小写/正斜杠形态）。
 */
export function isSensitiveNameCompare(compare: string): boolean {
  const base = compare.slice(compare.lastIndexOf('/') + 1)
  return base === '.env' || base.startsWith('.env.') || compare.endsWith('.pem')
}

/**
 * facet 两态判定（broker 拍板 1 落地形态）：
 *  - read：凭据四件 deny（protected）→ 敏感名单 deny（sensitive）→
 *    其余全 allow（含界外，ok 侧 outside 标记供观测）。
 *  - write：写侧三根 deny（protected）→ workspace 子树 allow → 界外
 *    deny（outside）。
 * 读 facet 不做祖先向判定（文件读语义；grep 搜根祖先向在 key-guard 经
 * hitsSensitiveDirCompare includeAncestors 覆盖）。
 */
export function decidePath(input: string, opts: PathDecisionOptions): PathDecision {
  const cwd = opts.cwd ?? resolveWorkspaceDir(opts.rootDir)
  const homeDir = opts.homeDir ?? homedir()
  const { compare, absolute } = normalizePathDual(input, cwd, homeDir)
  const workspaceCompare = normalizePathDual(
    resolveWorkspaceDir(opts.rootDir),
    cwd,
    homeDir
  ).compare
  const insideWorkspace = compare === workspaceCompare || compare.startsWith(workspaceCompare + '/')

  if (opts.facet === 'read') {
    // 凭据四件（文件级精确命中——后代形态不存在，hitsProtectedRoot 同算法复用）
    const credentialCompare = new Set(
      protectedCredentialFiles(opts.rootDir).map((p) => normalizePathDual(p, cwd, homeDir).compare)
    )
    if (hitsProtectedRoot(compare, credentialCompare)) {
      return {
        ok: false,
        reason: 'denied',
        absolutePath: absolute,
        denyCause: 'protected',
        error: CREDENTIAL_READ_DENY_REASON
      }
    }
    // 敏感名单（~/.ssh/**、~/.aws/**、.env/.env.*、*.pem——任意路径过挡）
    const sensitiveDirCompare = new Set(
      sensitiveReadDirPaths(homeDir).map((p) => normalizePathDual(p, cwd, homeDir).compare)
    )
    if (
      hitsSensitiveDirCompare(compare, sensitiveDirCompare, false) ||
      isSensitiveNameCompare(compare)
    ) {
      return {
        ok: false,
        reason: 'denied',
        absolutePath: absolute,
        denyCause: 'sensitive',
        error: SENSITIVE_READ_DENY_REASON
      }
    }
    // 名单外全 allow（含界外）——outside 标记供 path-observe 区分界外读流量
    return { ok: true, absolutePath: absolute, outside: !insideWorkspace }
  }

  // write facet——现行语义不动
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
  if (insideWorkspace) {
    return { ok: true, absolutePath: absolute, outside: false }
  }
  return {
    ok: false,
    reason: 'denied',
    absolutePath: absolute,
    denyCause: 'outside',
    error: `Path outside workspace: ${absolute}. Move the file into the workspace directory and retry.`
  }
}
