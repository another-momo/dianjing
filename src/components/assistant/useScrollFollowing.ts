/**
 * D3（2026-09-18 chat-p1）：智能滚动跟随——移植自上游
 * d7971ff03:src/components/chat/transcript/useScrollFollowing.ts，行为逐项对齐：
 *  1. 显式滚动手势（wheel / touchmove / 方向键 / 滚动条 pointerdown）置停跟随；
 *  2. ResizeObserver（容器 + 内容双监听）+ rAF 节流贴底；
 *  3. 用户新提交（submitted 沿）强制恢复跟随；
 *  4. 点开 reasoning 折叠块（data-slot="chat-reasoning-trigger"）暂停跟随；
 *  5. arrivedState.bottom 驱动「跳到底部」浮钮显隐。
 *
 * 与上游的有意偏离（实现层，行为不变）：
 *  - 不用 vueuse（useScroll/useEventListener/useResizeObserver 的 defaultWindow
 *    在模块求值期捕获；本仓 bun:test 无 DOM 全局且分片多文件同进程，求值序
 *    不可控 → 该路径不可测，见仓内测试栈「不引入 happy-dom」纪律先例
 *    tests/engine/rebuild/chat/stop-rejection-guard.test.ts）。改裸 DOM API +
 *    调用期读全局（requestAnimationFrame/ResizeObserver 幂等降级），
 *    合成容器可驱动全部状态机分支。
 *  - vueuse useScroll 的 200ms idle debounce 手势停止判定原样保留
 *    （SCROLL_IDLE_MS）；贴底容差对齐 ARRIVED_STATE_THRESHOLD_PIXELS = 1。
 *  - 增导 notifyExplicitScrollGesture：reka ScrollArea 隐藏原生滚动条
 *    （scrollbar-width:none，ScrollAreaViewport 注入样式），上游
 *    「pointerdown target===viewport 即滚动条拖动」的判定在自定义滚动条下
 *    不可达——ChatPanel 把 ScrollAreaScrollbar 的 pointerdown 显式接入本口。
 */

import { getCurrentScope, onScopeDispose, reactive, ref, watch, type Ref } from 'vue'

/** vueuse useScroll 默认 idle——滚动手势停止判定窗口（ms） */
const SCROLL_IDLE_MS = 200
/** vueuse ARRIVED_STATE_THRESHOLD_PIXELS 同款贴底容差（px） */
const BOTTOM_THRESHOLD_PX = 1
/** 显式滚动手势键位（上游同款清单，event.code 口径） */
const EXPLICIT_SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Space'
])
/** reasoning 折叠触发器选择器（上游同款契约；我方触发器是 PiChatMessage 内联
 *  details 的 summary，挂同款 data-slot） */
const REASONING_TRIGGER_SELECTOR = '[data-slot="chat-reasoning-trigger"]'

/** 调用期解析 rAF——模块求值期捕获会让测试桩失效（bun 无 rAF 全局） */
function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return setTimeout(callback, 16)
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

type ScrollTarget = Ref<HTMLElement | undefined>

/**
 * 输出跟随是用户可控模式，不是距离阈值（上游原注）。
 *
 * @param viewport 滚动容器（reka ScrollAreaViewport 暴露的 viewportElement）
 * @param content 消息列表内容元素（ResizeObserver 监听其高度增长驱动贴底）
 * @param submitted 用户新提交信号（false→true 沿强制恢复跟随）
 */
