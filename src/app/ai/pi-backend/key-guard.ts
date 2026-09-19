/**
 * 2026-09-16 凭据守卫 A 案 + 2026-09-16 pi agent 行为控管层 1 写侧纵深件——
 * tool_call 拦内建文件工具对凭据四件的读/写/搜，阻断 key 明文进模型上下文；
 * 写侧扩 deny `pi-agent/**` 全局面（settings.json / SYSTEM.md / APPEND_SYSTEM.md /
 * extensions / skills / prompts / themes）与 `workspace/.pi/**`（纵深件——trust
 * 关闭后已惰性，防上游语义漂移）。2026-09-18 userdata 重排再扩
 * `workspace/.agents/**`（用户扩展层移入 workspace 后的新增自植面，与目录
 * 启用同批落地，无空窗）。预研与拍板 = 仓外
 * docs/202609151649-pi-agent-key-file-guard-research.md。
 *
 * 装配位 = service.ts 的 extensionFactories（InlineExtension 数组）——
 * 沿用 createAskPendingGuardHandler / createAskPendingGuardExtension 同构：
 * handler 与 extension 分离导出，测试直钉 handler（免 ExtensionAPI 桩件）。
 *
 * 不防面（明示口径，决策依据见研究稿）：
 *  - bash 命令文本（D 案挂起——bash 执行体文本不在 tool_call 路径上，拦截将
 *    误杀合法 shell 交互如 `cat` 已拒文件清单，模型侧命令生成亦需绕阻——挂起
 *    不在本案；如未来需要应走 bash 专属 guard 二审）
 *  - symlink / 8.3 短名（桌面单用户拓扑威胁模型 = 注入诱导顺手读，非对抗
 *    性逃逸——归一化层级不跟 symlink / 短名解析，按字面路径比）
 *  - find / ls（输出仅文件名，存在性非机密——凭据文件存在与否本来就
 *    是 manifest 数据面，无新增泄露维度）
 *  - SDK 内部写（auth 存储 / 会话持久化 / 凭据路由）不经 agent 工具——
 *    sessions 落点 rootDir/pi-sessions（paths.ts PI_SESSIONS_SUBDIR），
 *    不与本案的 pi-agent/** / workspace/.pi/** 写侧 deny 面重合（写侧
 *    仅拦 agent tool_call 路径，SDK 自身 IO 不受影响）。
 *
 * 凭据四件（在 rootDir 下）：
 *  - pi-agent/auth.json（provider key 明文）
 *  - pi-agent/image-gen.json（image-gen apiKey 明文，image-gen/credentials.ts:63）
 *  - key-env（自助注入文件）
 *  - pi-backend-token（standalone 模式鉴权 token）
 *
 * 写侧 deny 面（在 rootDir 下）：
 *  - pi-agent/**（settings.json / SYSTEM.md / APPEND_SYSTEM.md / extensions /
 *    skills / prompts / themes）——这些是 SDK project 信任面层 1 关掉前
 *    agent 可写的自植面（full 档产品化即激活 RCE / 窃 key / 持久注入）。
 *    service.ts 自构 SettingsManager projectTrusted:false 双注后该面
 *    已惰性，本 guard 写侧纵深件防上游语义漂移。
 *  - workspace/.pi/**（纵深件）——服务 cwd 下沉 rootDir/workspace 后的
 *    .pi 子树（paths.ts PI_WORKSPACE_SUBDIR）；同语义冗余防御。
 *  - workspace/.agents/**（2026-09-18 userdata 重排新增）——用户扩展层
 *    移入 workspace 后是**新增暴露面**：agent 文件工具本可达，自写
 *    skills/base.md/workflows = 持久注入面，必须与目录启用同批 deny
 *    （无空窗）。读侧不动（.agents 内无凭据，凭据四件留在 rootDir 一级）。
 *  - workspace/image-gen-output/** 不 deny（用户数据面，agent 可读写无注入风险）。
 *
 * 读侧敏感名单扩面（2026-09-19 broker P0-3，设计稿
 * docs/202609181745-agent-permission-broker-design.md §4.1/§10-P0-3——读族
 * 界外静默 allow 的安全配套）：凭据四件之外，read/grep 路径再 deny
 * ①homeDir 下 .ssh/** 与 .aws/**（目录本体及后代；grep 搜根含祖先方向——
 * 搜索会捞出敏感内容，同 isHit 祖先口径）；②basename 恰为 .env 或以
 * .env. 开头的任意路径（fail-safe 过挡，workspace 内同名文件亦拒）；
 * ③.pem 扩展名的任意路径。判定在 normalizePathDual compare 串上做
 * （全小写/正斜杠形态）。写侧面不动（edit/write 不经本名单——界外写
 * deny 属 broker 判定面，非本 guard 口径）。reason 与凭据四件区分
 * （SENSITIVE_READ_DENY_REASON：名单文件不归产品管，引导用户自行处理）。
 */

import { homedir } from 'node:os'
import { sep } from 'node:path'

import type { InlineExtension } from '@earendil-works/pi-coding-agent'

