/**
 * 字体商店通用流式拉取 / abort 组合 helper。
 *
 * 抽离自 store-routes.ts 以控制行数 + 解 cn-install 模块对 store-routes 的
 * 直接依赖（避免环向）；owner 指令：单文件 ≤ 600 行。
 */

import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'

export type FetchStyleResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string }

/** 组合两条 abort 信号（任务级 + 端点级超时）；任一触发即中止。
 * reason 透传：先触发者（a 优先于 b）把 AbortSignal.reason 透到 controller，
 * 上层 catch 能拿到原错误（如超时 throw new Error('style fetch timeout')）。 */
export function composeSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a
  if (a.aborted) return a
  if (b.aborted) return b
  const controller = new AbortController()
  const onAbort = () => controller.abort(a.aborted ? a.reason : b.reason)
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return controller.signal
}

/** signal 是否被触发——含 child 节点任意路径 abort。 */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * 流式 fetch：上限 + 超时 + 取消；返回字节或错误（不抛）。
 * `maxBytes` 触发即拒（不读尾部）；`timeoutMs` 触发 controller.abort。
 */
export async function fetchStyleBytes(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
  timeoutMs: number
): Promise<FetchStyleResult> {
  if (signal.aborted) return { ok: false, error: 'cancelled' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('style fetch timeout')), timeoutMs)
  const composed = composeSignals(signal, controller.signal)
  try {
    const response = await fetch(url, { signal: composed })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    if (!response.body) return { ok: false, error: 'no body' }
    const chunks: Buffer[] = []
    let total = 0
    const nodeStream = Readable.fromWeb(toNodeWebStream(response.body))
    for await (const chunk of nodeStream) {
      const buf = chunk as Buffer
      total += buf.length
      if (total > maxBytes) {
        controller.abort(new Error('too large'))
        return { ok: false, error: `body exceeds ${maxBytes} bytes` }
      }
      chunks.push(buf)
    }
    return { ok: true, bytes: new Uint8Array(Buffer.concat(chunks)) }
  } catch (error) {
    if (isAborted(signal)) return { ok: false, error: 'cancelled' }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * fetch Response.body → node:stream/web ReadableStream。两侧类型声明不同源
 * （undici/fetch 全局 vs node:stream/web），运行时是同一对象，单 cast 桥接。
 */
function toNodeWebStream(body: unknown): NodeWebReadableStream<Uint8Array> {
  return body as NodeWebReadableStream<Uint8Array>
}
