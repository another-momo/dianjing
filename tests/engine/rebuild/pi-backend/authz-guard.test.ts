/**
 * 2026-09-19 broker P1 件3/件4：authz-guard 钉扎（bash 授权门 + session 规则 +
 * 结构化回执 + data part 直推 + broker-shadow.jsonl 决断日志）。
 *
 * 真 PendingDecisionStore + 直钉 handler（与 key-guard.test.ts 同构，免
 * ExtensionAPI 桩件）；rootDir 用临时目录（决断日志真落盘回读）。覆盖：
 *  - 非 bash / command 非 string → undefined（透传）
 *  - 规则未命中挂卡：data-authz-request payload 冻结契约逐字（formId/kind/
 *    toolName/command 原文/cwd/matchedRule 派生规则）
 *  - allow-once → 放行 + data-authz-decision 完结信号 + 决断日志行
 *  - allow-rule → 规则入 session Map：后续前缀命中静默放行（无新卡无新日志）、
 *    引号/空白归一命中；不匹配命令再挂卡
 *  - 管道/链式 fail-closed：规则在也必弹，matchedRule 展示本可命中的规则原文
 *  - deny（含 note）→ { block, reason } 结构化回执字段（命令原文/拒因/规则/
 *    Try instead/User note）
 *  - abort（rejectForSession）→ 等效 deny 回执 + 完结信号 + 日志 deny 行
 *  - alreadyPending（它族 pending 在挂）→ block 直达防御
 *  - deriveRuleText 派生口径单元钉扎（argv[0]+可识别子命令前缀）
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createAuthzGuardHandler,
  deriveRuleText,
  type AuthzDecisionNotice,
  type AuthzRequestNotice
} from '@/app/ai/pi-backend/authz-guard'
import {
  createPendingDecisionStore,
  type PendingDecisionStore
} from '@/app/ai/pi-backend/pending-decision'

const SESSION = 's1'
const CWD = '/fake/workspace'

/** sink 捕获形态（UIMessageChunk 的结构弱化投影——测试只消费 type/id/data 三面） */
interface CapturedChunk {
  type: string
  id?: string
  data?: unknown
}

/** JSONL 读回形态（宽松类型——kind/decision 宽化为 string，与源码 AuthzDecisionRecord 刻意不同形，type-shapes 门禁） */
interface ShadowLine {
  ts: string
  kind: string
  command: string
  decision: string
  ruleText?: string
}

let store: PendingDecisionStore
let rootDir: string
let chunks: CapturedChunk[]

function makeHandler(makeId?: (toolCallId: string) => string) {
  return createAuthzGuardHandler({
    rootDir,
    cwd: CWD,
    store,
    sessionId: SESSION,
    sink: { emit: (chunk) => chunks.push(chunk) },
    ...(makeId ? { makeId } : {})
  })
}

function bashEvent(command: unknown, toolCallId = 'call-1') {
  return { toolCallId, toolName: 'bash', input: { command } }
}

function requestNotices(): AuthzRequestNotice[] {
  return chunks
    .filter((chunk) => chunk.type === 'data-authz-request')
    .map((chunk) => chunk.data as AuthzRequestNotice)
}

function decisionNotices(): AuthzDecisionNotice[] {
  return chunks
    .filter((chunk) => chunk.type === 'data-authz-decision')
    .map((chunk) => chunk.data as AuthzDecisionNotice)
}

