/**
 * 2026-09-26 sl-w1-page-state：open-docs guard 单测——
 *
 * 覆盖矩阵：
 *  - 空目录 → claim 成功，磁盘落盘 + 内存注册
 *  - 同进程同 windowId 重复 claim → 刷心跳直接返 ok（多窗复用快路）
 *  - 异 pid（不同进程实例）活跃持有 → 拦 + holder 透传
 *  - 同 pid 不同 windowId（多窗）→ 拦（同进程内不撞实例号 = 同实例不同窗 = 还是拦）
 *  - stale 记录（心跳超 TTL） → 自动覆写
 *  - force=true → 跳过冲突拦截，强制抢断
 *  - heartbeat 自身刷成功；他人占着 → 返 false（409 触发）
 *  - heartbeat stale 覆写 + force 抢断
 *  - release 自身清除；他人占着 → no-op 返 false（routes 层一律返 204）
 *  - exists 跨进程读盘 + 内存查
 *  - docUuid / windowId 合法性校验
 *  - 内存 + 落盘双路（claim 后 exists 双 true；release 后双 false）
 *
 * 测试时钟：now 注入可调，避免真等 60s。
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOpenDocsGuard, DEFAULT_HEARTBEAT_TTL_MS } from '@/app/ai/pi-backend/open-docs/guard'

let openDocsDir = ''
let nowMs = 1_000_000
const now = () => nowMs

beforeEach(() => {
  openDocsDir = mkdtempSync(join(tmpdir(), 'open-docs-'))
  nowMs = 1_000_000
})

afterEach(() => {
  rmSync(openDocsDir, { recursive: true, force: true })
})

const DOC = 'doc-uuid-1'

test('空目录 → claim 成功，磁盘 + 内存双登记', () => {
  const guard = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  const result = guard.claim(DOC, 'win-1')
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.record.pid).toBe(100)
  expect(result.record.windowId).toBe('win-1')
  expect(result.record.heartbeatAt).toBe(1_000_000)
  expect(existsSync(join(openDocsDir, `${DOC}.json`))).toBe(true)
  expect(guard.exists(DOC)).toBe(true)
})

test('同进程同 windowId 重复 claim → 刷心跳直接 ok（多窗复用快路）', () => {
  const guard = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  guard.claim(DOC, 'win-1')
  nowMs += 5_000
  const second = guard.claim(DOC, 'win-1')
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.record.heartbeatAt).toBe(nowMs)
})

test('异 pid 活跃持有 → 拦（透传 holder）', () => {
  const ownerA = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  ownerA.claim(DOC, 'win-1')

  const challenger = createOpenDocsGuard({ openDocsDir, pid: 200, now })
  const result = challenger.claim(DOC, 'win-2')
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toBe('live_other_instance')
  expect(result.holder.pid).toBe(100)
  expect(result.holder.windowId).toBe('win-1')
})

test('同 pid 不同 windowId → 拦（多窗各自独立窗口身份）', () => {
  const owner = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  owner.claim(DOC, 'win-1')

  const otherWin = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  const result = otherWin.claim(DOC, 'win-2')
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toBe('live_other_instance')
})

test('stale 记录（心跳超 TTL） → 自动覆写', () => {
  const ownerA = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  ownerA.claim(DOC, 'win-1')

  // 时间跳到 TTL+1 之后
  nowMs += DEFAULT_HEARTBEAT_TTL_MS + 1

  const challenger = createOpenDocsGuard({ openDocsDir, pid: 200, now })
  const result = challenger.claim(DOC, 'win-2')
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.record.pid).toBe(200)
  expect(result.record.windowId).toBe('win-2')
})

test('force=true → 跳过冲突拦截，强制抢断', () => {
  const ownerA = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  ownerA.claim(DOC, 'win-1')

  const challenger = createOpenDocsGuard({ openDocsDir, pid: 200, now })
  const result = challenger.claim(DOC, 'win-2', { force: true })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.record.pid).toBe(200)
})

test('heartbeat 自身刷成功', () => {
  const guard = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  guard.claim(DOC, 'win-1')
  nowMs += 5_000
  expect(guard.heartbeat(DOC, 'win-1')).toBe(true)
})

test('heartbeat 他人占着 → 返 false（routes 层转 409）', () => {
  const ownerA = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  ownerA.claim(DOC, 'win-1')

  const challenger = createOpenDocsGuard({ openDocsDir, pid: 200, now })
  expect(challenger.heartbeat(DOC, 'win-2')).toBe(false)
})

test('heartbeat stale 覆写成功', () => {
  const ownerA = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  ownerA.claim(DOC, 'win-1')

  nowMs += DEFAULT_HEARTBEAT_TTL_MS + 1

  const challenger = createOpenDocsGuard({ openDocsDir, pid: 200, now })
  expect(challenger.heartbeat(DOC, 'win-2')).toBe(true)
})

test('heartbeat force 抢断成功', () => {
  const ownerA = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  ownerA.claim(DOC, 'win-1')

  const challenger = createOpenDocsGuard({ openDocsDir, pid: 200, now })
  expect(challenger.heartbeat(DOC, 'win-2', { force: true })).toBe(true)
})

test('heartbeat 落盘空 + 内存空 → 返 false（避免幽灵续期）', () => {
  const guard = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  expect(guard.heartbeat(DOC, 'win-1')).toBe(false)
})

test('release 自身清除 → 双路（内存 + 磁盘）同步删', () => {
  const guard = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  guard.claim(DOC, 'win-1')
  expect(guard.release(DOC, 'win-1')).toBe(true)
  expect(guard.exists(DOC)).toBe(false)
  expect(existsSync(join(openDocsDir, `${DOC}.json`))).toBe(false)
})

test('release 他人占着 → 返 false（routes 层一律 204 不挂起）', () => {
  const ownerA = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  ownerA.claim(DOC, 'win-1')

  const challenger = createOpenDocsGuard({ openDocsDir, pid: 200, now })
  expect(challenger.release(DOC, 'win-2')).toBe(false)
  // 落盘仍存（A 没释放）
  expect(existsSync(join(openDocsDir, `${DOC}.json`))).toBe(true)
})

test('release 落盘空 → 返 false（幂等 no-op）', () => {
  const guard = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  expect(guard.release(DOC, 'win-1')).toBe(false)
})

test('exists 内存注册表 + 磁盘双查（跨进程读盘）', () => {
  const ownerA = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  ownerA.claim(DOC, 'win-1')

  // 全新实例（不同 pid） + 内存空：跨进程读盘仍返 true（盘上有登记）
  const other = createOpenDocsGuard({ openDocsDir, pid: 200, now })
  expect(other.exists(DOC)).toBe(true)
})

test('windowId 空 → claim / heartbeat / release 拒绝（throw / false）', () => {
  const guard = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  expect(() => guard.claim(DOC, '')).toThrow(TypeError)
  expect(guard.heartbeat(DOC, '')).toBe(false)
  expect(guard.release(DOC, '')).toBe(false)
})

test('docUuid 非法字符 → throw TypeError', () => {
  const guard = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  expect(() => guard.claim('../escape', 'win-1')).toThrow(TypeError)
  expect(() => guard.heartbeat('a'.repeat(129), 'win-1')).toThrow(TypeError)
  expect(() => guard.release('', 'win-1')).toThrow(TypeError)
})

test('坏 JSON 落盘 → 当作不存在可正常 claim（腐烂即无）', () => {
  // 直接手写坏 JSON 模拟腐烂
  const path = join(openDocsDir, `${DOC}.json`)
  writeFileSync(path, '{not-json}', 'utf8')

  const guard = createOpenDocsGuard({ openDocsDir, pid: 100, now })
  const result = guard.claim(DOC, 'win-1')
  expect(result.ok).toBe(true)
})
