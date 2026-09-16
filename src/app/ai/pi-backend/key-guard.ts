/**
 * 2026-09-16 凭据守卫 A 案——tool_call 拦内建文件工具对凭据四件的读/写/搜，
 * 阻断 key 明文进模型上下文；预研与拍板 = 仓外 docs/202609151649-pi-agent-key-file-guard-research.md。
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
 *
 * 凭据四件（在 rootDir 下）：
 *  - pi-agent/auth.json（provider key 明文）
 *  - pi-agent/image-gen.json（image-gen apiKey 明文，image-gen/credentials.ts:63）
 *  - key-env（自助注入文件）
 *  - pi-backend-token（standalone 模式鉴权 token）
 */

import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'

import type { InlineExtension } from '@earendil-works/pi-coding-agent'

import { resolveAgentDir, resolveKeyEnvPath, resolvePiBackendTokenPath } from './paths'

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
 * 统一成可比较形态：~ 展开 → 分隔符统一 → 绝对判定（前导 '/' 或盘符）
 * → resolve(cwd, p) → 全小写 → 去尾部分隔符。
 *
 * 先统一分隔符再做绝对判定——判定口径跨平台一致：Win 形态（反斜杠/盘符）
 * 在 POSIX 上也按同一形态归一（guard 是字符串匹配器，对不会在宿主机解析
 * 成功的拼法过挡属 fail-safe；2026-09-16 CI 34999312845 实证：isAbsolute
 * 平台语义致反斜杠用例在 Linux 漏挡）。
 *
 * 全小写 = 目标平台 Win/mac 文件系统均大小写不敏感；对大小写敏感 FS
 * 是 fail-safe 过挡（凭据邻名宁可错挡）。
 */
function normalizePath(input: string, cwd: string, homeDir: string): string {
  // ~ 展开：仅首字符 ~ 且后跟分隔符或串尾
  const expanded =
    input.startsWith('~') && (input.length === 1 || input[1] === '/' || input[1] === '\\')
      ? homeDir + input.slice(1)
      : input
  const unifiedInput = expanded.replaceAll('\\', '/')
  const isAbs = unifiedInput.startsWith('/') || /^[a-zA-Z]:\//.test(unifiedInput)
  const absolute = isAbs ? unifiedInput : resolve(cwd, unifiedInput).replaceAll('\\', '/')
  const lower = absolute.toLowerCase()
  // 去尾部分隔符：根 '/' 须保留
  const trimmed = lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower
  return trimmed
}

/**
 * 命中判定：effRoot（grep 搜索根）是否指向凭据文件本身、或凭据文件是其
 * 后代——后代情况下 grep 搜根会捞出凭据文件内容，必须阻断。
 */
function isCredentialHit(effRoot: string, protectedNormalized: ReadonlySet<string>): boolean {
  for (const target of protectedNormalized) {
    if (effRoot === target) return true
    if (target.startsWith(effRoot + '/')) return true
  }
  return false
}

const READ_DENY_REASON =
  'Access denied: this path stores API credentials/tokens and is protected from agent access. ' +
  'Do not read, search, or infer credential files — if credentials need inspection or changes, direct the user to the Settings panel.'

const WRITE_DENY_REASON =
  'Access denied: this path stores API credentials/tokens and is protected from agent writes. ' +
  'Credential updates go through the Settings panel (credential routes) only.'

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

  return (event) => {
    const { toolName, input } = event
    if (toolName === 'read' || toolName === 'edit' || toolName === 'write') {
      // input.path 必填（schema 实证，read.d.ts:5 typebox path: string），但
      // 双断言 lint + Record 索引访问 no-unnecessary-condition 都不友好；非 string
      // 直接放行（SDK schema 自会拒）
      const path = input['path']
      if (typeof path !== 'string') return undefined
      const normalized = normalizePath(path, opts.cwd, homeDir)
      if (!isCredentialHit(normalized, protectedNormalized)) return undefined
      const reason = toolName === 'read' ? READ_DENY_REASON : WRITE_DENY_REASON
      return { block: true, reason }
    }
    if (toolName === 'grep') {
      // grep 的 path 可选（缺省搜 cwd）——input.path 非 string 即归 cwd
      const path = input['path']
      const effRoot =
        typeof path === 'string'
          ? normalizePath(path, opts.cwd, homeDir)
          : normalizePath(opts.cwd, opts.cwd, homeDir)
      if (!isCredentialHit(effRoot, protectedNormalized)) return undefined
      return { block: true, reason: READ_DENY_REASON }
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