function shadowLines(): ShadowLine[] {
  return readFileSync(join(rootDir, 'broker-shadow.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ShadowLine)
}

beforeEach(() => {
  store = createPendingDecisionStore()
  rootDir = mkdtempSync(join(tmpdir(), 'pi-authz-guard-'))
  chunks = []
})

describe('authz-guard 透传面', () => {
  test('非 bash 工具 → undefined（无注册无通知）', async () => {
    const handler = makeHandler()
    expect(
      await handler({ toolCallId: 'c1', toolName: 'read', input: { path: 'x' } })
    ).toBeUndefined()
    expect(
      await handler({ toolCallId: 'c2', toolName: 'ask_user_question', input: {} })
    ).toBeUndefined()
    expect(store.hasPendingForSession(SESSION)).toBe(false)
    expect(chunks).toHaveLength(0)
  })

  test('command 非 string → undefined（SDK schema 自拒面）', async () => {
    const handler = makeHandler()
    expect(await handler(bashEvent(123))).toBeUndefined()
    expect(store.hasPendingForSession(SESSION)).toBe(false)
  })
})

describe('authz-guard 挂卡 → allow-once 放行', () => {
  test('规则未命中 → 注册 authz pending + data-authz-request 冻结契约 payload 逐字', async () => {
    const handler = makeHandler()
    const command = 'bun test tests/engine/rebuild/foo.test.ts'
    const resultPromise = handler(bashEvent(command))

    // 注册与通知在首个 await 前同步完成
    expect(store.pendingKindForSession(SESSION)).toBe('authz')
    const notices = requestNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toEqual({
      formId: 'authz-call-1',
      kind: 'authz',
      toolName: 'bash',
      command,
      cwd: CWD,
      matchedRule: 'bun test *'
    })

    expect(store.resolveAuthz('authz-call-1', { decision: 'allow-once' })).toBe('ok')
    expect(await resultPromise).toBeUndefined()

    // 完结信号（前端归档用）
    expect(decisionNotices()).toEqual([
      { formId: 'authz-call-1', kind: 'authz', decision: 'allow-once' }
    ])
    // 决断日志：{ ts, kind, command, decision }（无 ruleText）
    const lines = shadowLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.kind).toBe('authz-decision')
    expect(lines[0]?.command).toBe(command)
    expect(lines[0]?.decision).toBe('allow-once')
    expect(lines[0]?.ruleText).toBeUndefined()
    expect(typeof lines[0]?.ts).toBe('string')
    // chunk 级 id = formId（前端 reconciliation 用）
    expect(chunks[0]?.id).toBe('authz-call-1')
  })

  test('formId 默认派生 = authz- + toolCallId；makeId 可注入', async () => {
    const handler = makeHandler((id) => `fixed-${id}`)
    const resultPromise = handler(bashEvent('ls -la', 'tc-9'))
    expect(requestNotices()[0]?.formId).toBe('fixed-tc-9')
    expect(requestNotices()[0]?.matchedRule).toBe('ls *')
    store.resolveAuthz('fixed-tc-9', { decision: 'allow-once' })
    await resultPromise
  })
})

describe('authz-guard allow-rule → session 规则记忆', () => {
  test('allow-rule 后前缀命中静默放行（无新卡无新日志），不匹配命令再挂卡', async () => {
    const handler = makeHandler()
    // 首次：挂卡 → allow-rule 入库
    const first = handler(bashEvent('bun test a.test.ts'))
    store.resolveAuthz('authz-call-1', { decision: 'allow-rule', ruleText: 'bun test *' })
    expect(await first).toBeUndefined()
    expect(decisionNotices()[0]).toEqual({
      formId: 'authz-call-1',
      kind: 'authz',
      decision: 'allow-rule',
      ruleText: 'bun test *'
    })
    expect(shadowLines()[0]?.ruleText).toBe('bun test *')

    // 前缀命中 → 静默放行（同步可断：无注册、无新通知、无新日志）
    expect(await handler(bashEvent('bun test other.test.ts', 'call-2'))).toBeUndefined()
    expect(store.hasPendingForSession(SESSION)).toBe(false)
    expect(requestNotices()).toHaveLength(1)
    expect(shadowLines()).toHaveLength(1)

    // 引号/空白归一后仍命中
    expect(await handler(bashEvent('  "bun" "test" x.test.ts  ', 'call-3'))).toBeUndefined()
    expect(store.hasPendingForSession(SESSION)).toBe(false)

    // 不匹配（前缀第二段不同）→ 再挂卡
    const third = handler(bashEvent('bun install', 'call-4'))
    expect(store.pendingKindForSession(SESSION)).toBe('authz')
    expect(requestNotices()).toHaveLength(2)
    expect(requestNotices()[1]?.matchedRule).toBe('bun install *')
    store.resolveAuthz('authz-call-4', { decision: 'allow-once' })
    await third
  })

  test('单 token 命令规则（ls -la → `ls *`）命中后续 ls 调用', async () => {
    const handler = makeHandler()
    const first = handler(bashEvent('ls -la'))
    expect(requestNotices()[0]?.matchedRule).toBe('ls *')
    store.resolveAuthz('authz-call-1', { decision: 'allow-rule', ruleText: 'ls *' })
    await first
    expect(await handler(bashEvent('ls /tmp', 'call-2'))).toBeUndefined()
    expect(store.hasPendingForSession(SESSION)).toBe(false)
  })

  test('兼容无空格星形规则原文（git status*）入库与命中', async () => {
    const handler = makeHandler()
    const first = handler(bashEvent('git status'))
    store.resolveAuthz('authz-call-1', { decision: 'allow-rule', ruleText: 'git status*' })
    await first
    expect(await handler(bashEvent('git status --short', 'call-2'))).toBeUndefined()
    expect(store.hasPendingForSession(SESSION)).toBe(false)
  })
})

describe('authz-guard 管道/链式 fail-closed', () => {
  test('规则在挂但链式命令必弹，matchedRule 展示本可命中的规则原文', async () => {
    const handler = makeHandler()
    // 先入规则 bun test *
    const first = handler(bashEvent('bun test a.test.ts'))
    store.resolveAuthz('authz-call-1', { decision: 'allow-rule', ruleText: 'bun test *' })
    await first

    const chained = 'bun test a.test.ts && rm -rf /tmp/x'
    const second = handler(bashEvent(chained, 'call-2'))
    expect(store.pendingKindForSession(SESSION)).toBe('authz')
    const notices = requestNotices()
    expect(notices).toHaveLength(2)
    expect(notices[1]?.command).toBe(chained)
    expect(notices[1]?.matchedRule).toBe('bun test *')

    store.resolveAuthz('authz-call-2', { decision: 'deny' })
    const verdict = await second
    expect(verdict?.block).toBe(true)
    expect(verdict?.reason).toContain('Related rule: bun test *')
  })

  test('管道符/分号/换行同样 fail-closed', async () => {
    const handler = makeHandler()
    const first = handler(bashEvent('cat a.txt'))
    store.resolveAuthz('authz-call-1', { decision: 'allow-rule', ruleText: 'cat *' })
    await first
    for (const [index, chained] of [
      'cat a | grep x',
      'cat a; rm b',
      'cat a || echo x',
      'cat a\ncat b'
    ].entries()) {
      const pending = handler(bashEvent(chained, `call-p${index}`))
      expect(store.pendingKindForSession(SESSION)).toBe('authz')
      store.resolveAuthz(`authz-call-p${index}`, { decision: 'allow-once' })
      await pending
    }
  })
})

describe('authz-guard deny → 结构化回执', () => {
  test('deny + note → 回执含命令原文/拒因/规则原文/Try instead/User note', async () => {
    const handler = makeHandler()
    const command = 'git push origin main'
    const resultPromise = handler(bashEvent(command))
    store.resolveAuthz('authz-call-1', { decision: 'deny', note: '别直接推主干' })
    const verdict = await resultPromise
    expect(verdict?.block).toBe(true)
    const reason = verdict?.reason ?? ''
    expect(reason).toContain(`Bash command denied by the user: ${command}`)
    expect(reason).toContain('Reason: the user declined the authorization request.')
    expect(reason).toContain('User note: 别直接推主干')
    expect(reason).toContain('Related rule: git push *')
    expect(reason).toContain('Try instead:')
    // 完结信号与日志记 deny（无 ruleText）
    expect(decisionNotices()[0]).toEqual({
      formId: 'authz-call-1',
      kind: 'authz',
      decision: 'deny'
    })
    const lines = shadowLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.decision).toBe('deny')
    expect(lines[0]?.ruleText).toBeUndefined()
  })

  test('规则不可派生（空命令形）→ 回执无 Related rule 行', async () => {
    const handler = makeHandler()
    const resultPromise = handler(bashEvent('""'))
    expect(requestNotices()[0]?.matchedRule).toBeUndefined()
    store.resolveAuthz('authz-call-1', { decision: 'deny' })
    const verdict = await resultPromise
    expect(verdict?.reason).not.toContain('Related rule:')
  })
})

