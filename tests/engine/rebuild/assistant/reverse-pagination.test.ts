/**
 * 反向分页钉扎（src/components/assistant/useReversePagination.ts）。
 *
 * 覆盖：回合切片（user 锚 + assistant 尾批/孤儿批边界）、窗口推进与 isLast、
 * 滚顶触发门（阈值/贴底/不可滚/防重入/isLast 矩阵）、补偿换算、createReversePaginationCore
 * 状态机（手动 flush 驱动补偿时序：量测→前扩→flush→回写；迟到内容高度追踪的
 * 增量续补与代际守卫）、useReversePagination Vue 接线（computed 切窗 / scroll 触发 /
 * 会话复位 / 进行中回合恒在场）、useScrollFollowing 抑制闸（LOAD_MORE 期间内容增长不贴底）。
 *
 * 测试栈纪律与 use-scroll-following.test.ts 同款：不引入 happy-dom——合成容器
 * （FakeElement 捕获监听器）+ 运行期全局桩（rAF 手动队列 / FakeResizeObserver），
 * 模块求值序无关。生产 DOM 侧（reka viewport 真实几何、overflow-anchor 样式）
 * 不在 bun 环境覆盖——由 L3 实测兜底。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import type { UIMessage } from 'ai'
import { effectScope, markRaw, nextTick, ref, type EffectScope, type Ref } from 'vue'

import {
  LOAD_MORE_TRIGGER_PX,
  TURNS_PER_PAGE,
  advanceWindow,
  computeCompensatedScrollTop,
  createReversePaginationCore,
  isScrolledToBottom,
  shouldTriggerLoadMore,
  sliceTurns,
  useReversePagination,
  type ReversePaginationPorts
} from '@/components/assistant/useReversePagination'
import { useScrollFollowing } from '@/components/assistant/useScrollFollowing'

function msg(role: 'user' | 'assistant', id: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text: `${role}:${id}` }] }
}

/** 造 count 个回合（user+assistant 成对），序号从 startIndex 起 */
function turns(count: number, startIndex = 0): UIMessage[] {
  const out: UIMessage[] = []
  for (let i = 0; i < count; i++) {
    const n = startIndex + i
    out.push(msg('user', `u${n}`), msg('assistant', `a${n}`))
  }
  return out
}

describe('sliceTurns 回合切片', () => {
  test('user 起新回合：一条 user + 其后 assistant 为一回合', () => {
    const sliced = sliceTurns([
      msg('user', 'u1'),
      msg('assistant', 'a1a'),
      msg('assistant', 'a1b'),
      msg('user', 'u2'),
      msg('assistant', 'a2')
    ])
    expect(sliced.map((turn) => turn.map((m) => m.id))).toEqual([
      ['u1', 'a1a', 'a1b'],
      ['u2', 'a2']
    ])
  })

  test('user 锚对不齐的 assistant 尾批：挂入其前最近 user 的回合，不散组', () => {
    const sliced = sliceTurns([
      msg('user', 'u1'),
      msg('assistant', 'a1a'),
      msg('assistant', 'a1b'),
      msg('assistant', 'a1c')
    ])
    expect(sliced.map((turn) => turn.map((m) => m.id))).toEqual([['u1', 'a1a', 'a1b', 'a1c']])
  })

  test('连续 user 消息各起新回合（单 user 无 assistant 的回合合法）', () => {
    const sliced = sliceTurns([msg('user', 'u1'), msg('user', 'u2'), msg('assistant', 'a2')])
    expect(sliced.map((turn) => turn.map((m) => m.id))).toEqual([['u1'], ['u2', 'a2']])
  })

  test('首条 user 之前的孤儿批自成前置回合（无锚不丢历史）', () => {
    const sliced = sliceTurns([msg('assistant', 'a0'), msg('user', 'u1'), msg('assistant', 'a1')])
    expect(sliced.map((turn) => turn.map((m) => m.id))).toEqual([['a0'], ['u1', 'a1']])
  })

  test('无 user 兜底：整体一回合（trimToLastUserSuffix「无 user 原样返回」同构）', () => {
    const sliced = sliceTurns([msg('assistant', 'a1'), msg('assistant', 'a2')])
    expect(sliced.map((turn) => turn.map((m) => m.id))).toEqual([['a1', 'a2']])
  })

  test('空数组 → 零回合', () => {
    expect(sliceTurns([])).toEqual([])
  })
})

