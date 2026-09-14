/**
 * 子进程就绪探针骨架——轮询 boolean 返回的异步探针，按调用方给的 timeoutMs
 * 上限等。
 *
 * 设计依据：四份编排实现里三份（pi-backend vite 插件、pi-backend host.ts、
 * Electron main）共享同源「轮询 boolean 探针」形态，仅在「超时是 throw 还是
 * warn」两点上分歧——前者（host.ts）超时即抛、后者（pi-backend/main）超时
 * 仅 warn。差异即规格：本骨架把超时行为参数化（onTimeout 回调），调用方按
 * 各自语义注入（不传 onTimeout = 纯静默返回，传 onTimeout = 自决断）。
 *
 * 边界：bridge/vite-plugin.ts 的 waitForAutomationHealth 语义差异大（每轮
 * 调 assertRunning、AbortSignal.timeout(2000)、末次 warn 等），保留原样。
 */

export interface WaitForHealthPollingOptions {
  /** boolean 返回的异步探针——返回 true 即视为就绪 */
  probe: () => Promise<boolean>
  /** 探测间隔（毫秒） */
  intervalMs: number
  /** 总超时（毫秒）；超时触发 onTimeout 行为（throw or warn——按调用方决定） */
  timeoutMs: number
  /** 「子进程是否已退出」判断——true 时立刻放弃等待（避免对死进程空转） */
  isAlive?: () => boolean
  /** 就绪回调——一次就绪即触发（用于清零崩溃计数等） */
  onReady?: () => void
  /**
   * 超时回调——调用方按各自语义决定 throw / warn。
   * 传 throw 字面抛：onTimeout() { throw new Error(...) }
   * 传 warn 字面 console.warn：不返回（void）→ 本骨架不再额外 throw
   * 不传则静默返回（与「warn」语义同）
   */
  onTimeout?: () => void
}

/**
 * 轮询就绪骨架。等同把下方内联形态抽出：
 *
 *   const deadline = Date.now() + timeoutMs
 *   while (Date.now() < deadline) {
 *     if (!isAlive()) return
 *     try { if (await probe()) { onReady?.(); return } } catch { /* 继续 *\/ }
 *     await sleep(intervalMs)
 *   }
 *   onTimeout?.()  // 由调用方决定 throw or warn
 *
 * onReady 在「成功」时同步触发——调用方自己保证 onReady 同步或只 fire-and-forget。
 * isAlive 在循环开头求值——一旦进程死掉，立刻放弃避免空轮询。
 */
export async function waitForHealthPolling(options: WaitForHealthPollingOptions): Promise<void> {
  const { probe, intervalMs, timeoutMs, isAlive, onReady, onTimeout } = options
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) return
    try {
      if (await probe()) {
        onReady?.()
        return
      }
      // 探针内连接拒绝/4xx 即「未就绪」，属预期路径——不抛
    } catch {
      // oxlint-disable-next-line open-pencil/no-silent-catch -- 轮询中的连接拒绝即「未就绪」，无需记录
      void 0
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs)
    })
  }
  onTimeout?.()
}