describe('authz-guard abort → 等效 deny', () => {
  test('rejectForSession → block + abort 回执 + 完结信号 deny + 日志 deny 行', async () => {
    const handler = makeHandler()
    const command = 'rm -rf build-output'
    const resultPromise = handler(bashEvent(command))
    expect(store.pendingKindForSession(SESSION)).toBe('authz')
    store.rejectForSession(SESSION, new Error('aborted'))
    const verdict = await resultPromise
    expect(verdict?.block).toBe(true)
    const reason = verdict?.reason ?? ''
    expect(reason).toContain(`Bash command not run: ${command}`)
    expect(reason).toContain('aborted')
    expect(reason).toContain('Try instead:')
    expect(decisionNotices()).toEqual([{ formId: 'authz-call-1', kind: 'authz', decision: 'deny' }])
    const lines = shadowLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.decision).toBe('deny')
    expect(lines[0]?.command).toBe(command)
  })
})

describe('authz-guard alreadyPending 直达防御', () => {
  test('它族 pending 在挂 → block（一次只挂一张授权卡），不推新卡', async () => {
    store.registerAsk(SESSION, 'ask-1')
    const handler = makeHandler()
    const verdict = await handler(bashEvent('ls'))
    expect(verdict?.block).toBe(true)
    expect(verdict?.reason).toContain('another form or authorization request')
    expect(requestNotices()).toHaveLength(0)
    // 旧条目未被消费
    expect(store.pendingKindForSession(SESSION)).toBe('ask')
    store.resolveAsk('ask-1', { skip: true })
  })
})

describe('deriveRuleText 派生口径（拍板 11-4：argv[0]+可识别子命令前缀）', () => {
  test('子命令形第二段收入前缀', () => {
    expect(deriveRuleText(['bun', 'test', 'x.test.ts'])).toBe('bun test *')
    expect(deriveRuleText(['git', 'status'])).toBe('git status *')
    expect(deriveRuleText(['git', 'push', 'origin', 'main'])).toBe('git push *')
  })

  test('flag/路径/URL 形第二段不收入前缀', () => {
    expect(deriveRuleText(['ls', '-la'])).toBe('ls *')
    expect(deriveRuleText(['curl', 'https://example.com'])).toBe('curl *')
    expect(deriveRuleText(['cat', './a.txt'])).toBe('cat *')
  })

  test('单 token 与空输入', () => {
    expect(deriveRuleText(['ls'])).toBe('ls *')
    expect(deriveRuleText([])).toBe(null)
  })
})