describe('advanceWindow 窗口推进', () => {
  test('一次扩一页（40/20/20 → 40，100/20/20 → 40）', () => {
    expect(advanceWindow(40, 20, 20)).toBe(40)
    expect(advanceWindow(100, 20, 20)).toBe(40)
  })

  test('剩余不足一页取整（30/20/20 → 30）', () => {
    expect(advanceWindow(30, 20, 20)).toBe(30)
  })

  test('已全覆盖（isLast）返回 null：总数 ≤ 放行数', () => {
    expect(advanceWindow(20, 20, 20)).toBeNull()
    expect(advanceWindow(10, 20, 20)).toBeNull()
  })
})

describe('滚顶触发门', () => {
  const base = { scrollTop: 0, clientHeight: 200, scrollHeight: 1000 }

  test('阈值边界：scrollTop < 60 触发，≥ 60 不触发', () => {
    expect(
      shouldTriggerLoadMore({
        ...base,
        scrollTop: LOAD_MORE_TRIGGER_PX - 1,
        hasMore: true,
        isLoadingMore: false
      })
    ).toBe(true)
    expect(
      shouldTriggerLoadMore({
        ...base,
        scrollTop: LOAD_MORE_TRIGGER_PX,
        hasMore: true,
        isLoadingMore: false
      })
    ).toBe(false)
  })

  test('isLast（hasMore=false）不触发——≤N 不分页', () => {
    expect(shouldTriggerLoadMore({ ...base, hasMore: false, isLoadingMore: false })).toBe(false)
  })

  test('加载中（防重入）不触发', () => {
    expect(shouldTriggerLoadMore({ ...base, hasMore: true, isLoadingMore: true })).toBe(false)
  })

  test('内容未溢出视口不触发（无滚顶路径，禁自动装载全量）', () => {
    expect(
      shouldTriggerLoadMore({ ...base, scrollHeight: 200, hasMore: true, isLoadingMore: false })
    ).toBe(false)
  })

  test('贴底不触发（区分流式跟随的 scrollTop 写入与回看意图）', () => {
    expect(
      shouldTriggerLoadMore({ ...base, scrollTop: 800, hasMore: true, isLoadingMore: false })
    ).toBe(false)
  })

  test('贴底判定容差：差值 ≤1px 视为贴底', () => {
    expect(isScrolledToBottom({ scrollTop: 799, clientHeight: 200, scrollHeight: 1000 })).toBe(true)
    expect(isScrolledToBottom({ scrollTop: 798, clientHeight: 200, scrollHeight: 1000 })).toBe(
      false
    )
  })
})

describe('computeCompensatedScrollTop 补偿换算', () => {
  test('回写值 = oldTop + 高度差（prepend 场景视觉位置不动）', () => {
    expect(
      computeCompensatedScrollTop({ scrollTop: 50, scrollHeight: 1000 }, { scrollHeight: 3000 })
    ).toBe(2050)
  })

  test('高度零变化 → 原位回写', () => {
    expect(
      computeCompensatedScrollTop({ scrollTop: 50, scrollHeight: 1000 }, { scrollHeight: 1000 })
    ).toBe(50)
  })
})

type FakeHandler = (event: Record<string, unknown>) => void

class FakeElement {
  private handlers = new Map<string, Set<FakeHandler>>()
  scrollTop = 0

  constructor(
    public scrollHeight = 1000,
    public clientHeight = 200
  ) {}

  addEventListener(type: string, handler: FakeHandler): void {
    const set = this.handlers.get(type) ?? new Set<FakeHandler>()
    set.add(handler)
    this.handlers.set(type, set)
  }