import { normalizePathDual } from './path-normalize'
import {
  resolveAgentDir,
  resolveKeyEnvPath,
  resolvePiBackendTokenPath,
  resolveWorkspaceDir
} from './paths'

/** image-gen 凭据文件名（image-gen/credentials.ts:63 `join(agentDir, 'image-gen.json')`） */
const IMAGE_GEN_CREDENTIAL_FILENAME = 'image-gen.json'

/**
 * 凭据四件绝对路径（join 拼，rootDir 与 filenames 单源全在 paths.ts）。
 * 供 handler 内部归一化集合使用——rootDir 闭包稳定，handler 一次性预归一化。
 */
export function protectedCredentialFiles(rootDir: string): string[] {
  const agentDir = resolveAgentDir(rootDir)
  return [
    resolveKeyEnvPath(rootDir),
    resolvePiBackendTokenPath(rootDir),
    joinInAgent(agentDir, 'auth.json'),
    joinInAgent(agentDir, IMAGE_GEN_CREDENTIAL_FILENAME)
  ]
}

/** `agentDir/<file>` —— 本文件辅助 helper（避本文件顶部再开一组 path.join import） */
function joinInAgent(agentDir: string, filename: string): string {
  return `${agentDir}${sep}${filename}`
}

/**
 * 写侧 deny 面（绝对路径）——pi-agent/** 与 workspace/.pi/** 与
 * workspace/.agents/** 三个目录的后代均不可由 agent 写（双注关 trust 后
 * 已惰性，纵深防御；.agents = 2026-09-18 重排后的用户扩展层，自植面）。
 *
 * 路径形态与 protectedCredentialFiles 同构：join 拼，rootDir 单源全在 paths.ts。
 * handler 内部归一化后比对——prefix 命中即拒。
 */
export function protectedWriteRoots(rootDir: string): string[] {
  const workspaceDir = resolveWorkspaceDir(rootDir)
  return [
    resolveAgentDir(rootDir),
    joinPath(workspaceDir, '.pi'),
    joinPath(workspaceDir, '.agents')
  ]
}

/** `<base>/<file>` —— 仿 joinInAgent 形态（给 protectedWriteRoots 用，避免再开 import） */
function joinPath(base: string, filename: string): string {
  return `${base}${sep}${filename}`
}

/**
 * guard 比对形态：共享算法（./path-normalize.ts，算法步骤与跨平台判定
 * 口径文档在该模块头注）的 compare 薄壳——全小写供名单比对。
 *
 * 安全语境保留原地：先统一分隔符再做绝对判定 = Win 形态（反斜杠/盘符）
 * 在 POSIX 上也按同一形态归一，对不会在宿主机解析成功的拼法过挡属
 * fail-safe；全小写 = 目标平台 Win/mac 文件系统均大小写不敏感，对大小写
 * 敏感 FS 是 fail-safe 过挡（凭据邻名宁可错挡）。
 */
function normalizePath(input: string, cwd: string, homeDir: string): string {
  return normalizePathDual(input, cwd, homeDir).compare
}

/**
 * 命中判定：effRoot（grep 搜索根）是否指向受保护文件/目录本身、或受保护
 * 面是其后代——后代情况下 grep 搜根会捞出受保护内容，必须阻断。
 */
function isHit(effRoot: string, protectedNormalized: ReadonlySet<string>): boolean {
  for (const target of protectedNormalized) {
    if (effRoot === target) return true
    if (target.startsWith(effRoot + '/')) return true
  }
  return false
}

/**
 * 写侧命中判定：normalized 路径本身是受保护目录（pi-agent/ 或 workspace/.pi/）
 * 或其后代。
 */
function isWriteHit(normalized: string, writeProtectedNormalized: ReadonlySet<string>): boolean {
  for (const target of writeProtectedNormalized) {
    if (normalized === target) return true
    if (normalized.startsWith(target + '/')) return true
  }
  return false
}

/**
 * 读侧敏感目录命中（2026-09-19 P0-3）：compare 是 homeDir/.ssh 或 homeDir/.aws
 * 本体/后代；includeAncestors（grep 搜根语义）追加反向——敏感目录是 compare
 * 后代时搜索会捞出敏感内容（同 isHit 祖先口径）。
 */
