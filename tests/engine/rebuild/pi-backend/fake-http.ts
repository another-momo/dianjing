/**
 * node:http 桩：路由层 handler 测试用。
 *
 * 形态：FakeReq = EventEmitter + 必要 IncomingMessage 字段；FakeRes = 累计
 * statusCode/headers/body，无 socket 写入——handler 通过 res.writeHead/res.end
 * 触发回调时由本桩记录结果。
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'

interface FakeReqInit {
  method?: string
  url?: string
  headers?: Record<string, string>
  chunks?: Buffer[]
}

export function makeFakeReq(init: FakeReqInit = {}): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage
  // IncomingMessage 字段
  Object.defineProperty(emitter, 'method', { value: init.method ?? 'GET' })
  Object.defineProperty(emitter, 'url', { value: init.url ?? '/' })
  Object.defineProperty(emitter, 'headers', {
    value: init.headers ?? {}
  })
  // 模拟 body：若有 chunks 则同步 end 后 emit data×N + end
  // 但更简单：让 handler 直接当 chunk 一次性 push 完——push chunks 后调 emit
  const chunks = init.chunks ?? []
  queueMicrotask(() => {
    for (const chunk of chunks) emitter.emit('data', chunk)
    emitter.emit('end')
  })
  // destroyed 字段（部分 handler 会读）
  ;(emitter as { destroyed?: boolean }).destroyed = false
  return emitter
}

interface FakeRes extends ServerResponse {
  statusCode: number | undefined
  body: string
}

export function makeFakeRes(): FakeRes {
  const res = {
    statusCode: undefined as number | undefined,
    body: '',
    headers: {} as Record<string, string | number | string[] | undefined>,
    _headersSent: false,
    _finished: false,
    writableEnded: false,
    on(event: string, listener: (...args: unknown[]) => void): FakeRes {
      if (event === 'finish' || event === 'error' || event === 'close') {
        // 兜底：finish/error 事件挂空 listener 即可
      }
      return this
    },
    once(event: string, listener: (...args: unknown[]) => void): FakeRes {
      return this.on(event, listener)
    },
    emit(event: string, ...args: unknown[]): boolean {
      return true
    },
    removeListener(): FakeRes {
      return this
    },
    setHeader(name: string, value: string | number | string[]): void {
      this.headers[name] = value
    },
    getHeader(name: string): string | number | string[] | undefined {
      return this.headers[name]
    },
    hasHeader(name: string): boolean {
      return name in this.headers
    },
    removeHeader(name: string): void {
      delete this.headers[name]
    },
    writeHead(statusCode: number, headers?: Record<string, string | number | string[]>): void {
      this.statusCode = statusCode
      this._headersSent = true
      if (headers) Object.assign(this.headers, headers)
    },
    write(chunk: string | Buffer | Uint8Array): boolean {
      this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    },
    end(chunk?: string | Buffer | Uint8Array): void {
      if (chunk !== undefined) {
        this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      }
      this._finished = true
      this.writableEnded = true
    },
    destroy(): void {
      this._finished = true
    },
    pipe<T extends Readable>(): T {
      return this as unknown as T
    }
  }
  return res as unknown as FakeRes
}
