/**
 * 字体商店安装任务内存表。
 *
 * 形态：进程内常驻 Map——任务不持久化（重启即清；同 family 重装任务恢复由
 * 客户端重新触发）。短路语义：同 (serviceId, family) 有 running 任务 → 直接
 * 返既有 taskId，不并发重复跑。
 *
 * 取消：AbortController 持任务级；cancel 时 abort → fetch/转码串任务取消
 * signal 提前 reject → 任务状态记 'cancelled'，记录保留供 UI 查询历史。
 *
 * 进度：style 粒度逐片 done++；failures[] 记失败明细。
 *
 * 上限：任务表最多 200 条——满员新建前按序淘汰最老终态任务（running 不淘汰），
 * 防长会话无界增长（/tasks 响应随任务数线性膨胀）。
 */
import { randomUUID } from 'node:crypto'

export interface StoreInstallTask {
  id: string
  serviceId: string
  family: string
  total: number
  done: number
  failures: { style: string; reason: string }[]
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
}

export interface RunningTask {
  task: StoreInstallTask
  controller: AbortController
}

/** 安装任务 worker 签名（signal = 任务级取消；task = 可变进度句柄） */
export type InstallWorker = (signal: AbortSignal, task: StoreInstallTask) => Promise<void>

/** 同刻 running 安装任务上限——单任务占内存随族样式数线性，防滥用塞爆 */
export const MAX_RUNNING_INSTALL_TASKS = 8

export class StoreTaskRegistry {
  private readonly tasks = new Map<string, RunningTask>()
  /** 新→旧（unshift 头插；尾部 = 最老） */
  private readonly order: string[] = []

  /** 任务表上限——满员新建前淘汰最老终态任务 */
  static readonly MAX_TASKS = 200

  /**
   * 同 (serviceId, family) 有 running 任务 → 短路返回既有任务；否则新建并
   * 异步跑 worker。短路时短路标记 = true（与新建区分）。
   */
  start(args: {
    serviceId: string
    family: string
    total: number
    worker: (signal: AbortSignal, task: StoreInstallTask) => Promise<void>
  }): { task: StoreInstallTask; shortCircuited: boolean } {
    for (const existing of this.tasks.values()) {
      const t = existing.task
      if (t.serviceId === args.serviceId && t.family === args.family && t.status === 'running') {
        return { task: t, shortCircuited: true }
      }
    }
    const task: StoreInstallTask = {
      id: randomUUID(),
      serviceId: args.serviceId,
      family: args.family,
      total: args.total,
      done: 0,
      failures: [],
      status: 'running',
      startedAt: Date.now()
    }
    this.evictOldestFinished()
    const controller = new AbortController()
    this.tasks.set(task.id, { task, controller })
    this.order.unshift(task.id)
    void this.runWorker(task.id, args.worker, controller.signal)
    return { task, shortCircuited: false }
  }

  list(): StoreInstallTask[] {
    const out: StoreInstallTask[] = []
    for (const id of this.order) {
      const entry = this.tasks.get(id)
      if (entry) out.push(entry.task)
    }
    return out
  }

  get(id: string): StoreInstallTask | undefined {
    return this.tasks.get(id)?.task
  }

  cancel(id: string): boolean {
    const entry = this.tasks.get(id)
    if (!entry) return false
    if (entry.task.status !== 'running') return false
    entry.controller.abort()
    return true
  }

  /** running 任务计数（并发上限判定用） */
  countRunning(): number {
    let n = 0
    for (const entry of this.tasks.values()) {
      if (entry.task.status === 'running') n++
    }
    return n
  }

  /** 满员时从最老往回淘汰终态任务；running 永不淘汰（极端全 running 时允许超限） */
  private evictOldestFinished(): void {
    if (this.tasks.size < StoreTaskRegistry.MAX_TASKS) return
    for (
      let i = this.order.length - 1;
      i >= 0 && this.tasks.size >= StoreTaskRegistry.MAX_TASKS;
      i--
    ) {
      const id = this.order[i]
      const entry = this.tasks.get(id)
      if (entry && entry.task.status !== 'running') {
        this.tasks.delete(id)
        this.order.splice(i, 1)
      }
    }
  }

  private async runWorker(
    id: string,
    worker: (signal: AbortSignal, task: StoreInstallTask) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    const entry = this.tasks.get(id)
    if (!entry) return
    try {
      await worker(signal, entry.task)
      // worker 正常返回：基于信号 + 失败统计决定状态
      if (entry.task.status === 'running') {
        if (signal.aborted) {
          entry.task.status = 'cancelled'
        } else if (entry.task.failures.length === entry.task.total && entry.task.total > 0) {
          entry.task.status = 'failed'
        } else {
          entry.task.status = 'done'
        }
      }
    } catch (error) {
      if (signal.aborted) {
        entry.task.status = 'cancelled'
      } else {
        entry.task.status = 'failed'
        entry.task.failures.push({
          style: '*',
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      entry.task.finishedAt = Date.now()
    }
  }
}
