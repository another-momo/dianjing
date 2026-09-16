/**
 * 2026-09-16（owner 拍板②）指派切换对下一个 prompt 生效——驱逐重建钉扎。
 *
 * 语义（service.ts prompt() 注释是真源）：池内会话烘焙 spec 与请求 spec
 * 不一致 → 先等在跑 run 收尾（queue 串行语义）→ dispose 旧会话 →
 * createSession 重建（SessionManager.open 重开同一 JSONL，历史连续）。
 * thinkingLevel 缺省与 'off' 同义（sameModelSpec 归一化，不白重建）。
 *
 * 覆盖：
 *  1. 同 spec 连发 → 复用不重建（零开销路径）
 *  2. 异 modelId → dispose 旧会话 + 按新 spec 重建
 *  3. thinkingLevel 'off' ↔ 缺省 同义不重建；缺省 → 'high' 重建
 *  4. run 进行中改 spec → 新 prompt 等旧 run 收尾后才重建（不打断进行中回合）
 *
 * 夹具：mock.module 桩掉 @earendil-works/pi-coding-agent（service-abort.test.ts
 * 同款共存形态，parseSessionEntries 细心直通同前）；admin 注入 resolveModel
 * 间谍（捕获每次 resolve 的 spec——重建证据链）；rootDir 临时目录。
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ModelSpec } from '@/app/ai/pi-backend/provider-admin'

const disposeSpy = mock(() => undefined)
const resolvedSpecs: ModelSpec[] = []
const createdModels: unknown[] = []
let promptImpl: () => Promise<void> = () => Promise.resolve()

/** mock 的 createAgentSession 入参最小形状（lint：禁 Record<string, unknown> 泛投） */
interface FakeSessionOptions {
  model?: unknown
}

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: (options: FakeSessionOptions) => {
    createdModels.push(options.model ?? null)
    return Promise.resolve({
      session: {
        prompt: () => promptImpl(),
        subscribe: () => () => undefined,
        abort: () => Promise.resolve(),
        dispose: () => disposeSpy(),
        sessionManager: { getSessionFile: () => null }
      }
    })
  },
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
  // service-abort.test.ts 同款细心直通：process 级 mock 不得让同批
  // readPiHistoryFile 消费者拿到空历史
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
    rootDir: mkdtempSync(join(tmpdir(), 'pi-rebuild-test-')),
    admin: {
      resolveModel: (spec: ModelSpec) => {
        resolvedSpecs.push(spec)
        return Promise.resolve({ modelRuntime: null, model: null })
      }
    } as never,
    imageGenCredentials: {} as never,
    imageGenSettings: {} as never
  })
}

const SPEC_A: ModelSpec = { providerId: 'minimax-cn', modelId: 'MiniMax-M2.7' }
const SPEC_B: ModelSpec = { providerId: 'minimax-cn', modelId: 'MiniMax-M3' }

describe('pi-backend service prompt 驱逐重建（2026-09-16 拍板②：切换对下一个 prompt 生效）', () => {
  beforeEach(() => {
    disposeSpy.mockReset()
    resolvedSpecs.length = 0
    createdModels.length = 0
    promptImpl = () => Promise.resolve()
  })

  test('同 spec 连发 → 复用不重建（零开销路径）', async () => {
    const service = makeService()
    await service.prompt('sess-same', 'hi', () => undefined, { model: SPEC_A })
    await service.prompt('sess-same', 'hi again', () => undefined, { model: SPEC_A })
    expect(createdModels.length).toBe(1)
    expect(disposeSpy).toHaveBeenCalledTimes(0)
    expect(resolvedSpecs.length).toBe(1)
  })

  test('异 modelId → dispose 旧会话 + 按新 spec 重建', async () => {
    const service = makeService()
    await service.prompt('sess-switch', 'hi', () => undefined, { model: SPEC_A })
    await service.prompt('sess-switch', 'hi again', () => undefined, { model: SPEC_B })
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(createdModels.length).toBe(2)
    expect(resolvedSpecs.length).toBe(2)
    expect(resolvedSpecs[1]?.modelId).toBe('MiniMax-M3')
  })

  test("thinkingLevel 'off' ↔ 缺省 同义不重建；缺省 → 'high' 重建", async () => {
    const service = makeService()
    const withOff: ModelSpec = { ...SPEC_A, thinkingLevel: 'off' }
    await service.prompt('sess-thinking', 'hi', () => undefined, { model: withOff })
    await service.prompt('sess-thinking', 'hi again', () => undefined, { model: SPEC_A })
    expect(createdModels.length).toBe(1)
    expect(disposeSpy).toHaveBeenCalledTimes(0)
    const withHigh: ModelSpec = { ...SPEC_A, thinkingLevel: 'high' }
    await service.prompt('sess-thinking', 'third', () => undefined, { model: withHigh })
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(createdModels.length).toBe(2)
  })

  test('run 进行中改 spec → 等旧 run 收尾后才重建（不打断进行中回合）', async () => {
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
    const first = service.prompt('sess-inflight', 'hi', () => undefined, { model: SPEC_A })
    await runStarted

    const second = service.prompt('sess-inflight', 'hi again', () => undefined, {
      model: SPEC_B
    })
    // 旧 run 未收尾：驱逐必须等待——不 dispose、不重建（负断言给一拍微任务+短
    // 计时窗口；正断言在 release 后兜底，慢 CI 无假阴性）
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
    expect(disposeSpy).toHaveBeenCalledTimes(0)
    expect(createdModels.length).toBe(1)

    release()
    await first
    await second
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(createdModels.length).toBe(2)
  })
})