export function useScrollFollowing(
  viewport: ScrollTarget,
  content: ScrollTarget,
  submitted: Ref<boolean>
) {
  const following = ref(true)
  /** 浮钮显隐源——上游 arrivedState 全向，消费方只用 bottom，只维护这一向 */
  const arrivedState = reactive({ bottom: true })
  let frame: number | undefined
  let userScrolling = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let resizeObserver: ResizeObserver | undefined

  function atBottom(): boolean {
    const el = viewport.value
    if (!el) return true
    return Math.abs(el.scrollTop) + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD_PX
  }

  /** 上游 useScroll measure() 对应物——程序化贴底后同步浮钮状态，不等 scroll 事件 */
  function syncArrived(): void {
    arrivedState.bottom = atBottom()
  }

  function scheduleFollow(): void {
    if (!following.value || frame !== undefined) return
    frame = scheduleFrame(() => {
      frame = undefined
      if (!following.value || !viewport.value) return
      viewport.value.scrollTop = viewport.value.scrollHeight
      syncArrived()
    })
  }

  function resumeFollowing(): void {
    following.value = true
    userScrolling = false
    scheduleFollow()
  }

  /** 显式滚动手势统一入口（wheel / touchmove / 方向键 / 滚动条 pointerdown 共用） */
  function beginUserScroll(): void {
    userScrolling = true
    following.value = false
  }

  function onScroll(): void {
    syncArrived()
    // 用户手势滚动期间，贴底判定实时回填——滚回底部即恢复跟随（上游同款）
    if (userScrolling) following.value = arrivedState.bottom
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      userScrolling = false
    }, SCROLL_IDLE_MS)
  }

  function onScrollEnd(): void {
    userScrolling = false
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  function onKeydown(event: Event): void {
    if (EXPLICIT_SCROLL_KEYS.has((event as KeyboardEvent).code)) beginUserScroll()
  }

  function onViewportPointerDown(event: Event): void {
    // 原生滚动条拖动是显式导航手势；普通内容点击不是（上游原注 + 判定）
    if ((event as PointerEvent).target === viewport.value) beginUserScroll()
  }

  function onContentClick(event: Event): void {
    // 点开 reasoning 折叠 = 读历史意图——暂停跟随（鸭式closest：bun 无 Element 全局）
    const target = (event as MouseEvent).target as { closest?: (s: string) => unknown } | null
    if (typeof target?.closest === 'function' && target.closest(REASONING_TRIGGER_SELECTOR)) {
      following.value = false
    }
  }

  function listen(
    target: ScrollTarget,
    type: string,
    handler: EventListener,
    options?: AddEventListenerOptions
  ): void {
    watch(
      target,
      (el, _prev, onCleanup) => {
        if (!el) return
        el.addEventListener(type, handler, options)
        onCleanup(() => el.removeEventListener(type, handler, options))
      },
      { immediate: true }
    )
  }

  listen(viewport, 'wheel', beginUserScroll, { passive: true })
  listen(viewport, 'touchmove', beginUserScroll, { passive: true })
  listen(viewport, 'keydown', onKeydown)
  listen(viewport, 'pointerdown', onViewportPointerDown)
  listen(viewport, 'scroll', onScroll, { passive: true })
  // vueuse 同款 scrollend 快路径（支持浏览器即时复位手势旗标；不支持则 idle 兜）
  listen(viewport, 'scrollend', onScrollEnd, { passive: true })
  listen(content, 'click', onContentClick, { capture: true })

  watch(
    [viewport, content],
    (_curr, _prev, onCleanup) => {
      if (typeof ResizeObserver === 'undefined') return
      resizeObserver ??= new ResizeObserver(() => {
        scheduleFollow()
        syncArrived()
      })
      const observed = [viewport.value, content.value].filter(
        (el): el is HTMLElement => el !== undefined
      )
      for (const el of observed) resizeObserver.observe(el)
      onCleanup(() => {
        for (const el of observed) resizeObserver?.unobserve(el)
      })
    },
    { immediate: true, flush: 'post' }
  )

  watch(submitted, (value) => {
    if (value) resumeFollowing()
  })

  // 容器挂载/换实例后补一次贴底 + 浮钮状态同步（上游 watch(viewport) 同款）
  watch(
    viewport,
    () => {
      syncArrived()
      scheduleFollow()
    },
    { flush: 'post' }
  )

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (frame !== undefined) cancelFrame(frame)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      resizeObserver?.disconnect()
    })
  }

  return {
    following,
    arrivedState,
    resumeFollowing,
    /** reka 自定义滚动条拖动置停入口（原生滚动条判定在 reka 下不可达，见文件头注） */
    notifyExplicitScrollGesture: beginUserScroll
  }
}
