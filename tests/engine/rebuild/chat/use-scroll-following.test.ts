/**
 * D3（2026-09-18 chat-p1）：useScrollFollowing 状态机钉扎。
 *
 * 测试栈纪律：不引入 happy-dom（仓内先例 stop-rejection-guard.test.ts）——
 * hook 实现刻意走裸 DOM API + 调用期读全局（见 src/components/assistant/
 * useScrollFollowing.ts 文件头），本测试以合成容器（FakeElement 捕获监听器）
 * + 运行期全局桩（requestAnimationFrame 手动队列 / FakeResizeObserver）
 * 驱动全部分支，模块求值序无关（分片多文件同进程安全）。
 *
 * 三态验收映射：
 *  - 跟随态：容器挂载/内容增长 rAF 节流贴底；
 *  - 置停态：wheel/touchmove/方向键/滚动条手势（notifyExplicitScrollGesture）
 *    置停后内容增长不拽底；
 *  - 恢复态：滚回底部（scroll 事件回填 following）/ 新提交（submitted 沿）/
 *    浮钮点击（resumeFollowing）三通道恢复。
 * 浮钮显隐 = arrivedState.bottom（ChatPanel v-if="!arrivedState.bottom" 消费）。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { effectScope, markRaw, nextTick, ref, type EffectScope, type Ref } from 'vue'

import { useScrollFollowing } from '@/components/assistant/useScrollFollowing'

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

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  private observed: FakeElement[] = []

  constructor(private callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }

  observe(el: FakeElement): void {
    if (this.observed.includes(el)) return
    this.observed.push(el)
    // 真实 ResizeObserver 在 observe 时立即回发一次——保持同款语义
    this.callback()
  }

  unobserve(el: FakeElement): void {
    this.observed = this.observed.filter((item) => item !== el)
  }

  disconnect(): void {
    this.observed = []
  }

  /** 测试驱动内容/容器尺寸变化 */
  fire(): void {
    this.callback()
  }
}

let rafQueue: Array<(() => void) | undefined> = []

function flushFrames(): void {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) cb?.()
}

const activeScopes: EffectScope[] = []

function createRig(options: { scrollHeight?: number; clientHeight?: number } = {}) {
  // markRaw：ref() 对普通对象会包 reactive 代理（真实 DOM 元素的 toRawType
  // 不在 vue 可观察类型清单内故保持裸值）——不 markRaw 则 hook 内
  // event.target === viewport.value 的引用相等判定因代理失配
  const viewportEl = markRaw(
    new FakeElement(options.scrollHeight ?? 1000, options.clientHeight ?? 200)
  )
  const contentEl = markRaw(new FakeElement())
  const viewport = ref<HTMLElement | undefined>() as Ref<HTMLElement | undefined>
  const content = ref<HTMLElement | undefined>() as Ref<HTMLElement | undefined>
  const submitted = ref(false)
  const scope = effectScope()
  activeScopes.push(scope)
  const api = scope.run(() => useScrollFollowing(viewport, content, submitted))
  if (!api) throw new Error('effectScope.run 未返回 hook 句柄')
  return { viewportEl, contentEl, viewport, content, submitted, ...api }
}

/** 挂载容器 + 内容并消化首批调度（watch post 沿 + rAF 队列 + RO 初次回发） */
async function mount(rig: ReturnType<typeof createRig>): Promise<void> {
  rig.viewport.value = rig.viewportEl as unknown as HTMLElement
  rig.content.value = rig.contentEl as unknown as HTMLElement
  await nextTick()
  flushFrames()
}

