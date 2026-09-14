/**
 * T66（T66-plan ④）停止按钮修复钉扎：abort 守卫去 running 布尔依赖。
 *
 * 回归场景（2026-09-01 链路实证）：前端 stop → fetch abort → server.ts
 * res.on('close') → service.abort(sessionId)。旧守卫 `if (!entry?.running)
 * return` 与 runPrompt finally（entry.running = false）时序竞争——close
 * 事件晚于 run 收尾时 abort 被整体跳过，后端继续烧 token。
 *
 * 修复后：entry 存在即无条件 session.abort()（pi 对 idle session 的 abort
 * 是无害 no-op——pi-agent-core agent.js `activeRun?.abortController.abort()`
 * 可选链空转 + waitForIdle() isIdle 即返回，实证见 service.ts abort 注释）。
 *
 * 覆盖：
 *  1. run 已收尾（entry.running 复位 false）后 abort → session.abort 仍被调用
 *     （旧实现下此处为零调用——本用例即回归钉扎）
 *  2. run 进行中 abort → session.abort 被调用（原 T27 语义保留）
 *  3. 未知 sessionId → no-op，不抛错
 *  4. session.abort 自身抛错 → 吞掉（不冒 unhandled rejection）
 *
 * 夹具：mock.module 桩掉 @earendil-works/pi-coding-agent（createAgentSession
 * 返回可控假 session）；admin/credentials 注入假件；rootDir 用临时目录
 * （studio 注册表缺 base 按 failures 降级，不抛错；桥不可达时 prepareTurn
 * 按空槽降级——active-design-host 既有语义）。
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const abortSpy = mock(() => Promise.resolve())
let promptImpl: () => Promise<void> = () => Promise.resolve()

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({
    session: {
      prompt: () => promptImpl(),
      subscribe: () => () => undefined,
      abort: () => abortSpy(),
      sessionManager: { getSessionFile: () => null }
    }
  }),
  DefaultResourceLoader: class {
    reload(): Promise<void> {
      return Promise.resolve()
    }
  },
  SessionManager: {
    create: () => ({ getSessionFile: () => null }),
    open: () => ({ getSessionFile: () => null })
  },
  defineTool: (def: unknown) => def,
  // T91c 修复：mock.module 是 process 级（bun:test 语义），
  // 同批跑的 marketing/ask-user-question-roundtrip.test.ts 用 readPiHistoryFile
  // 依赖真 parseSessionEntries；stub 成 () => [] 会让 roundtrip 测试拿到空历史。
  parseSessionEntries: (content: string): unknown[] => {
    const entries: unknown[] = []
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
        // oxlint-disable-next-line open-pencil/no-silent-catch -- 容错 skip 是 SDK 真语义：malformed 行静默跳过，非错误吞没
      } catch {
        // skip malformed
      }
    }
    return entries
  }
}))

import { createPiChatService } from '@/app/ai/pi-backend/service'

function makeService() {
  return createPiChatService({
    rootDir: mkdtempSync(join(tmpdir(), 'pi-abort-test-')),
    // createAgentSession 已被 mock（不消费 resolveModel 产物/凭证面），桩件按
    // 仓内测试惯例 `as never` 注入（mcp-runtime.test.ts 先例）
    admin: {
      resolveModel: async () => ({ modelRuntime: null, model: null })
    } as never,
    imageGenCredentials: {} as never
  })
}

describe('pi-backend service.abort（T66 ④ 守卫去 running 依赖）', () => {
  beforeEach(() => {
    abortSpy.mockReset()
    abortSpy.mockImplementation(() => Promise.resolve())
    promptImpl = () => Promise.resolve()
  })

  test('run 已收尾（entry.running 复位）后 abort → session.abort 仍送达', async () => {
    const service = makeService()
    // 完整跑完一个 prompt run——finally 已把 entry.running 复位 false
    await service.prompt('sess-finished', 'hello', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    expect(abortSpy).toHaveBeenCalledTimes(0)

    // 客户端断连（res.on('close')）晚于 run 收尾的场景：旧守卫会跳过 abort
    await service.abort('sess-finished')
    expect(abortSpy).toHaveBeenCalledTimes(1)
  })

  test('run 进行中 abort → session.abort 送达（T27 原语义保留）', async () => {
    const service = makeService()
    let release!: () => void
    let started!: () => void
    const runStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    promptImpl = () =>
      new Promise<void>((resolve) => {
        release = resolve
        started()
      })
    const pending = service.prompt('sess-running', 'hi', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    // 确定性等到 run 进行中（假 session.prompt 已被调起 → entry 已建、
    // running 已置真）——不定长 sleep 在慢 CI 上有假阴性风险
    await runStarted

    await service.abort('sess-running')
    expect(abortSpy).toHaveBeenCalledTimes(1)

    release()
    await pending
  })

  test('未知 sessionId → no-op 不抛错', async () => {
    const service = makeService()
    await expect(service.abort('sess-nonexistent')).resolves.toBeUndefined()
    expect(abortSpy).toHaveBeenCalledTimes(0)
  })

  test('session.abort 抛错 → 吞掉不冒 unhandled rejection', async () => {
    const service = makeService()
    await service.prompt('sess-throwing', 'hello', () => undefined, {
      model: { providerId: 'openrouter', modelId: 'openrouter/free' }
    })
    abortSpy.mockImplementation(() => Promise.reject(new Error('session disposed')))
    await expect(service.abort('sess-throwing')).resolves.toBeUndefined()
    expect(abortSpy).toHaveBeenCalledTimes(1)
  })
})