  removeEventListener(type: string, handler: FakeHandler): void {
    this.handlers.get(type)?.delete(handler)
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of this.handlers.get(type) ?? []) {
      handler({ target: this, ...event })
    }
  }
}

function asElement(el: FakeElement): HTMLElement {
  // oxlint-disable-next-line open-pencil/no-broad-double-cast -- 桩与真实 DOM 的结构差由 hook 的窄使用面兜住（use-scroll-following.test.ts 同款先例）
  return el as unknown as HTMLElement
}

describe('createReversePaginationCore 状态机', () => {
  function makeHarness(options: {
    totalTurns: number
    scrollHeight?: number
    scrollTop?: number
    pageSize?: number
    withLateGrowth?: boolean
  }) {
    const windowTurnCount = { value: TURNS_PER_PAGE }
    let total = options.totalTurns
    const viewportEl = markRaw(new FakeElement(options.scrollHeight ?? 1000, 200))
    viewportEl.scrollTop = options.scrollTop ?? 0
    const suspensionLog: boolean[] = []
    const applied: number[] = []
    const flushQueue: Array<() => void> = []
    /** 迟到高度追踪捕获：onGrowth 手动放量、release 收束追踪（生产 = rAF 逐帧轮询） */
    const lateGrowthCalls: Array<{
      onGrowth: (delta: number) => void
      isStale: () => boolean
      release: () => void
    }> = []
    const ports: ReversePaginationPorts = {
      windowTurnCount,
      totalTurns: () => total,
      measure: () => ({
        scrollTop: viewportEl.scrollTop,
        clientHeight: viewportEl.clientHeight,
        scrollHeight: viewportEl.scrollHeight
      }),
      applyScrollTop: (value) => {
        applied.push(value)
        viewportEl.scrollTop = value
      },
      flush: () =>
        new Promise<void>((resolve) => {
          flushQueue.push(resolve)
        }),
      setAutoFollowSuspended: (suspended) => suspensionLog.push(suspended)
    }
    if (options.withLateGrowth) {
      ports.trackLateGrowth = (onGrowth, isStale) =>
        new Promise<void>((resolve) => {
          lateGrowthCalls.push({ onGrowth, isStale, release: resolve })
        })
    }
    if (options.pageSize !== undefined) ports.pageSize = options.pageSize
    const core = createReversePaginationCore(ports)
    return {
      core,
      windowTurnCount,
      viewportEl,
      applied,
      suspensionLog,
      lateGrowthCalls,
      setTotal: (value: number) => {
        total = value
      },
      /** 放行全部在途 flush 并消化补偿回写续体 */
      async settle(): Promise<void> {
        const pending = flushQueue.splice(0)
        for (const release of pending) release()
        await Promise.resolve()
        await Promise.resolve()
      },
      /** 只放行最早一个在途 flush（交错代际时序：旧 flush 落定而新 flush 仍在途） */
      async settleOldest(): Promise<void> {
        flushQueue.shift()?.()
        await Promise.resolve()
        await Promise.resolve()
      }
    }
  }

  test('初始窗口 = 20 回合；滚顶触发全序列：量测→前扩→flush→补偿回写→解锁', async () => {
    const h = makeHarness({ totalTurns: 45, scrollTop: 50 })
    expect(h.windowTurnCount.value).toBe(TURNS_PER_PAGE)
    expect(h.core.hasMore).toBe(true)

    const pending = h.core.maybeLoadMore()
    // 前扩同步落（窗口期锁已置位、跟随抑制已开）
    expect(h.windowTurnCount.value).toBe(40)
    expect(h.core.isLoadingMore).toBe(true)
    expect(h.suspensionLog).toEqual([true])
    // flush 落定前 DOM 长高（Vue flush 后可测到新高度）
    h.viewportEl.scrollHeight = 3000
    await h.settle()
    await pending
    expect(h.applied).toEqual([2050])
    expect(h.viewportEl.scrollTop).toBe(2050)
    expect(h.core.isLoadingMore).toBe(false)
    expect(h.suspensionLog).toEqual([true, false])
  })

  test('防重入：在途（flush 未落定）再触发命中锁，只前扩一次只回写一次', async () => {
    const h = makeHarness({ totalTurns: 45, scrollTop: 50 })
    const first = h.core.maybeLoadMore()
    expect(h.windowTurnCount.value).toBe(40)
    const second = h.core.maybeLoadMore()
    h.viewportEl.scrollHeight = 3000
    await h.settle()
    await Promise.all([first, second])
    expect(h.windowTurnCount.value).toBe(40)
    expect(h.applied).toEqual([2050])
  })

  test('isLast 短路：窗口已全覆盖不量测不前扩', async () => {
    const h = makeHarness({ totalTurns: 20, scrollTop: 50 })
    await h.core.maybeLoadMore()
    expect(h.windowTurnCount.value).toBe(20)
    expect(h.applied).toEqual([])
    expect(h.suspensionLog).toEqual([])
  })

  test('逐页推进至 isLast：显式 loadMore 绕过触发门但受锁与 isLast 约束', async () => {
    const h = makeHarness({ totalTurns: 100, pageSize: 20 })
    for (let expected = 40; expected <= 100; expected += 20) {
      // loadMore 的 flush 等待须先放行（settle）再 await——直接 await 会与手动
      // flush promise 互等死锁（flush 落定前 loadMore 的 promise 不 resolve）
      const pending = h.core.loadMore()
      await h.settle()
      await pending
      expect(h.windowTurnCount.value).toBe(expected)
    }
    expect(h.core.isLast).toBe(true)
    await h.core.loadMore()
    expect(h.windowTurnCount.value).toBe(100)
  })

  test('reset 复位窗口 + 在途补偿作废（陈旧 flush 不回写不误清新代际状态）', async () => {
    const h = makeHarness({ totalTurns: 45, scrollTop: 50 })
    const pending = h.core.maybeLoadMore()
    expect(h.windowTurnCount.value).toBe(40)
    h.core.reset()
    expect(h.windowTurnCount.value).toBe(TURNS_PER_PAGE)
    expect(h.core.isLoadingMore).toBe(false)
    expect(h.suspensionLog).toEqual([true, false])
    h.viewportEl.scrollHeight = 3000
    await h.settle()
    await pending
    expect(h.applied).toEqual([])
    // 复位后新一代照常工作
    const next = h.core.maybeLoadMore()
    expect(h.windowTurnCount.value).toBe(40)
    h.viewportEl.scrollHeight = 5000
    await h.settle()
    await next
    expect(h.applied).toEqual([50 + 2000])
  })

  test('交错代际：reset 后新 loadMore 在途，旧 flush 落定不回写也不抢新代际的锁', async () => {
    const h = makeHarness({ totalTurns: 45, scrollTop: 50 })
    // 代际 0 在途（flush 未落定）
    const stale = h.core.maybeLoadMore()
    expect(h.windowTurnCount.value).toBe(40)
    // reset → 代际 1：窗口复位、锁清、抑制清
    h.core.reset()
    expect(h.suspensionLog).toEqual([true, false])
    // 代际 1 新 loadMore 启动（旧 flush 仍未落定）
    const fresh = h.core.maybeLoadMore()
    expect(h.windowTurnCount.value).toBe(40)
    expect(h.core.isLoadingMore).toBe(true)
    expect(h.suspensionLog).toEqual([true, false, true])
    // 旧 flush 落定：陈旧代际跳回写、跳解锁——新代际的锁与抑制不受影响
    h.viewportEl.scrollHeight = 3000
    await h.settleOldest()
    await stale
    expect(h.applied).toEqual([])
    expect(h.core.isLoadingMore).toBe(true)
    expect(h.suspensionLog).toEqual([true, false, true])
    // 新 flush 落定：正常补偿回写、解锁、清抑制
    await h.settle()
    await fresh
    expect(h.applied).toEqual([2050])
    expect(h.viewportEl.scrollTop).toBe(2050)
    expect(h.core.isLoadingMore).toBe(false)
    expect(h.suspensionLog).toEqual([true, false, true, false])
  })

  test('迟到内容高度：flush 后量测补一次，追踪期增量续补，追踪收束才解锁清抑制', async () => {
    const h = makeHarness({ totalTurns: 45, scrollTop: 50, withLateGrowth: true })
    const pending = h.core.maybeLoadMore()
    h.viewportEl.scrollHeight = 3000
    await h.settle()
    // flush 后一次性量测补偿先落（锁住未开——追踪仍在途）
    expect(h.applied).toEqual([2050])
    expect(h.core.isLoadingMore).toBe(true)
    expect(h.lateGrowthCalls).toHaveLength(1)
    // markdown 迟到高度分两波到账：增量续补（回写基值跟随当前 scrollTop）
    h.viewportEl.scrollHeight = 3500
    h.lateGrowthCalls[0]?.onGrowth(500)
    expect(h.applied).toEqual([2050, 2550])
    h.viewportEl.scrollHeight = 3660
    h.lateGrowthCalls[0]?.onGrowth(160)
    expect(h.applied).toEqual([2050, 2550, 2710])
    expect(h.suspensionLog).toEqual([true])
    // 追踪收束后才解锁清抑制
    h.lateGrowthCalls[0]?.release()
    await pending
    expect(h.viewportEl.scrollTop).toBe(2710)
    expect(h.core.isLoadingMore).toBe(false)
    expect(h.suspensionLog).toEqual([true, false])
  })

  test('迟到高度追踪期 reset：代际转陈旧，迟到增量不再回写且 isStale 报真', async () => {
    const h = makeHarness({ totalTurns: 45, scrollTop: 50, withLateGrowth: true })
    const pending = h.core.maybeLoadMore()
    h.viewportEl.scrollHeight = 3000
    await h.settle()
    expect(h.applied).toEqual([2050])
    h.core.reset()
    expect(h.suspensionLog).toEqual([true, false])
    const tracker = h.lateGrowthCalls[0]
    expect(tracker?.isStale()).toBe(true)
    // 陈旧追踪的迟到增量被代际守卫拦下
    tracker?.onGrowth(500)
    expect(h.applied).toEqual([2050])
    expect(h.viewportEl.scrollTop).toBe(2050)
    tracker?.release()
    await pending
    expect(h.core.isLoadingMore).toBe(false)
  })
})