beforeAll(() => {
  ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) => {
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

describe('D3 useScrollFollowing 智能滚动跟随', () => {
  test('跟随态：容器挂载即 rAF 节流贴底，浮钮隐（arrivedState.bottom=true）', async () => {
    const rig = createRig()
    await mount(rig)
    expect(rig.following.value).toBe(true)
    expect(rig.viewportEl.scrollTop).toBe(1000)
    expect(rig.arrivedState.bottom).toBe(true)
  })

  test('跟随态：内容增长（ResizeObserver）自动贴底——单帧去重', async () => {
    const rig = createRig()
    await mount(rig)
    rig.viewportEl.scrollHeight = 1400
    FakeResizeObserver.instances[0]?.fire()
    FakeResizeObserver.instances[0]?.fire()
    flushFrames()
    expect(rig.viewportEl.scrollTop).toBe(1400)
    expect(rig.arrivedState.bottom).toBe(true)
  })

  test('置停态：wheel 手势后置停跟随，内容增长不拽底，浮钮浮出', async () => {
    const rig = createRig()
    await mount(rig)
    // 用户上翻读历史
    rig.viewportEl.fire('wheel')
    expect(rig.following.value).toBe(false)
    rig.viewportEl.scrollTop = 300
    rig.viewportEl.fire('scroll')
    expect(rig.arrivedState.bottom).toBe(false)
    // 流式内容继续增长——不得拽回底部
    rig.viewportEl.scrollHeight = 1600
    FakeResizeObserver.instances[0]?.fire()
    flushFrames()
    expect(rig.viewportEl.scrollTop).toBe(300)
    expect(rig.following.value).toBe(false)
    expect(rig.arrivedState.bottom).toBe(false)
  })

  test('置停态：touchmove / 方向键 / 滚动条拖动（notifyExplicitScrollGesture）同款置停', async () => {
    const rig = createRig()
    await mount(rig)
    rig.viewportEl.fire('touchmove')
    expect(rig.following.value).toBe(false)

    const rigKeys = createRig()
    await mount(rigKeys)
    rigKeys.viewportEl.fire('keydown', { code: 'PageUp' })
    expect(rigKeys.following.value).toBe(false)
    // 非滚动手势键不误伤
    const rigOtherKey = createRig()
    await mount(rigOtherKey)
    rigOtherKey.viewportEl.fire('keydown', { code: 'KeyA' })
    expect(rigOtherKey.following.value).toBe(true)

    const rigScrollbar = createRig()
    await mount(rigScrollbar)
    rigScrollbar.notifyExplicitScrollGesture()
    expect(rigScrollbar.following.value).toBe(false)
    rigScrollbar.viewportEl.scrollHeight = 1600
    FakeResizeObserver.instances[0]?.fire()
    flushFrames()
    expect(rigScrollbar.viewportEl.scrollTop).toBe(1000)
  })

  test('恢复态①：手势滚动滚回底部即恢复跟随（scroll 事件回填）', async () => {
    const rig = createRig()
    await mount(rig)
    rig.viewportEl.fire('wheel')
    rig.viewportEl.scrollTop = 300
    rig.viewportEl.fire('scroll')
    expect(rig.following.value).toBe(false)
    // 用户滚回底部
    rig.viewportEl.scrollTop = 800 // 800 + 200 >= 1000 - 1
    rig.viewportEl.fire('scroll')
    expect(rig.following.value).toBe(true)
    expect(rig.arrivedState.bottom).toBe(true)
    // 恢复后内容增长重新贴底
    rig.viewportEl.scrollHeight = 1500
    FakeResizeObserver.instances[0]?.fire()
    flushFrames()
    expect(rig.viewportEl.scrollTop).toBe(1500)
  })

  test('恢复态②：用户新提交（submitted 沿）强制恢复跟随', async () => {
    const rig = createRig()
    await mount(rig)
    rig.viewportEl.fire('wheel')
    rig.viewportEl.scrollTop = 100
    rig.viewportEl.fire('scroll')
    expect(rig.following.value).toBe(false)
    rig.submitted.value = true
    await nextTick()
    flushFrames()
    expect(rig.following.value).toBe(true)
    expect(rig.viewportEl.scrollTop).toBe(1000)
    expect(rig.arrivedState.bottom).toBe(true)
  })

  test('恢复态③：浮钮点击（resumeFollowing）贴底并隐钮', async () => {
    const rig = createRig()
    await mount(rig)
    rig.viewportEl.fire('wheel')
    rig.viewportEl.scrollTop = 0
    rig.viewportEl.fire('scroll')
    expect(rig.arrivedState.bottom).toBe(false)
    rig.resumeFollowing()
    flushFrames()
    expect(rig.following.value).toBe(true)
    expect(rig.viewportEl.scrollTop).toBe(1000)
    expect(rig.arrivedState.bottom).toBe(true)
  })

  test('reasoning 折叠触发器点击暂停跟随；内容其他点击不影响', async () => {
    const rig = createRig()
    await mount(rig)
    const reasoningSummary = {
      closest: (selector: string) =>
        selector === '[data-slot="chat-reasoning-trigger"]' ? reasoningSummary : null
    }
    rig.contentEl.fire('click', { target: reasoningSummary })
    expect(rig.following.value).toBe(false)

    const rigPlain = createRig()
    await mount(rigPlain)
    rigPlain.contentEl.fire('click', { target: { closest: () => null } })
    expect(rigPlain.following.value).toBe(true)
  })

  test('视口 pointerdown 命中容器自身（原生滚动条拖动语义）置停，内容区域点击不置停', async () => {
    const rig = createRig()
    await mount(rig)
    rig.viewportEl.fire('pointerdown') // target 缺省 = viewport 自身
    expect(rig.following.value).toBe(false)

    const rigInner = createRig()
    await mount(rigInner)
    rigInner.viewportEl.fire('pointerdown', { target: new FakeElement() })
    expect(rigInner.following.value).toBe(true)
  })
})
