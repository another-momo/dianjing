/**
 * 2026-09-27 sl-w2-locus-gate：run 期施工页追踪器（§7.3 感知三件套的数据源）。
 *
 * 设计取舍：run 起始在 pi-backend/service.ts:441-466 把 pageId 钉死进闭包
 * （修法 C），桥侧改写按冻结值走——但这是后端事，前端没有该冻结值的直接
 * 通道。后端若要透出 pageId 需在信封外层加字段，本单先按「run 起始时刻捕获
 * 视图页」的代理实现——冻结语义对用户而言等同「我点发送时所在的那页」，
 * UI 表现一致；run 结束后清空。
 *
 * 暴露单一 reactive：`runStartedPageId`（null = run 不在途；string = 起始时刻
 * 捕获的页面 id）。
 *
 * 接线方式：ChatPanel 调 `bindRunPageTracking(chatRef)`，内部 watch chat.status：
 *  - ready → submitted/streaming：捕获 currentPageId 写 ref（run 起始）
 *  - submitted/streaming → ready：清空（run 收尾）
 *  - 其他：保持现状（防多触发）
 */

import { ref, watch, type Ref } from 'vue'

import { setRunActive, setRunStartedPageId } from './locus-state'

type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

interface ChatLike {
  status: ChatStatus
}

interface RunPageTracking {
  /** 起始时刻捕获的 pageId；null = 无在途 run。 */
  runStartedPageId: Ref<string | null>
  /** 单测钩子：手动清空（开关切走等场景）。 */
  reset(): void
}

export function bindRunPageTracking(args: {
  chat: Ref<ChatLike | null>
  /** 起始捕获调用：返回当前视图页 id；返回 null 时不更新（防图替换空窗）。 */
  resolveStartPageId: () => string | null
  /**
   * 「跟随施工页」开关 on 时，run 起始会自动切视图到持久化的 engagedPageId
   * （若已设且 ≠ 当前视图）。调用方传偏好读路径（preferences/store）即可——
   * 不 import 偏好模块，保持本模块对偏好层零依赖（便于单测）。
   */
  isFollowLocusEnabled?: () => boolean
  /**
   * 已设的 engagedPageId 读取路径（locus-state 全局 ref）。本模块不直接
   * 读 ref，传 ref 让内部走同步 get value。
   */
  getEngagedPageId?: () => string | null
  /** 切换视图回调（follow 开启且 engagedPageId 非空且 ≠ 当前时调用）。 */
  switchToPage?: (pageId: string) => void
}): RunPageTracking {
  const runStartedPageId = ref<string | null>(null)

  // flush: 'sync' 让状态机变化立即反映到 ref——徽标 / 状态行显示实时性
  // 高于常规 'pre' flush 的微秒级收益，且该 ref 只在 ChatPanel 顶层订阅，
  // 不进入渲染密集路径。
  watch(
    () => args.chat.value?.status ?? 'ready',
    (next, prev) => {
      const wasInFlight = prev === 'submitted' || prev === 'streaming'
      const isInFlight = next === 'submitted' || next === 'streaming'
      if (!wasInFlight && isInFlight) {
        // ready → submitted/streaming：run 起始——捕获视图页。
        // 「跟随施工页」开关 on + 已设 engagedPageId ≠ 当前 → 先切视图
        // 再捕获（让捕获 = 已切到的施工页）。follow off / engaged 未设
        // → 捕获 = 当前视图（默认路径）。
        const follow = args.isFollowLocusEnabled?.() ?? false
        const engaged = args.getEngagedPageId?.() ?? null
        const viewId = args.resolveStartPageId()
        let captured = viewId
        if (
          follow &&
          engaged !== null &&
          engaged !== '' &&
          engaged !== viewId &&
          args.switchToPage
        ) {
          args.switchToPage(engaged)
          captured = engaged
        }
        runStartedPageId.value = captured
        setRunStartedPageId(captured)
        setRunActive(true)
      } else if (wasInFlight && next === 'ready') {
        // submitted/streaming → ready：run 收尾——清空。
        runStartedPageId.value = null
        setRunStartedPageId(null)
        setRunActive(false)
      }
      // 其他过渡（ready → error / error → ready / 同状态）保持现状——
      // T94 实证 stop 触发的 status='error' 不能误清（否则呼吸徽标先于
      // 重试真实收尾消失），且 submitted → streaming 不应重捕（同一 run）。
    },
    { flush: 'sync', immediate: true }
  )

  function reset(): void {
    runStartedPageId.value = null
    setRunStartedPageId(null)
    setRunActive(false)
  }

  return { runStartedPageId, reset }
}
