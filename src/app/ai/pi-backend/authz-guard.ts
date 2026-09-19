/**
 * 2026-09-19 broker P1 件3/件4（仓外 docs/202609181745-agent-permission-broker-design.md
 * §5/§7，拍板 11-4）：bash 授权门——tool_call 仅理 toolName === 'bash'（其余恒
 * undefined）。session 规则命中静默放行；未命中挂 PendingDecisionStore（kind
 * 'authz'）等前端授权卡决断：allow-once 放行 / allow-rule 放行并把规则原文入
 * session 内存 Map（进程焚，不持久化）/ deny → { block, reason: 结构化回执 }。
 *
 * 事实层系统直出（设计稿约束②，弹窗无模型撰写位）：formId/kind/toolName/
 * command 原文/cwd 由 guard 从 event 直取。SSE 通道 = service emit 层直推
 * data-authz-request（绕开 SDK custom message 缺口——per-session sink 缝，run
 * 活动期由 service 接线、收尾拆线；ask onPendingRegistered → host 记录缝同构
 * 扩展），已决推 data-authz-decision 完结信号（前端归档用，与 ask 已决归档
 * 同构）。
 *
 * 规则口径（拍板 11-4）：argv[0] + 可识别子命令前缀（`bun test *` /
 * `git status *`）——规则原文用户确认后入库，粒度不由系统猜；管道/链式
 * （`&&`/`||`/`;`/`|`/换行）出现 = 整条不享受规则命中、必弹（fail-closed）。
 * 卡面 matchedRule = 本可命中（链式时）或将入库（未命中时）的规则原文——
 * 「你将放行的是什么」，allow-rule 按钮回传此文本作 ruleText。
 *
 * 观测联动（件4）：用户决断结果（allow-once/allow-rule/deny + ruleText 如有）
 * 与 abort 等效 deny append 一行 rootDir/broker-shadow.jsonl（P0-2 落盘纪律：
 * try/catch 静默吞、append-only——观测永不能打断工具执行）；规则命中静默放行
 * 不落（日志只记决断）。
 *
 * 与 key-guard 同构：handler 与 extension 分离导出，测试直钉 handler（免
 * ExtensionAPI 桩件）。session 规则 = 闭包内内存 Map——extension 工厂按
 * session 装配（session/assembly.ts），天然 session 隔离。
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { UIMessageChunk } from 'ai'

import type { AuthzAnswerPayload, AuthzDecision, PendingDecisionStore } from './pending-decision'

/** data-authz-request payload（并行线冻结契约，逐字字段禁改） */
export interface AuthzRequestNotice {
  formId: string
  kind: 'authz'
  toolName: 'bash'
  /** 命令原文（event.input.command 直取，不改写） */
  command: string
  cwd: string
  /** 本可命中/将入库的规则原文（「你将放行的是什么」= 卡按钮呈现文本；空命令等不可派生时缺省） */
  matchedRule?: string
}

/** data-authz-decision payload（已决完结信号，前端归档用；形态与 ask 已决 details 同构） */
export interface AuthzDecisionNotice {
  formId: string
  kind: 'authz'
  decision: AuthzDecision
  ruleText?: string
}

/**
 * data part 直推缝（per-session）：service.runPrompt 活动期接线 emit、收尾拆线
 * null——guard 经闭包直调（run 外到来即静默丢，正常不存在该时序）。
 */
export interface AuthzNoticeSink {
  emit: ((chunk: UIMessageChunk) => void) | null
}

export function createAuthzNoticeSink(): AuthzNoticeSink {
  return { emit: null }
}

/** session 规则（内存，进程焚；grantedAt 留观测位，不入判定） */
interface SessionRule {
  ruleText: string
  /** 归一化 argv 前缀（token 级匹配） */
  prefix: string[]
  grantedAt: string
}

export interface AuthzGuardOptions {
  /** broker-shadow.jsonl 落点（决断日志） */
  rootDir: string
  /** session cwd（事实层 cwd 字段；= rootDir/workspace） */
  cwd: string
  store: PendingDecisionStore
  sessionId: string
  sink: AuthzNoticeSink
  /** formId 派生（默认 'authz-'+toolCallId；测试可注入确定性） */
  makeId?: (toolCallId: string) => string
}

