/**
 * async 单例的 in-flight Promise 记忆化：并发调用共享同一次 factory 执行
 * （首个调用者的参数生效），成功永久缓存结果；失败清零允许下次调用重试——
 * 一次性抖动不得钉死成永久 rejection。
 *
 * 消费方：getCanvasKit（EditorCanvas 同 tick 挂载 scene/overlay 双 surface，
 * 无记忆化时 await 窗内必开第二个 WASM 实例——双倍堆内存 + 跨实例 embind
 * 对象传递雷区，clipboard 塑形路径因此存在静默劣化）；headless 导出的
 * ck/renderer 双层缓存同款加固。
 */
export function memoizeAsync<Args extends unknown[], T>(
  factory: (...args: Args) => Promise<T>
): (...args: Args) => Promise<T> {
  let inFlight: Promise<T> | null = null
  return (...args: Args) => {
    if (!inFlight) {
      const p = factory(...args)
      p.catch(() => {
        // 只清自己：回调与重试之间若已接了新一轮，不得误清
        if (inFlight === p) inFlight = null
      })
      inFlight = p
    }
    return inFlight
  }
}
