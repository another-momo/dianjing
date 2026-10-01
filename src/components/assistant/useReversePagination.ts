/**
 * 反向分页（chat-dom-governance 批 B）：消息列表只挂最近 N 回合 + 滚顶加载 +
 * scrollTop 补偿——长会话聊天转录子树 DOM 节点封顶为常数（N 回合窗口 + 当前回合，
 * 当前回合恒为窗口末尾）。craft TURNS_PER_PAGE=20 先例；HuLa scrollTop 差值补偿
 * 移植（我方同步切片形态：历史全在前端内存，loadMore 非异步取数而是数组前扩）。
 *
 * 回合定义（与 pi-backend transport trimToLastUserSuffix 同口径锚 user）：
 * user 消息起新回合，一条 user + 其后 assistant 消息为一个回合；首条 user 之前的
 * 孤儿批（无 user 锚）自成前置回合——不丢历史，trimToLastUserSuffix「无 user 原样
 * 返回」的兜底同构（整体一回合）。
 *
 * 补偿时序（≠HuLa 的 await 取数形态）：变更前量 scrollHeight/scrollTop → 窗口数组
 * 前扩 → nextTick（Vue flush 落定后）按高度差回写 scrollTop = oldTop + (newHeight -
 * oldHeight)。浏览器自动锚定（overflow-anchor 默认开启）与手动补偿会叠加跳 2× 高度，
 * 滚动容器须 overflow-anchor:none（ChatPanel viewport 侧设置）。
 *
 * 结构（dom-meters.ts 同款「纯状态机 + 薄接线」）：sliceTurns / advanceWindow /
 * shouldTriggerLoadMore / computeCompensatedScrollTop / createReversePaginationCore
 * 全纯可注入（bun 测试直钉）；useReversePagination 只做 Vue 接线（computed 切窗 +
 * scroll 监听 + 会话复位 watch）。LOAD_MORE 全程经 autoFollowSuspended 抑制
 * useScrollFollowing 的自动贴底——prepend 不得触发跟随，滚顶回看不拽视图。
 */

import type { UIMessage } from 'ai'
import { computed, nextTick, ref, watch, type Ref } from 'vue'

/** 窗口回合数（craft TURNS_PER_PAGE=20 先例） */
export const TURNS_PER_PAGE = 20

/** 滚顶触发阈值：scrollTop 低于该值触发 loadMore（HuLa 同款） */
export const LOAD_MORE_TRIGGER_PX = 60

/** 贴底容差（与 useScrollFollowing BOTTOM_THRESHOLD_PX 同口径） */
const BOTTOM_TOLERANCE_PX = 1

/** 可写响应式 cell——生产传 Vue ref，纯逻辑测试传普通对象 */
export interface MutableCell<T> {
  value: T
}

/**
 * 回合切片：user 消息起新回合，user + 其后 assistant 为一回合。user 锚对不齐的
 * 边界：尾批 assistant 挂入其前最近 user 的回合（regenerate 后的纯 assistant 尾批
 * 不散组）；首条 user 之前的孤儿批自成前置回合（无锚不丢历史）。
 */
export function sliceTurns(messages: readonly UIMessage[]): UIMessage[][] {
  const turns: UIMessage[][] = []
  let current: UIMessage[] | null = null
  for (const message of messages) {
    if (message.role === 'user' || current === null) {
      current = [message]
      turns.push(current)
      continue
    }
    current.push(message)
  }
  return turns
}

/**
 * 窗口推进：返回新的放行回合数（一次扩一页、封顶回合总数）；已全覆盖（isLast）
 * 返回 null——调用方以此短路，不得重复前扩。
 */
export function advanceWindow(
  totalTurns: number,
  windowTurnCount: number,
  pageSize: number
): number | null {
  if (totalTurns <= windowTurnCount) return null
  return Math.min(windowTurnCount + pageSize, totalTurns)
}