/** 管道/链式判定（fail-closed）：出现即整条不享受规则命中、必弹 */
const CHAIN_PATTERN = /&&|\|\||[;|\n]/

/** 可识别子命令形：裸词（字母开头的连字符词），非 flag/路径/URL/赋值 */
const SUBCOMMAND_PATTERN = /^[a-z][a-z0-9-]*$/i

/** 保守命令解析：首尾空白归一 + 按空白切 token + 去成对首尾引号 + 空 token 过滤 */
function tokenizeCommand(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map(stripSurroundingQuotes)
    .filter((token) => token !== '')
}

function stripSurroundingQuotes(token: string): string {
  if (token.length < 2) return token
  const first = token[0]
  const last = token[token.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return token.slice(1, -1)
  }
  return token
}

/**
 * 规则派生（拍板 11-4：粒度不由系统猜——固定 argv[0] + 可识别子命令前缀）：
 * `bun test …` → `bun test *`；`git status` → `git status *`；`ls -la` → `ls *`。
 * 暴露单独函数便于测试直钉。
 */
export function deriveRuleText(tokens: string[]): string | null {
  if (tokens.length === 0) return null
  const head = tokens[0]
  const sub = tokens.length > 1 ? tokens[1] : undefined
  const prefix = sub !== undefined && SUBCOMMAND_PATTERN.test(sub) ? [head, sub] : [head]
  return `${prefix.join(' ')} *`
}

/** 规则原文 → argv 前缀（入库用；兼容 `git status *` 与 `git status*` 两形） */
function ruleTextToPrefix(ruleText: string): string[] | null {
  const tokens = tokenizeCommand(ruleText)
  const last = tokens.at(-1)
  if (last === '*') tokens.pop()
  else if (last?.endsWith('*')) tokens[tokens.length - 1] = last.slice(0, -1)
  const prefix = tokens.filter((token) => token !== '')
  return prefix.length > 0 ? prefix : null
}

function matchSessionRule(
  rules: ReadonlyMap<string, SessionRule>,
  tokens: string[]
): SessionRule | null {
  for (const rule of rules.values()) {
    if (tokens.length < rule.prefix.length) continue
    if (rule.prefix.every((segment, index) => tokens[index] === segment)) return rule
  }
  return null
}

/** 决断日志行（broker-shadow.jsonl 一行一件，append-only；与 P0-2 shadow 行同档） */
interface AuthzDecisionRecord {
  ts: string
  kind: 'authz-decision'
  command: string
  decision: AuthzDecision
  ruleText?: string
}

function appendDecisionRecord(logFile: string, record: AuthzDecisionRecord): void {
  try {
    appendFileSync(logFile, JSON.stringify(record) + '\n')
  } catch {
    // 观测永不能打断工具执行——落盘失败静默吞（path-observe.ts 同纪律）
    // oxlint-disable-next-line open-pencil/no-silent-catch
    return undefined
  }
}

const TRY_INSTEAD =
  'Try instead: use the dedicated tools where possible (read/grep/find/ls for file inspection), ask the user to run the command manually, or propose an alternative approach.'

const ALREADY_PENDING_REASON =
  "Bash command not run: another form or authorization request is still awaiting the user's decision; wait for it to resolve before retrying."

/** 结构化拒绝回执（轻量版，设计稿 §5）：命令原文 + 拒因 + 命中规则原文（如有）+ tryInstead 一句话 */
function denyReasonText(
  command: string,
  matchedRule: string | undefined,
  note: string | undefined
): string {
  const lines = [
    `Bash command denied by the user: ${command}`,
    `Reason: the user declined the authorization request.${note ? ` User note: ${note}` : ''}`
  ]
  if (matchedRule) lines.push(`Related rule: ${matchedRule}`)
  lines.push(TRY_INSTEAD)
  return lines.join('\n')
}

/** abort 等效 deny 回执（轮次生命周期语义：无人值守默认 deny，设计稿 §9） */
function abortDenyReasonText(command: string, matchedRule: string | undefined): string {
  const lines = [
    `Bash command not run: ${command}`,
    'Reason: the authorization request was aborted (run cancelled or client disconnected) — unattended runs default to deny.'
  ]
  if (matchedRule) lines.push(`Related rule: ${matchedRule}`)
  lines.push(TRY_INSTEAD)
  return lines.join('\n')
}