const activeScopes: EffectScope[] = []

describe('useReversePagination Vue 接线', () => {
  function createRig(options: {
    messages: UIMessage[]
    scrollHeight?: number
    scrollTop?: number
  }) {
    const messages = ref(options.messages)
    const viewportEl = markRaw(new FakeElement(options.scrollHeight ?? 1000, 200))
    viewportEl.scrollTop = options.scrollTop ?? 0
    const viewport = ref<HTMLElement | undefined>() as Ref<HTMLElement | undefined>
    const autoFollowSuspended = ref(false)
    const sessionKey = ref(0)
    const scope = effectScope()
    activeScopes.push(scope)
    const api = scope.run(() =>
      useReversePagination({
        messages,
        viewport,
        autoFollowSuspended,
        resetKey: () => sessionKey.value
      })
    )
    if (!api) throw new Error('effectScope.run 未返回 hook 句柄')
    return {
      messages,
      viewportEl,
      viewport,
      autoFollowSuspended,
      sessionKey,
      switchSession: () => {
        sessionKey.value += 1
      },
      ...api
    }
  }

  async function mount(rig: ReturnType<typeof createRig>): Promise<void> {
    rig.viewport.value = asElement(rig.viewportEl)
    await nextTick()
  }

  test('窗口封顶：40 回合只渲染最近 20 回合（DOM 常数封顶）', async () => {
    const rig = createRig({ messages: turns(40) })
    await nextTick()
    expect(rig.windowMessages.value.map((m) => m.id)).toEqual(turns(20, 20).map((m) => m.id))
    expect(rig.hasMore.value).toBe(true)
  })

  test('≤N 不分页：20 回合全量渲染、hasMore=false', async () => {
    const rig = createRig({ messages: turns(20) })
    await nextTick()
    expect(rig.windowMessages.value).toHaveLength(40)
    expect(rig.hasMore.value).toBe(false)
  })

  test('进行中回合恒在场：追加新回合（含流式 assistant）总在窗口末尾', async () => {
    const rig = createRig({ messages: turns(40) })
    await nextTick()
    rig.messages.value = [...rig.messages.value, msg('user', 'u40'), msg('assistant', 'a40')]
    await nextTick()
    const ids = rig.windowMessages.value.map((m) => m.id)
    expect(ids.at(-1)).toBe('a40')
    expect(ids.at(-2)).toBe('u40')
    // 窗口仍是常数：41 回合仍只放行 20 回合
    expect(rig.windowMessages.value).toHaveLength(40)
  })

  test('滚顶触发：scroll 事件过门 → 窗口前扩 → flush 后补偿回写', async () => {
    const rig = createRig({ messages: turns(45), scrollTop: 50 })
    await mount(rig)
    rig.viewportEl.fire('scroll')
    expect(rig.core.isLoadingMore).toBe(true)
    expect(rig.autoFollowSuspended.value).toBe(true)
    expect(rig.windowMessages.value).toHaveLength(80)
    rig.viewportEl.scrollHeight = 3000
    await nextTick()
    await nextTick()
    expect(rig.viewportEl.scrollTop).toBe(2050)
    expect(rig.core.isLoadingMore).toBe(false)
    expect(rig.autoFollowSuspended.value).toBe(false)
  })

  test('贴底 scroll 事件不触发（流式跟随期的 scrollTop 写入不误装载）', async () => {
    const rig = createRig({ messages: turns(45), scrollTop: 800 })
    await mount(rig)
    rig.viewportEl.fire('scroll')
    await nextTick()
    await nextTick()
    expect(rig.core.isLoadingMore).toBe(false)
    expect(rig.windowMessages.value).toHaveLength(40)
  })

  test('切会话复位窗口：resetKey 沿触发回到初始 20 回合', async () => {
    const rig = createRig({ messages: turns(45), scrollTop: 50 })
    await mount(rig)
    rig.viewportEl.fire('scroll')
    await nextTick()
    await nextTick()
    expect(rig.windowMessages.value).toHaveLength(80)
    rig.switchSession()
    await nextTick()
    expect(rig.windowMessages.value).toHaveLength(40)
    expect(rig.hasMore.value).toBe(true)
    // 复位全契约：锁清、跟随抑制不残留
    expect(rig.core.isLoadingMore).toBe(false)
    expect(rig.autoFollowSuspended.value).toBe(false)
  })

  test('迟到高度追踪真实 rAF 收束：增量续补后静默帧解锁清抑制（生产典型路径）', async () => {
    installRafStub()
    try {
      const rig = createRig({ messages: turns(45), scrollTop: 50 })
      await mount(rig)
      rig.viewportEl.fire('scroll')
      expect(rig.core.isLoadingMore).toBe(true)
      expect(rig.autoFollowSuspended.value).toBe(true)
      // flush 落定 → 一次性补偿先落（1000 → 3000）
      rig.viewportEl.scrollHeight = 3000
      await nextTick()
      await nextTick()
      expect(rig.viewportEl.scrollTop).toBe(2050)
      // 追踪期：一波迟到高度（3000 → 3200）增量续补
      rig.viewportEl.scrollHeight = 3200
      flushFrames()
      expect(rig.viewportEl.scrollTop).toBe(2250)
      expect(rig.core.isLoadingMore).toBe(true)
      // 连续 6 帧静默 → 追踪收束 → 解锁清抑制
      for (let i = 0; i < 6; i++) flushFrames()
      await nextTick()
      expect(rig.core.isLoadingMore).toBe(false)
      expect(rig.autoFollowSuspended.value).toBe(false)
      expect(rig.viewportEl.scrollTop).toBe(2250)
    } finally {
      uninstallRafStub()
    }
  })

  test('迟到高度回调通路抛异常：追踪即收束，锁与抑制不悬挂', async () => {
    installRafStub()
    try {
      const rig = createRig({ messages: turns(45), scrollTop: 50 })
      await mount(rig)
      rig.viewportEl.fire('scroll')
      rig.viewportEl.scrollHeight = 3000
      await nextTick()
      await nextTick()
      expect(rig.viewportEl.scrollTop).toBe(2050)
      // 破坏 scrollTop 写入通路（补偿回调将抛错）
      const currentTop = 2050
      Object.defineProperty(rig.viewportEl, 'scrollTop', {
        get: () => currentTop,
        set: () => {
          throw new Error('boom')
        }
      })
      rig.viewportEl.scrollHeight = 3200
      flushFrames()
      await nextTick()
      expect(rig.core.isLoadingMore).toBe(false)
      expect(rig.autoFollowSuspended.value).toBe(false)
    } finally {
      uninstallRafStub()
    }
  })
})

