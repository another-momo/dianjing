/**
 * T73 钉扎：PiBackendChatTransport 的 stop 带外取消通道。
 *
 * 背景（T73-plan §1）：唯一取消通道曾是 server.ts res.on('close')——客户端
 * socket 关闭语义穿透 vite http-proxy 不可靠（curl 对照实证：客户端死后后端
 * 仍持续执行工具 25s+）。修复 = abortSignal 触发时 transport 同步 POST
 * /api/pi-chat/cancel（fire-and-forget，once，失败静默）。
 *
 * 本文件钉扎 transport 侧行为；路由侧 HTTP 往返见 chat-cancel-route.test.ts。
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { PiBackendChatTransport } from '@/app/ai/pi-backend/transport'

import { restoreFetch, stubFetch, type FetchCall } from './helpers'

afterEach(restoreFetch)

function makeTransport() {
  return new PiBackendChatTransport(
    async () => ({ sessionId: 'sess-t73', documentId: undefined }) as never
  )
}

const MESSAGES = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('PiBackendChatTransport stop 带外取消（T73）', () => {
  test('abortSignal 触发 → 恰好一次 POST /api/pi-chat/cancel 且 body 带当次 sessionId', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const controller = new AbortController()
    const transport = makeTransport()

    await transport.sendMessages({ messages: MESSAGES, abortSignal: controller.signal } as never)
    expect(calls.filter((c) => c.url.endsWith('/cancel'))).toHaveLength(0)

    controller.abort()
    await sleep(10)

    const cancels = calls.filter((c) => c.url.endsWith('/cancel'))
    expect(cancels).toHaveLength(1)
    expect(cancels[0].method).toBe('POST')
    expect(cancels[0].body).toEqual({ sessionId: 'sess-t73' })
  })

  test('无 abortSignal → 不发 cancel', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const transport = makeTransport()

    await transport.sendMessages({ messages: MESSAGES } as never)
    await sleep(10)

    expect(calls).toHaveLength(1)
    expect(calls[0].url.endsWith('/cancel')).toBe(false)
  })

  test('cancel 请求失败 → 静默吞掉（不冒 unhandled rejection）', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls, true)
    const controller = new AbortController()
    const transport = makeTransport()

    await transport.sendMessages({ messages: MESSAGES, abortSignal: controller.signal } as never)
    controller.abort()
    await sleep(10)
    // 不抛错即通过；cancel 确实尝试过
    expect(calls.filter((c) => c.url.endsWith('/cancel'))).toHaveLength(1)
  })

  test('入参信号已 aborted → 立即补发 cancel（不等新事件）', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const controller = new AbortController()
    controller.abort()
    const transport = makeTransport()

    await transport.sendMessages({ messages: MESSAGES, abortSignal: controller.signal } as never)
    await sleep(10)

    expect(calls.filter((c) => c.url.endsWith('/cancel'))).toHaveLength(1)
  })
})