function hitsSensitiveDir(
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
 * 读侧敏感文件名（2026-09-19 P0-3）：basename 恰为 .env 或以 .env. 开头、
 * 或 .pem 扩展名——任意路径（fail-safe 过挡，workspace 内同名文件亦拒）。
 */
function hitsSensitiveName(compare: string): boolean {
  const base = compare.slice(compare.lastIndexOf('/') + 1)
  return base === '.env' || base.startsWith('.env.') || compare.endsWith('.pem')
}

const READ_DENY_REASON =
  'Access denied: this path stores API credentials/tokens and is protected from agent access. ' +
  'Do not read, search, or infer credential files — if credentials need inspection or changes, direct the user to the Settings panel.'

const WRITE_DENY_REASON =
  'Access denied: this path stores API credentials/tokens and is protected from agent writes. ' +
  'Credential updates go through the Settings panel (credential routes) only.'

/** 写侧 deny pi-agent/** / workspace/.pi/** 的原因——SDK project 信任面防自植 */
const WRITE_PROTECTED_FACET_REASON =
  'Access denied: this path is in the protected pi agent configuration facet and cannot be modified by the agent. ' +
  'The project trust surface is closed; configuration updates go through the Settings panel or developer tooling.'

/**
 * 读侧敏感名单 deny 文案（2026-09-19 P0-3）——与凭据四件 READ_DENY_REASON
 * 区分：名单面 = 系统/凭据类敏感文件（~/.ssh、~/.aws、.env、.pem），不归
 * 产品 Settings 面板管，引导用户自行处理。
 */
const SENSITIVE_READ_DENY_REASON =
  'Access denied: this path is a sensitive system or credential file (SSH/AWS config, .env, PEM key material) and is protected from agent reads and searches. ' +
  'Do not read, search, or infer its contents — if the file needs inspection or changes, ask the user to handle it directly.'

/**
 * 凭据守卫 handler——闭包内一次性算归一化集合（rootDir 不变，无重算必要）。
 * 暴露单独函数便于测试直钉（与 createAskPendingGuardHandler 同构）。
 */
export function createKeyGuardHandler(opts: {
  rootDir: string
  cwd: string
  homeDir?: string
}): (event: {
  toolName: string
  input: Record<string, unknown>
}) => { block: true; reason: string } | undefined {
  const homeDir = opts.homeDir ?? homedir()
  const protectedNormalized = new Set(
    protectedCredentialFiles(opts.rootDir).map((p) => normalizePath(p, opts.cwd, homeDir))
  )
  const writeProtectedNormalized = new Set(
    protectedWriteRoots(opts.rootDir).map((p) => normalizePath(p, opts.cwd, homeDir))
  )
  // 2026-09-19 P0-3 读侧敏感目录（homeDir 下 .ssh / .aws）——预归一化一次
  const sensitiveDirCompare = new Set(
    [joinPath(homeDir, '.ssh'), joinPath(homeDir, '.aws')].map((p) =>
      normalizePath(p, opts.cwd, homeDir)
    )
  )

  return (event) => {
    const { toolName, input } = event
    if (toolName === 'read' || toolName === 'edit' || toolName === 'write') {
      // input.path 必填（schema 实证，read.d.ts:5 typebox path: string），但
      // 双断言 lint + Record 索引访问 no-unnecessary-condition 都不友好；非 string
      // 直接放行（SDK schema 自会拒）
      const path = input['path']
      if (typeof path !== 'string') return undefined
      const normalized = normalizePath(path, opts.cwd, homeDir)
      // 写侧：先看 pi-agent/** / workspace/.pi/** deny 面（理由 = facet 防自植，
      // 区别于凭据四件——凭据四件在 pi-agent/ 下但路径更具体、reason 文案不同）；
      // 该面命中即拒，与凭据四件是否命中无关（凭据四件本身也在 pi-agent/ 下，
      // 先拒 facet 面更快、reason 更准）
      if (toolName !== 'read' && isWriteHit(normalized, writeProtectedNormalized)) {
        return { block: true, reason: WRITE_PROTECTED_FACET_REASON }
      }
      if (isHit(normalized, protectedNormalized)) {
        const reason = toolName === 'read' ? READ_DENY_REASON : WRITE_DENY_REASON
        return { block: true, reason }
      }
      // 敏感名单 = 读侧专属（2026-09-19 P0-3）——edit/write 不经此面（写侧
      // 面本就在上方两根 + 凭据；界外写 deny 属 broker 判定面）
      if (
        toolName === 'read' &&
        (hitsSensitiveDir(normalized, sensitiveDirCompare, false) || hitsSensitiveName(normalized))
      ) {
        return { block: true, reason: SENSITIVE_READ_DENY_REASON }
      }
      return undefined
    }
    if (toolName === 'grep') {
      // grep 的 path 可选（缺省搜 cwd）——input.path 非 string 即归 cwd
      const path = input['path']
      const effRoot =
        typeof path === 'string'
          ? normalizePath(path, opts.cwd, homeDir)
          : normalizePath(opts.cwd, opts.cwd, homeDir)
      if (isHit(effRoot, protectedNormalized)) {
        return { block: true, reason: READ_DENY_REASON }
      }
      // 敏感名单搜根：自身在名单内、或敏感目录是搜根后代（搜索会捞出敏感内容）
      if (hitsSensitiveDir(effRoot, sensitiveDirCompare, true) || hitsSensitiveName(effRoot)) {
        return { block: true, reason: SENSITIVE_READ_DENY_REASON }
      }
      return undefined
    }
    // 其他工具（find / ls / bash / custom）→ undefined（不防面详见头注）
    return undefined
  }
}

/** guard 的 inline extension 装配形态——service.ts 注入 extensionFactories */
export function createKeyGuardExtension(opts: {
  rootDir: string
  cwd: string
  homeDir?: string
}): InlineExtension {
  const handler = createKeyGuardHandler(opts)
  return (pi) => {
    pi.on('tool_call', handler)
  }
}