// ── useScrollFollowing 抑制闸（反向分页协作的最小改动面） ─────────────────────

let rafQueue: Array<(() => void) | undefined> = []

function flushFrames(): void {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) cb?.()
}

/**
 * rAF 手动队列桩安装/卸载——仅迟到高度追踪收束用例使用（其余接线用例保持无
 * rAF 环境：trackLateGrowth 生产接线在无 rAF 环境退化为不追踪）。
 */
function installRafStub(): void {
  ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  }
}

function uninstallRafStub(): void {
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  rafQueue = []
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  private observed: FakeElement[] = []

  constructor(private callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }

  observe(el: FakeElement): void {
    if (this.observed.includes(el)) return
    this.observed.push(el)
    this.callback()
  }

  unobserve(el: FakeElement): void {
    this.observed = this.observed.filter((item) => item !== el)
  }

  disconnect(): void {
    this.observed = []
  }

  fire(): void {
    this.callback()
  }
}

describe('useScrollFollowing 自动贴底抑制闸', () => {
  beforeAll(() => {
    ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
      cb: () => void
    ) => {
      rafQueue.push(cb)
      return rafQueue.length
    }
    ;(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (id: number) => {
      rafQueue[id - 1] = undefined
    }
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
  })

  afterEach(() => {
    while (activeScopes.length) activeScopes.pop()?.stop()
    rafQueue = []
    FakeResizeObserver.instances = []
  })

  afterAll(() => {
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  })

  function createSuppressionRig() {
    const viewportEl = markRaw(new FakeElement(1000, 200))
    const contentEl = markRaw(new FakeElement())
    const viewport = ref<HTMLElement | undefined>() as Ref<HTMLElement | undefined>
    const content = ref<HTMLElement | undefined>() as Ref<HTMLElement | undefined>
    const submitted = ref(false)
    const autoFollowSuspended = ref(false)
    const scope = effectScope()
    activeScopes.push(scope)
    const api = scope.run(() =>
      useScrollFollowing(viewport, content, submitted, { autoFollowSuspended })
    )
    if (!api) throw new Error('effectScope.run 未返回 hook 句柄')
    return { viewportEl, contentEl, viewport, content, submitted, autoFollowSuspended, ...api }
  }

  test('LOAD_MORE 补偿期（抑制闸真）：内容增长不贴底；闸清后恢复跟随', async () => {
    const rig = createSuppressionRig()
    rig.viewport.value = asElement(rig.viewportEl)
    rig.content.value = asElement(rig.contentEl)
    await nextTick()
    flushFrames()
    expect(rig.viewportEl.scrollTop).toBe(1000)

    rig.autoFollowSuspended.value = true
    rig.viewportEl.scrollHeight = 1600
    FakeResizeObserver.instances[0]?.fire()
    flushFrames()
    expect(rig.viewportEl.scrollTop).toBe(1000)

    rig.autoFollowSuspended.value = false
    FakeResizeObserver.instances[0]?.fire()
    flushFrames()
    expect(rig.viewportEl.scrollTop).toBe(1600)
  })
})