/** 滚动容器几何量测 */
export interface ScrollGeometry {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/** 贴底判定（与 useScrollFollowing 同容差）——贴底态禁触发 LOAD_MORE */
export function isScrolledToBottom(geometry: ScrollGeometry): boolean {
  return geometry.scrollTop + geometry.clientHeight >= geometry.scrollHeight - BOTTOM_TOLERANCE_PX
}

/**
 * 滚顶触发门（HuLa scrollTop<60 阈值 + 我方补两道护栏）：
 *  - 不可滚（内容未溢出视口）不触发——无滚顶路径，禁自动装载全量历史；
 *  - 贴底不触发——流式跟随期的 scrollTop 写入（贴底）与「回看意图」区分，
 *    防止 barely-overflow 场景贴底跟随被误判为滚顶。
 */
export function shouldTriggerLoadMore(
  state: ScrollGeometry & {
    hasMore: boolean
    isLoadingMore: boolean
  }
): boolean {
  if (!state.hasMore || state.isLoadingMore) return false
  if (state.scrollHeight <= state.clientHeight) return false
  if (isScrolledToBottom(state)) return false
  return state.scrollTop < LOAD_MORE_TRIGGER_PX
}

/** 补偿换算：prepend 前后测量 → 回写 scrollTop（视觉位置不动） */
export function computeCompensatedScrollTop(
  before: Pick<ScrollGeometry, 'scrollTop' | 'scrollHeight'>,
  after: Pick<ScrollGeometry, 'scrollHeight'>
): number {
  return before.scrollTop + (after.scrollHeight - before.scrollHeight)
}

export interface ReversePaginationPorts {
  /** 窗口放行回合数（响应式 cell——接线层传 Vue ref 驱动 computed 切窗） */
  windowTurnCount: MutableCell<number>
  /** 回合总数 getter（接线层传 turns computed） */
  totalTurns: () => number
  /** 滚动容器几何量测；返回 null（无容器）时不触发、不补偿 */
  measure?: () => ScrollGeometry | null
  /** scrollTop 回写 */
  applyScrollTop?: (value: number) => void
  /** DOM 更新 flush 等待——补偿时序前提，生产必须传 Vue nextTick */
  flush: () => Promise<void>
  /** LOAD_MORE 全程抑制自动贴底跟随（接线 useScrollFollowing 抑制闸） */
  setAutoFollowSuspended?: (suspended: boolean) => void
  /** 页大小（默认 TURNS_PER_PAGE；测试注入小页量验推进） */
  pageSize?: number
}

export interface ReversePaginationCore {
  readonly hasMore: boolean
  readonly isLast: boolean
  readonly isLoadingMore: boolean
  /** 滚动事件触发口：全量触发门（阈值/贴底/防重入/isLast）内聚于此 */
  maybeLoadMore(): Promise<void>
  /** 显式加载（绕过滚顶触发门，仍受防重入锁与 isLast 约束） */
  loadMore(): Promise<void>
  /** 切会话/新会话复位窗口；在途补偿作废（陈旧 flush 不回写） */
  reset(): void
}

/**
 * 分页状态机（无 Vue 依赖）。三重防重入：①isLoadingMore 锁（在途拒绝再入）；
 * ②isLast 短路（窗口已全覆盖）；③窗口前扩与 flush 落定之间的窗口期拒绝再触
 * （锁在同步前扩前置位、补偿回写后清除——sentinel/滚动事件在 DOM 稳定前的连发
 * 全部命中锁）。
 */
export function createReversePaginationCore(ports: ReversePaginationPorts): ReversePaginationCore {
  const pageSize = ports.pageSize ?? TURNS_PER_PAGE
  let loadingMore = false
  /** 复位代际——reset 后在途 flush 的补偿回写作废 */
  let generation = 0

  const core: ReversePaginationCore = {
    get hasMore(): boolean {
      return ports.totalTurns() > ports.windowTurnCount.value
    },
    get isLast(): boolean {
      return ports.totalTurns() <= ports.windowTurnCount.value
    },
    get isLoadingMore(): boolean {
      return loadingMore
    },
    async maybeLoadMore(): Promise<void> {
      const geometry = ports.measure?.() ?? null
      if (!geometry) return
      if (
        !shouldTriggerLoadMore({
          ...geometry,
          hasMore: core.hasMore,
          isLoadingMore: loadingMore
        })
      ) {
        return
      }
      await core.loadMore()
    },
    async loadMore(): Promise<void> {
      // 防重入①：在途拒绝
      if (loadingMore) return
      // 防重入②：isLast（已全覆盖）短路
      const next = advanceWindow(ports.totalTurns(), ports.windowTurnCount.value, pageSize)
      if (next === null) return
      // 补偿量测在前——窗口数组前扩会改 scrollHeight，before 必须取变更前值
      const before = ports.measure?.() ?? null
      const gen = generation
      ports.windowTurnCount.value = next
      // 防重入③：窗口已扩、flush 未落定的窗口期置锁——滚动事件/sentinel 连发全拒
      loadingMore = true
      ports.setAutoFollowSuspended?.(true)
      try {
        await ports.flush()
        if (gen !== generation) return
        const after = ports.measure?.() ?? null
        if (before && after) {
          ports.applyScrollTop?.(computeCompensatedScrollTop(before, after))
        }
      } finally {
        if (gen === generation) {
          loadingMore = false
          ports.setAutoFollowSuspended?.(false)
        }
      }
    },
    reset(): void {
      generation += 1
      loadingMore = false
      ports.windowTurnCount.value = pageSize
      ports.setAutoFollowSuspended?.(false)
    }
  }
  return core
}

export interface UseReversePaginationOptions {
  /** 全量消息（生产传 Chat messages computed） */
  messages: Ref<UIMessage[]>
  /** 滚动容器（reka ScrollAreaViewport 暴露的 viewportElement） */
  viewport: Ref<HTMLElement | undefined>
  /** 自动贴底抑制闸——LOAD_MORE 补偿期置 true（接线 useScrollFollowing 同名 option） */
  autoFollowSuspended?: Ref<boolean>
  /** 会话复位键：getter 返回值变化即复位窗口（切会话/新会话/文档切换） */
  resetKey: () => unknown
}

/**
 * Vue 接线：computed 切窗 + viewport scroll 触发监听 + 会话复位 watch。
 * 窗口是回合数组的尾切片——当前进行中回合（末回合）恒在窗内；窗口前扩只加
 * 历史，进行中流式内容增长不产生新回合、不触发 loadMore。
 */
export function useReversePagination(options: UseReversePaginationOptions) {
  const turns = computed(() => sliceTurns(options.messages.value))
  const windowTurnCount = ref<number>(TURNS_PER_PAGE)
  const core = createReversePaginationCore({
    windowTurnCount,
    totalTurns: () => turns.value.length,
    measure: () => {
      const el = options.viewport.value
      if (!el) return null
      return {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight
      }
    },
    applyScrollTop: (value) => {
      const el = options.viewport.value
      if (el) el.scrollTop = value
    },
    flush: () => nextTick(),
    setAutoFollowSuspended: (suspended) => {
      if (options.autoFollowSuspended) options.autoFollowSuspended.value = suspended
    }
  })

  const windowMessages = computed<UIMessage[]>(() => {
    const all = turns.value
    const count = windowTurnCount.value
    if (all.length <= count) return all.flat()
    return all.slice(all.length - count).flat()
  })
  const hasMore = computed(() => core.hasMore)

  // 滚顶触发——viewport 挂载/换实例随挂随听（passive，纯读不阻断滚动）
  watch(
    options.viewport,
    (el, _prev, onCleanup) => {
      if (!el) return
      const onScroll = (): void => {
        void core.maybeLoadMore()
      }
      el.addEventListener('scroll', onScroll, { passive: true })
      onCleanup(() => el.removeEventListener('scroll', onScroll))
    },
    { immediate: true }
  )

  // 切会话/新会话复位窗口（chat 实例更换 / sessionId 切换任一沿触发）
  watch(options.resetKey, () => core.reset())

  return { windowMessages, hasMore, core }
}
