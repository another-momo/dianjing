/**
 * SSE 入口 rAF 合批闸钉扎（parseSSEChunkStream）。
 *
 * 背景：原形态每 SSE 帧独立 enqueue——SDK 泵同步消化，改写轮帧连发时每帧
 * 一次下游 UI 状态写入。新形态：帧到先攒内部批，下一 rAF 统一 enqueue，
 * read() await 阻塞在闸上（一帧最多放行一批）；close/cancel 路径对称清理
 * 挂起闸，close 前 flush 残余攒帧防尾帧丢失。
 *
 * 测试经 globalThis rAF 桩手动驱动闸放行（bun 无 vsync 时钟），SSE 源经
 * fetch 桩 + 可控 ReadableStream 泵逐段投放。afterEach 恢复 rAF 与 fetch
 * ——桩泄漏纪律同 helpers.ts 头注（单进程分片内污染后续文件）。
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { PiBackendChatTransport } from '@/app/ai/pi-backend/transport'

import { restoreFetch } from '../helpers'

afterEach(() => {
  restoreFetch()
  restoreRaf()
})

// ── rAF 桩：记录排程/取消，放行动作由测试手动驱动 ──

const realRaf = globalThis.requestAnimationFrame
const realCancelRaf = globalThis.cancelAnimationFrame

let rafCallbacks: Map<number, (time: number) => void>
let rafScheduleCount = 0
let rafCancelLog: number[]

function installRaf(): void {
  rafCallbacks = new Map()
  rafScheduleCount = 0
  rafCancelLog = []
  let nextId = 0
  globalThis.requestAnimationFrame = ((callback: (time: number) => void) => {
    rafScheduleCount += 1
    nextId += 1
    rafCallbacks.set(nextId, callback)
    return nextId
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafCancelLog.push(id)
    rafCallbacks.delete(id)
  }) as typeof cancelAnimationFrame
}

/** 按排程序放行最早挂起的闸回调 */
function fireNextRaf(): void {
  const entry = rafCallbacks.entries().next()
  if (entry.done) throw new Error('no pending rAF callback')
  const [id, callback] = entry.value
  rafCallbacks.delete(id)
  callback(0)
}

function restoreRaf(): void {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCancelRaf
}

// ── SSE 源泵：fetch 桩返回可控 ReadableStream ──

function installSsePump(): {
  push: (text: string) => void
  close: () => void
} {
  let pumpController: ReadableStreamDefaultController<Uint8Array> | null = null
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      pumpController = controller
    }
  })
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch
  const pump = (): ReadableStreamDefaultController<Uint8Array> => {
    if (!pumpController) throw new Error('sse pump not started')
    return pumpController
  }
  const encoder = new TextEncoder()
  return {
    push: (text) => pump().enqueue(encoder.encode(text)),
    close: () => pump().close()
  }
}

function makeTransport(): PiBackendChatTransport {
  return new PiBackendChatTransport(
    async () => ({ sessionId: 'sse-batch', documentId: undefined }) as never
  )
}

const MESSAGES = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]

function chunkId(value: unknown): string {
  return (value as { id: string }).id
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('parseSSEChunkStream rAF 合批闸', () => {
  test('同闸窗口多帧攒一批：单闸守卫只排一次 rAF，放行统一 enqueue', async () => {
    installRaf()
    const pump = installSsePump()
    const transport = makeTransport()
    const stream = await transport.sendMessages({ messages: MESSAGES } as never)
    const reader = stream.getReader()

    pump.push('data: {"type":"text-start","id":"a"}\n\ndata: {"type":"text-start","id":"b"}\n\n')

    let settled = false
    const first = reader.read().then((result) => {
      settled = true
      return result
    })
    await sleep(20)
    expect(settled).toBe(false)
    expect(rafScheduleCount).toBe(1)

    fireNextRaf()
    const r1 = await first
    expect(r1.done).toBe(false)
    expect(chunkId(r1.value)).toBe('a')
    const r2 = await reader.read()
    expect(chunkId(r2.value)).toBe('b')
    expect(rafScheduleCount).toBe(1)
  })

  test('下一闸窗口重新排程：放行后到达的新帧再攒新批', async () => {
    installRaf()
    const pump = installSsePump()
    const transport = makeTransport()
    const reader = (await transport.sendMessages({ messages: MESSAGES } as never)).getReader()

    pump.push('data: {"type":"text-start","id":"a"}\n\n')
    const first = reader.read()
    await sleep(20)
    fireNextRaf()
    expect(chunkId((await first).value)).toBe('a')

    pump.push('data: {"type":"text-start","id":"b"}\n\n')
    const second = reader.read()
    await sleep(20)
    expect(rafScheduleCount).toBe(2)
    fireNextRaf()
    expect(chunkId((await second).value)).toBe('b')
  })

  test('[DONE] 前 flush 残余攒帧（尾帧不丢），挂起闸对称取消', async () => {
    installRaf()
    const pump = installSsePump()
    const transport = makeTransport()
    const reader = (await transport.sendMessages({ messages: MESSAGES } as never)).getReader()

    pump.push('data: {"type":"text-start","id":"a"}\n\ndata: [DONE]\n\n')
    const r1 = await reader.read()
    expect(chunkId(r1.value)).toBe('a')
    const r2 = await reader.read()
    expect(r2.done).toBe(true)
    expect(rafCancelLog).toHaveLength(1)
  })

  test('源流 done（无 [DONE]）同样 flush 残余攒帧后 close', async () => {
    installRaf()
    const pump = installSsePump()
    const transport = makeTransport()
    const reader = (await transport.sendMessages({ messages: MESSAGES } as never)).getReader()

    pump.push('data: {"type":"text-start","id":"a"}\n\n')
    const first = reader.read()
    await sleep(20)
    fireNextRaf()
    expect(chunkId((await first).value)).toBe('a')

    pump.close()
    const r2 = await reader.read()
    expect(r2.done).toBe(true)
  })

  test('cancel 对称取消挂起闸并放行挂起的 pull', async () => {
    installRaf()
    const pump = installSsePump()
    const transport = makeTransport()
    const reader = (await transport.sendMessages({ messages: MESSAGES } as never)).getReader()

    pump.push('data: {"type":"text-start","id":"a"}\n\n')
    const pending = reader.read()
    const guarded = pending.then(
      () => 'resolved',
      () => 'rejected'
    )
    await sleep(20)
    expect(rafScheduleCount).toBe(1)

    await reader.cancel('user-stop')
    expect(rafCancelLog).toHaveLength(1)
    expect(await guarded).toBe('resolved')
  })

  test('坏帧跳过纪律在闸形态下不变：坏帧丢弃、好帧照常入批', async () => {
    installRaf()
    const pump = installSsePump()
    const transport = makeTransport()
    const reader = (await transport.sendMessages({ messages: MESSAGES } as never)).getReader()

    pump.push('data: not-json\n\ndata: {"type":"text-start","id":"a"}\n\n')
    const first = reader.read()
    await sleep(20)
    fireNextRaf()
    const r1 = await first
    expect(chunkId(r1.value)).toBe('a')
  })
})
