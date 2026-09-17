/**
 * transport 测试共享 fetch 桩：记录请求（url/method/解析后 body）、
 * SSE 挂起响应（sendMessages 拿到 body 即返回，流不消费）、/cancel 分支
 * （204 / cancelFails 时抛错）。
 *
 * 还原纪律：消费文件必须在自身模块顶层 `afterEach(restoreFetch)`——
 * 本模块的模块级 afterEach 只挂在首个 import 者的文件作用域（bun 模块缓存
 * 致第二消费者不再执行模块体），曾在 CI 单进程分片内泄漏 hanging-SSE 桩
 * 全程污染后续文件的一切 fetch（2026-09-17 app shard 40 红实证）。
 */

export interface FetchCall {
  url: string
  method: string | undefined
  body: unknown
}

const realFetch = globalThis.fetch

/** 还原 globalThis.fetch——每个消费文件各自注册 afterEach 调用（见头注）。 */
export function restoreFetch(): void {
  globalThis.fetch = realFetch
}

/** 挂起永不结束的 SSE 响应（sendMessages 拿到 body 即返回，不消费） */
function hangingSSEResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {
        /* 永不 enqueue——模拟进行中的 SSE 流 */
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

export function stubFetch(calls: FetchCall[], cancelFails = false): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url)
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null
    })
    if (url.endsWith('/cancel')) {
      if (cancelFails) throw new Error('network down')
      return new Response(null, { status: 204 })
    }
    return hangingSSEResponse()
  }) as typeof fetch
}
