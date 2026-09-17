/**
 * 2026-09-15：http-utils 413-before-destroy 钉扎。
 *
 * 背景：旧实现 readBody 超限同步 req.destroy()，parseJSONBody 写的 413 进死 socket
 * 客户端呈不透明 ECONNRESET 502。新实现 readBody 仅 reject + 后续 chunk 丢弃，
 * 由 parseJSONBody 写 413（connection: close）后挂 res.on('finish') 兜底 destroy。
 * 钉扎顺序语义：响应字节先于 socket destroy 落地。
 */
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  MAX_BODY_BYTES,
  PayloadTooLargeError,
  parseJSONBody,
  readBody
} from '@/app/ai/pi-backend/http-utils'

/** 桩 FakeReq：扩 IncomingMessage，加 destroy 计数 + 测试钩子。运行时 EventEmitter 兜底事件通道。 */
interface FakeReq extends IncomingMessage {
  pushed: { chunk: Buffer; when: number }[]
  destroyOrder: number[]
}

/** 桩 FakeRes：扩 ServerResponse，加测试钩子（statusCode/headers/body/finish 监听计数/destroy 计数）。 */
interface FakeRes extends ServerResponse {
  statusCode: number | undefined
  headers: Record<string, string | number | string[] | undefined>
  body: string
  finished: boolean
  finishListeners: number
  endOrder: number
  destroyOrder: number
}

function makeFakeReq(opts: { chunks?: Buffer[]; endAfterChunks?: boolean } = {}): FakeReq {
  // oxlint-disable-next-line unicorn/prefer-event-target, open-pencil/no-broad-double-cast -- IncomingMessage 契约基于 Node EventEmitter；测试桩必须同源接口（cast 切断 EventEmitter 原型以附加 pushed/destroyOrder 钩子）
  const emitter = new EventEmitter() as unknown as FakeReq
  emitter.pushed = []
  emitter.destroyOrder = []
  let orderCounter = 0

  emitter.destroy = (): unknown => {
    emitter.destroyOrder.push(++orderCounter)
    // no-op：fake 不真正拆 socket
    return emitter
  }

  queueMicrotask(() => {
    for (const chunk of opts.chunks ?? []) {
      emitter.pushed.push({ chunk, when: Date.now() })
      emitter.emit('data', chunk)
    }
    if (opts.endAfterChunks !== false) emitter.emit('end')
  })

  return emitter
}

function makeFakeRes(): FakeRes {
  let endCounter = 0
  let destroyCounter = 0
  // oxlint-disable-next-line unicorn/prefer-event-target, open-pencil/no-broad-double-cast -- ServerResponse 契约基于 Node EventEmitter；测试桩必须同源接口（cast 切断 EventEmitter 原型以附加 headers/body/endOrder/destroyOrder 钩子）
  const emitter = new EventEmitter() as unknown as FakeRes
  emitter.statusCode = undefined
  emitter.headers = {}
  emitter.body = ''
  emitter.finished = false
  emitter.finishListeners = 0
  emitter.endOrder = 0
  emitter.destroyOrder = 0

  emitter.writeHead = function (
    status: number,
    headers?: Record<string, string | number | string[] | undefined>
  ): FakeRes {
    emitter.statusCode = status
    if (headers) Object.assign(emitter.headers, headers)
    return emitter
  }

  emitter.end = function (chunk?: string | Buffer): FakeRes {
    if (typeof chunk === 'string') emitter.body += chunk
    else if (Buffer.isBuffer(chunk)) emitter.body += chunk.toString('utf8')
    emitter.endOrder = ++endCounter
    queueMicrotask(() => {
      emitter.finished = true
      emitter.emit('finish')
    })
    return emitter
  }

  const baseOn = emitter.on.bind(emitter)
  emitter.on = function (event: string, listener: (...args: unknown[]) => void): unknown {
    if (event === 'finish') emitter.finishListeners++
    return baseOn(event, listener)
  }

  emitter.destroy = function (): FakeRes {
    emitter.destroyOrder = ++destroyCounter
    return emitter
  }

  return emitter
}

describe('http-utils T27 顺序语义', () => {
  test('MAX_BODY_BYTES = 32MB', () => {
    expect(MAX_BODY_BYTES).toBe(32 * 1024 * 1024)
  })

  test('readBody 超限 reject 时不再同步 destroy socket（旧行为校验）', async () => {
    const req = makeFakeReq({
      chunks: [Buffer.from('a'.repeat(MAX_BODY_BYTES)), Buffer.from('overflow')]
    })
    const promise = readBody(req)
    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError)
    // 关键断言：超限 reject 时未触发 destroy——顺序语义由 parseJSONBody 接管
    expect(req.destroyOrder).toHaveLength(0)
  })

  test('PayloadTooLargeError.name 与 .message', () => {
    const err = new PayloadTooLargeError()
    expect(err.name).toBe('PayloadTooLargeError')
    expect(err.message).toBe('request body too large')
  })

  test('parseJSONBody 超限写 413 + connection: close + res.end 先于 req.destroy', async () => {
    const req = makeFakeReq({
      chunks: [Buffer.from('a'.repeat(MAX_BODY_BYTES)), Buffer.from('overflow')]
    })
    const res = makeFakeRes()
    const parsed = await parseJSONBody(req, res)

    expect(parsed).toEqual({ ok: false })
    expect(res.statusCode).toBe(413)
    expect(res.headers.connection).toBe('close')
    expect(res.body).toBe('Payload Too Large')
    expect(res.endOrder).toBe(1)
    // 关键断言：finish 回调跑完后 req.destroy 已被调用
    expect(req.destroyOrder).toHaveLength(1)
    expect(res.finishListeners).toBe(1)
  })

  test('parseJSONBody 坏 JSON（非超限）→ 400 且不 destroy socket', async () => {
    const req = makeFakeReq({ chunks: [Buffer.from('{not json')] })
    const res = makeFakeRes()
    const parsed = await parseJSONBody(req, res)

    expect(parsed).toEqual({ ok: false })
    expect(res.statusCode).toBe(400)
    expect(res.body).toBe('Bad Request: invalid JSON')
    expect(res.headers.connection).toBeUndefined()
    expect(req.destroyOrder).toHaveLength(0)
  })

  test('parseJSONBody 正常 JSON → { ok: true, body } 且不 destroy', async () => {
    const req = makeFakeReq({ chunks: [Buffer.from('{"x":1}')] })
    const res = makeFakeRes()
    const parsed = await parseJSONBody(req, res)

    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.body).toEqual({ x: 1 })
    expect(req.destroyOrder).toHaveLength(0)
    expect(res.statusCode).toBeUndefined()
  })

  test('readBody 超限 reject 后再 push chunk：吞掉，不影响已 settled 状态', async () => {
    const req = makeFakeReq({
      chunks: [
        Buffer.from('a'.repeat(MAX_BODY_BYTES)),
        Buffer.from('after-overflow-1'),
        Buffer.from('after-overflow-2')
      ]
    })
    const promise = readBody(req)
    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError)
    // 已 reject 的 promise 不会被后续 end 事件误 resolve（再 .then 应保持 rejected）
    const stillRejected = await promise.then(
      () => false,
      () => true
    )
    expect(stillRejected).toBe(true)
  })
})
