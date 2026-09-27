/**
 * 2026-09-27 sl-w2-locus-gate：run 期施工页追踪器单测。
 *
 * 覆盖矩阵：
 *  - ready → submitted：捕获 currentPageId
 *  - ready → streaming：捕获 currentPageId
 *  - submitted → streaming：保持原值（同 run 不重捕）
 *  - submitted/streaming → ready：清空
 *  - submitted/streaming → error：保持（T94 stop 路径，run 未真收尾）
 *  - error → ready：保持现状（让上一段清空自然过渡）
 *  - resolveStartPageId 返 null：不更新（防图替换空窗）
 *
 * 不覆盖：watcher 注册行为（Vue 内置）；接线 ChatPanel 由收口门禁 + L3 实测兜底。
 */

import { describe, expect, test } from 'bun:test'

import { nextTick, ref } from 'vue'

import { bindRunPageTracking } from '@/components/assistant/locus-run'

type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

const PAGE_A = 'page-aaa'
const PAGE_B = 'page-bbb'

function makeChat(status: ChatStatus) {
  return ref<{ status: ChatStatus } | null>({ status })
}

describe('bindRunPageTracking', () => {
  test('ready → submitted：捕获 currentPageId', async () => {
    const chat = makeChat('ready')
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_A
    })
    expect(tracker.runStartedPageId.value).toBeNull()

    chat.value = { status: 'submitted' }
    await nextTick()
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)
  })

  test('ready → streaming：捕获 currentPageId', async () => {
    const chat = makeChat('ready')
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_B
    })

    chat.value = { status: 'streaming' }
    await nextTick()
    expect(tracker.runStartedPageId.value).toBe(PAGE_B)
  })

  test('submitted → streaming：保持原值（同 run 不重捕）', async () => {
    const chat = makeChat('submitted')
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_A
    })
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)

    chat.value = { status: 'streaming' }
    await nextTick()
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)
  })

  test('submitted → ready：清空（run 收尾）', async () => {
    const chat = makeChat('submitted')
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_A
    })
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)

    chat.value = { status: 'ready' }
    await nextTick()
    expect(tracker.runStartedPageId.value).toBeNull()
  })

  test('streaming → ready：清空（run 收尾）', async () => {
    const chat = makeChat('streaming')
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_A
    })
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)

    chat.value = { status: 'ready' }
    await nextTick()
    expect(tracker.runStartedPageId.value).toBeNull()
  })

  test('submitted → error：保持（T94 stop 路径）', async () => {
    const chat = makeChat('submitted')
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_A
    })
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)

    chat.value = { status: 'error' }
    await nextTick()
    // 呼吸徽标应继续显示——让用户感知「该 run 仍可能重试」；
    // error 不算收尾（stop 触发的 status='error' 路径——T94）
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)
  })

  test('submitted → error → submitted：error 期间不污染、下一次起始重新捕获', async () => {
    const chat = makeChat('submitted')
    let nextPage = PAGE_A
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => nextPage
    })
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)

    chat.value = { status: 'error' }
    await nextTick()
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)

    nextPage = PAGE_B
    chat.value = { status: 'submitted' }
    await nextTick()
    expect(tracker.runStartedPageId.value).toBe(PAGE_B)
  })

  test('resolveStartPageId 返 null：不更新（防图替换空窗）', async () => {
    const chat = makeChat('ready')
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => null
    })
    expect(tracker.runStartedPageId.value).toBeNull()

    chat.value = { status: 'submitted' }
    await nextTick()
    expect(tracker.runStartedPageId.value).toBeNull()
  })

  test('reset() 单测钩子：手动清空', () => {
    const chat = makeChat('submitted')
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_A
    })
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)
    tracker.reset()
    expect(tracker.runStartedPageId.value).toBeNull()
  })

  test('chat 整体清空（store 切换）：保留旧值直到下一次 ready→submitted 重新捕获', async () => {
    // store 切换时 chat ref 可能瞬态为 null；watch 退化以 ready 处理。
    const chat = makeChat('streaming')
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_A
    })
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)

    chat.value = null
    await nextTick()
    // null chat → 退化为 ready 路径——但当前是 streaming → ready，应清空
    // （chat 切走即视为旧 run 收尾，与 owner 拍板语义一致）
    expect(tracker.runStartedPageId.value).toBeNull()
  })

  test('follow 开启 + engagedPageId 已设 ≠ 当前视图：先切视图再捕获 engaged', async () => {
    const chat = makeChat('ready')
    let switchedTo: string | null = null
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_B,
      isFollowLocusEnabled: () => true,
      getEngagedPageId: () => PAGE_A,
      switchToPage: (id) => {
        switchedTo = id
      }
    })
    expect(tracker.runStartedPageId.value).toBeNull()

    chat.value = { status: 'submitted' }
    await nextTick()
    expect(switchedTo).toBe(PAGE_A)
    // 捕获 = 已切到的 engaged 页（A），不是当前视图（B）
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)
  })

  test('follow 开启 + engagedPageId 与当前视图相同：不触发无谓切页', async () => {
    const chat = makeChat('ready')
    let switchedTo: string | null = null
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_A,
      isFollowLocusEnabled: () => true,
      getEngagedPageId: () => PAGE_A,
      switchToPage: (id) => {
        switchedTo = id
      }
    })

    chat.value = { status: 'submitted' }
    await nextTick()
    expect(switchedTo).toBeNull()
    expect(tracker.runStartedPageId.value).toBe(PAGE_A)
  })

  test('follow 开启 + engagedPageId 缺省（null/空）：按默认路径捕获当前视图', async () => {
    const chat = makeChat('ready')
    let switchedTo: string | null = null
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_B,
      isFollowLocusEnabled: () => true,
      getEngagedPageId: () => null,
      switchToPage: (id) => {
        switchedTo = id
      }
    })

    chat.value = { status: 'submitted' }
    await nextTick()
    expect(switchedTo).toBeNull()
    expect(tracker.runStartedPageId.value).toBe(PAGE_B)
  })

  test('follow 关闭（默认）：不切视图，捕获当前视图', async () => {
    const chat = makeChat('ready')
    let switchedTo: string | null = null
    const tracker = bindRunPageTracking({
      chat,
      resolveStartPageId: () => PAGE_B,
      isFollowLocusEnabled: () => false,
      getEngagedPageId: () => PAGE_A,
      switchToPage: (id) => {
        switchedTo = id
      }
    })

    chat.value = { status: 'submitted' }
    await nextTick()
    expect(switchedTo).toBeNull()
    expect(tracker.runStartedPageId.value).toBe(PAGE_B)
  })
})