/**
 * bash 授权门 handler——暴露单独函数便于测试直钉（与 createKeyGuardHandler 同构）。
 * async：规则未命中时挂起等前端决断（ExtensionHandler async 实证，设计稿 §3）。
 */
export function createAuthzGuardHandler(
  opts: AuthzGuardOptions
): (event: {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}) => Promise<{ block: true; reason: string } | undefined> {
  const makeId = opts.makeId ?? ((toolCallId: string): string => `authz-${toolCallId}`)
  const logFile = join(opts.rootDir, 'broker-shadow.jsonl')
  // session 规则存储 = 闭包内内存 Map（进程焚，不持久化；key = 规则原文）
  const rules = new Map<string, SessionRule>()

  const emitRequest = (notice: AuthzRequestNotice): void => {
    opts.sink.emit?.({ type: 'data-authz-request', id: notice.formId, data: notice })
  }
  const emitDecision = (notice: AuthzDecisionNotice): void => {
    opts.sink.emit?.({ type: 'data-authz-decision', id: notice.formId, data: notice })
  }
  const logDecision = (command: string, decision: AuthzDecision, ruleText?: string): void => {
    appendDecisionRecord(logFile, {
      ts: new Date().toISOString(),
      kind: 'authz-decision',
      command,
      decision,
      ...(ruleText ? { ruleText } : {})
    })
  }

  return async (event) => {
    if (event.toolName !== 'bash') return undefined
    const command = event.input['command']
    // input.command 必填（bash schema 实证）；非 string 放行由 SDK schema 自拒
    if (typeof command !== 'string') return undefined
    const tokens = tokenizeCommand(command)
    const hasChain = CHAIN_PATTERN.test(command)
    const existingRuleText = matchSessionRule(rules, tokens)?.ruleText
    // 规则命中（且非链式）→ 静默放行：不挂卡、不落决断日志（日志只记用户决断）
    if (!hasChain && existingRuleText !== undefined) return undefined
    // 卡面规则原文 = 链式时本可命中的规则 ?? 派生候选（「你将放行的是什么」）
    const matchedRule =
      (hasChain ? existingRuleText : undefined) ?? deriveRuleText(tokens) ?? undefined

    const formId = makeId(event.toolCallId)
    const { promise, alreadyPending } = opts.store.registerAuthz(opts.sessionId, formId)
    if (alreadyPending) {
      // 双族锁面（ask/pending-guard）常态先行拦截；本分支为直达防御（一次只挂一张授权卡）
      return { block: true, reason: ALREADY_PENDING_REASON }
    }
    emitRequest({
      formId,
      kind: 'authz',
      toolName: 'bash',
      command,
      cwd: opts.cwd,
      ...(matchedRule ? { matchedRule } : {})
    })

    let payload: AuthzAnswerPayload
    try {
      payload = await promise
    } catch {
      // abort / 会话 GC → 等效 deny（挂起语义同 ask；轮次生命周期语义，设计稿 §9）
      emitDecision({ formId, kind: 'authz', decision: 'deny' })
      logDecision(command, 'deny')
      return { block: true, reason: abortDenyReasonText(command, matchedRule) }
    }

    emitDecision({
      formId,
      kind: 'authz',
      decision: payload.decision,
      ...(payload.ruleText ? { ruleText: payload.ruleText } : {})
    })
    logDecision(command, payload.decision, payload.ruleText)
    if (payload.decision === 'deny') {
      return { block: true, reason: denyReasonText(command, matchedRule, payload.note) }
    }
    if (payload.decision === 'allow-rule' && payload.ruleText) {
      const prefix = ruleTextToPrefix(payload.ruleText)
      if (prefix) {
        rules.set(payload.ruleText, {
          ruleText: payload.ruleText,
          prefix,
          grantedAt: new Date().toISOString()
        })
      }
    }
    return undefined
  }
}

/** bash 授权门的 inline extension 装配形态——session/assembly.ts 注入 extensionFactories */
export function createAuthzGuardExtension(opts: AuthzGuardOptions): InlineExtension {
  const handler = createAuthzGuardHandler(opts)
  return (pi) => {
    pi.on('tool_call', handler)
  }
}
