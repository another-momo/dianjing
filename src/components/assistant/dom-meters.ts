/**
 * DOM 水表：周期采样 DOM 节点数，经 diagnostics 台账记「文档级 + 聊天转录
 * 子树」两笔分账——聊天 DOM 治理各项收益的前后对比仪器（文档级节点数此前
 * 只有 DevTools 手查一条路，无台账锚点）。
 *
 * 形态：document.getElementsByTagName('*') 浏览器 dev 与 Electron 渲染层同源
 * 通用；聊天转录子树不经组件内挂接——经 data-test-id="chat-messages"（聊天
 * 面板消息转录容器既有锚点）DOM 查询定位面板根，观测仪器不反向耦合被测面
 * 板。Electron 主进程可叠加 CDP Memory.getDOMCounters（webContents.debugger，
 * 文档级精确计数）作互补层，与本渲染层采样互不依赖。
 *
 * 采样纪律：60s 周期采样 + 变化门控（文档级相对变化 ≥5%、转录子树 ≥10%
 * 才记事件，子树基数小故抬高阈值降噪）+ 5min 心跳（无变化也强制记一笔，
 * 保底证明仪表存活）。tick 内一切异常吞掉——观测永不打断应用。
 *
 * 结构：createDomMeter 纯状态机（采样/时钟/记录全注入，测试直钉）；
 * startDomMeters 只做生产接线（真实 document 采样 + setInterval），返回
 * stop 以对称清理（app 级常驻服务，随根卸载路径调用）。
 */

import { recordDiagnostic } from '@/app/diagnostics/recorder'
import { isDiagnosticsEnabled } from '@/app/diagnostics/settings'

export const DOM_METER_SAMPLE_INTERVAL_MS = 60_000
export const DOM_METER_HEARTBEAT_INTERVAL_MS = 300_000

/** 文档级变化门控：相对上次记录值变化 ≥5% 才记 */
const DOCUMENT_CHANGE_GATE = 0.05
/** 聊天转录子树变化门控：10%（子树基数小，抬高阈值降噪） */
const CHAT_CHANGE_GATE = 0.1

/** 聊天转录子树根——聊天面板消息转录容器既有锚点 */
const CHAT_TRANSCRIPT_SELECTOR = '[data-test-id="chat-messages"]'

export type DomMeterScope = 'document' | 'chat-transcript'

export type DomSampleRecord = (scope: DomMeterScope, nodes: number, delta: number | null) => void

/**
 * 变化门控判定：相对变化 ≥ gate 记一笔。previous 为 0 时无基数可言——
 * 任何非零计为变化（含从 0 涨起的首个消息子树），双方皆 0 不记。
 */
export function passedChangeGate(previous: number, current: number, gate: number): boolean {
  if (previous === 0) return current !== 0
  return Math.abs(current - previous) / previous >= gate
}

export interface DomMeterOptions {
  scope: DomMeterScope
  changeGate: number
  heartbeatMs: number
  sample: () => number
  now: () => number
  record: DomSampleRecord
}

export type DomMeter = { tick: () => void }

/**
 * 单口径采样状态机：首笔必记（delta null 基线）；此后变化达门控或心跳到期
 * （距上次记录 ≥ heartbeatMs）才记，delta 为相对上次记录值的增量。
 */
export function createDomMeter(options: DomMeterOptions): DomMeter {
  let lastRecorded: number | null = null
  let lastRecordAt = 0
  const emit = (nodes: number, at: number, delta: number | null): void => {
    lastRecorded = nodes
    lastRecordAt = at
    options.record(options.scope, nodes, delta)
  }
  return {
    tick(): void {
      const current = options.sample()
      const at = options.now()
      if (lastRecorded === null) {
        emit(current, at, null)
        return
      }
      const heartbeatDue = at - lastRecordAt >= options.heartbeatMs
      if (!heartbeatDue && !passedChangeGate(lastRecorded, current, options.changeGate)) return
      emit(current, at, current - lastRecorded)
    }
  }
}

function countNodes(root: Element | Document): number {
  return root.getElementsByTagName('*').length
}

function recordDomSample(scope: DomMeterScope, nodes: number, delta: number | null): void {
  recordDiagnostic({
    category: 'performance',
    level: 'info',
    name: 'dom.nodes.sampled',
    attributes: { scope, nodes, delta }
  })
}

/** 生产接线：无 document 环境（非渲染层运行时）no-op 化，不排定时器。 */
export function startDomMeters(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const documentMeter = createDomMeter({
    scope: 'document',
    changeGate: DOCUMENT_CHANGE_GATE,
    heartbeatMs: DOM_METER_HEARTBEAT_INTERVAL_MS,
    sample: () => countNodes(document),
    now: () => Date.now(),
    record: recordDomSample
  })
  const transcriptMeter = createDomMeter({
    scope: 'chat-transcript',
    changeGate: CHAT_CHANGE_GATE,
    heartbeatMs: DOM_METER_HEARTBEAT_INTERVAL_MS,
    sample: () => {
      const root = document.querySelector(CHAT_TRANSCRIPT_SELECTOR)
      return root ? countNodes(root) : 0
    },
    now: () => Date.now(),
    record: recordDomSample
  })
  const tick = (): void => {
    if (!isDiagnosticsEnabled()) return
    try {
      documentMeter.tick()
      transcriptMeter.tick()
    } catch {
      // 观测永不打断应用——采样异常静默吞，下个周期自愈
      // oxlint-disable-next-line open-pencil/no-silent-catch
      return undefined
    }
  }
  const timer = setInterval(tick, DOM_METER_SAMPLE_INTERVAL_MS)
  return () => {
    clearInterval(timer)
  }
}
