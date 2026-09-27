/* oxlint-disable open-pencil/no-module-mocking -- '@/app/editor/fonts' 依赖链沉（tauri/http→dom-css→需要 dist 产物），worktree 无 dist 编译；mock 暴露 listFonts/listFamilies 即可（本测试不触发字体通路），同 target.test.ts 范式 */
/**
 * 2026-09-21 viewport 聚焦链路断头路接通（仓外
 * docs/202609201112-viewport-focus-dead-path-review.md §5 方案 A）真闭环断言。
 *
 * 背景：工具侧（viewport_set / viewport_zoom_to_fit / create_brief / 营销 setup）
 * 写 FigmaAPI 私有 _viewport 死字段，makeFigmaFromStore 只单向 seed、实例用完即弃，
 * 真画布（store.state.panX/panY/zoom）从未被写回——4 处聚焦全不生效；且
 * viewport_zoom_to_fit 写死 zoom: 1 从未算 fit。tests/engine/rebuild/marketing/
 * 既有两条「viewport 中心移到包围盒中心」断言读同一实例死字段，是假绿。
 *
 * 本文件钉扎写回通路（假绿的反向缺口）：
 *  - FigmaAPI 构造注入可选 onViewportChange：set viewport 与
 *    scrollAndZoomIntoView 写 _viewport 时触发；缺省注入行为不变
 *  - makeFigmaFromStore 注入回写闭包：center/zoom → panX/panY 逆变换写回
 *    store.state + requestRepaint（计数为据）
 *  - viewport_zoom_to_fit 复用 scrollAndZoomIntoView fit 算法（padding 80、
 *    min(viewW/contentW, viewH/contentH, 1)），不再写死 zoom: 1
 *
 * store 用最小 fake（同 target.test.ts FakeTab 范式）：写回契约 = state 三键赋值 +
 * requestRepaint 调用，与 createEditorStore 真实实现（renderVersion++ + 事件发射）
 * 在契约面等价；真 store 依赖链需 dist，worktree 不可达。
 */

import { describe, expect, mock, test } from 'bun:test'

import { FigmaAPI, SceneGraph } from '@open-pencil/core'
import type { FigmaViewportSnapshot } from '@open-pencil/core/figma-api'

import { viewportSet, viewportZoomToFit } from '#core/tools/vector/viewport'

import { expectDefined } from '#tests/helpers/assert'

// makeFigmaFromStore seed 与 scrollAndZoomIntoView 直读 window.innerWidth/innerHeight
// （bun 无 DOM）——同 chat-brief-panel.test.ts 范式 stub，钉死视口 1920x1080。
;(globalThis as typeof globalThis & { window?: unknown }).window = {
  innerWidth: 1920,
  innerHeight: 1080
}

mock.module('@/app/editor/fonts', () => ({
  listFonts: async () => [],
  listFamilies: async () => []
}))

// mock.module 设置后必须动态 import 才生效（保证 mock 先于模块求值）
const { makeFigmaFromStore } = await import('@/app/bridge/figma-factory')

function firstPageId(graph: SceneGraph): string {
  return expectDefined(graph.getPages()[0]).id
}

/** 最小 fake EditorStore：写回契约消费面 = graph / state / requestRepaint / renderer。 */
function makeFakeStore() {
  const graph = new SceneGraph()
  const state = {
    currentPageId: firstPageId(graph),
    selectedIds: new Set<string>(),
    panX: 0,
    panY: 0,
    zoom: 1
  }
  let repaintCount = 0
  const store = {
    graph,
    state,
    renderer: null,
    requestRepaint: () => {
      repaintCount++
    }
  }
  return {
    store: store as Parameters<typeof makeFigmaFromStore>[0],
    graph,
    state,
    repaintCount: () => repaintCount
  }
}

describe('FigmaAPI onViewportChange 注入', () => {
  test('缺省不注入：set viewport 与 scrollAndZoomIntoView 行为不变（不抛错、_viewport 照常更新）', () => {
    const graph = new SceneGraph()
    const figma = new FigmaAPI(graph)
    const frame = graph.createNode('FRAME', firstPageId(graph), {
      x: 0,
      y: 0,
      width: 100,
      height: 100
    })

    figma.viewport = { center: { x: 100, y: 200 }, zoom: 2 }
    expect(figma.viewport.center).toEqual({ x: 100, y: 200 })
    expect(figma.viewport.zoom).toBe(2)

    const node = expectDefined(figma.getNodeById(frame.id))
    figma.viewport.scrollAndZoomIntoView([node])
    expect(figma.viewport.center).toEqual({ x: 50, y: 50 })
    expect(figma.viewport.zoom).toBe(1) // 小节点 fit 上限 1
  })

  test('set viewport 触发回调一次，载荷为写入的 center/zoom', () => {
    const graph = new SceneGraph()
    const calls: FigmaViewportSnapshot[] = []
    const figma = new FigmaAPI(graph, { onViewportChange: (v) => calls.push(v) })

    figma.viewport = { center: { x: 100, y: 200 }, zoom: 2 }

    expect(calls).toEqual([{ center: { x: 100, y: 200 }, zoom: 2 }])
  })

  test('scrollAndZoomIntoView 触发回调，载荷为 fit 算法结果（padding 80、上限 1）', () => {
    const graph = new SceneGraph()
    const calls: FigmaViewportSnapshot[] = []
    const figma = new FigmaAPI(graph, { onViewportChange: (v) => calls.push(v) })
    // bounds (100,50) 3680x1840 → content 3840x2000 → min(1920/3840, 1080/2000, 1) = 0.5
    const frame = graph.createNode('FRAME', firstPageId(graph), {
      x: 100,
      y: 50,
      width: 3680,
      height: 1840
    })

    figma.viewport.scrollAndZoomIntoView([expectDefined(figma.getNodeById(frame.id))])

    expect(calls).toEqual([{ center: { x: 1940, y: 970 }, zoom: 0.5 }])
  })

  test('scrollAndZoomIntoView 空数组 early-return：不触发回调', () => {
    const graph = new SceneGraph()
    const calls: FigmaViewportSnapshot[] = []
    const figma = new FigmaAPI(graph, { onViewportChange: (v) => calls.push(v) })

    figma.viewport.scrollAndZoomIntoView([])

    expect(calls).toEqual([])
  })
})

describe('makeFigmaFromStore viewport 写回（方案 A 断头路接通）', () => {
  test('seed 读方向保留：store pan/zoom → api.viewport center/zoom，同值回写不破坏 store', () => {
    const { store, state } = makeFakeStore()
    state.panX = -260
    state.panY = -140
    state.zoom = 2

    const api = makeFigmaFromStore(store)

    // center.x = (-panX + viewW/2)/zoom = (260+960)/2 = 610；center.y = (140+540)/2 = 340
    expect(api.viewport.center).toEqual({ x: 610, y: 340 })
    expect(api.viewport.zoom).toBe(2)
    // seed 触发的回写是逆变换精确还原——store 三键不变
    expect(state.panX).toBe(-260)
    expect(state.panY).toBe(-140)
    expect(state.zoom).toBe(2)
  })

  test('viewport_set 真闭环：store.state pan/zoom 写回 + requestRepaint', () => {
    const { store, state, repaintCount } = makeFakeStore()
    const api = makeFigmaFromStore(store)
    const repaintsBefore = repaintCount()

    viewportSet.execute(api, { x: 100, y: 200, zoom: 2 })

    // panX = viewW/2 - center.x*zoom = 960-200 = 760；panY = 540-400 = 140
    expect(state.panX).toBe(760)
    expect(state.panY).toBe(140)
    expect(state.zoom).toBe(2)
    expect(repaintCount()).toBeGreaterThan(repaintsBefore)
  })

  test('viewport_zoom_to_fit 真闭环：fit 缩放不再写死 1，store 随动', () => {
    const { store, graph, state, repaintCount } = makeFakeStore()
    const api = makeFigmaFromStore(store)
    // bounds (100,50) 3680x1840 → content 3840x2000 → zoom = 0.5；中心 (1940,970)
    const frame = graph.createNode('FRAME', state.currentPageId, {
      x: 100,
      y: 50,
      width: 3680,
      height: 1840
    })
    const repaintsBefore = repaintCount()

    const result = viewportZoomToFit.execute(api, { ids: [frame.id] }) as FigmaViewportSnapshot

    expect(result.zoom).toBe(0.5)
    expect(result.center).toEqual({ x: 1940, y: 970 })
    // panX = 960 - 1940*0.5 = -10；panY = 540 - 970*0.5 = 55
    expect(state.panX).toBe(-10)
    expect(state.panY).toBe(55)
    expect(state.zoom).toBe(0.5)
    expect(repaintCount()).toBeGreaterThan(repaintsBefore)
  })

  test('scrollAndZoomIntoView（create_brief / 营销 setup 调用形态）真闭环写回 store', () => {
    const { store, graph, state, repaintCount } = makeFakeStore()
    const api = makeFigmaFromStore(store)
    // 小节点 (0,0) 100x100：fit 上限封顶 zoom=1，中心 (50,50)
    const frame = graph.createNode('FRAME', state.currentPageId, {
      x: 0,
      y: 0,
      width: 100,
      height: 100
    })
    const repaintsBefore = repaintCount()

    api.viewport.scrollAndZoomIntoView([expectDefined(api.getNodeById(frame.id))])

    expect(state.zoom).toBe(1)
    expect(state.panX).toBe(910) // 960 - 50*1
    expect(state.panY).toBe(490) // 540 - 50*1
    expect(repaintCount()).toBeGreaterThan(repaintsBefore)
  })
})

// ── §7.3 视图层补洞：selection 种子过滤 + viewport 写回守卫 ──────────────────
//
// 这两个补洞服务于同一目的——施工期用户浏览与 agent 操作的隔离：
//  - selection 跨页污染：facade 钉页 ≠ 用户视图页时，Y 页选区不应种进 X 页
//  - viewport 写回劫持：facade 钉页 ≠ 用户视图页时，agent viewport 工具不该
//    拽走用户浏览视角

describe('makeFigmaFromStore selection 种子过滤（§7.3 视图层补洞）', () => {
  test('节点在目标页内 → 进入 facade selection', () => {
    const { store, graph, state } = makeFakeStore()
    const targetPage = graph.addPage('目标页')
    const frame = graph.createNode('FRAME', targetPage.id, { width: 100, height: 100 })
    state.selectedIds = new Set([frame.id])

    const api = makeFigmaFromStore(store, targetPage.id)
    expect(api.currentPage.selection).toHaveLength(1)
    expect(api.currentPage.selection[0].id).toBe(frame.id)
  })

  test('节点在别页（用户在别页选中、agent 钉本页）→ 不进入 facade selection', () => {
    const { store, graph, state } = makeFakeStore()
    // 用户视图页 = state.currentPageId（fakeStore 默认首页）；agent 钉 targetPage
    const otherPage = graph.addPage('用户当前页')
    const targetPage = graph.addPage('施工页')
    const frameOnUserPage = graph.createNode('FRAME', otherPage.id, { width: 100, height: 100 })
    state.selectedIds = new Set([frameOnUserPage.id])

    const api = makeFigmaFromStore(store, targetPage.id)
    // 跨页选区被过滤掉——agent 看 Y 页选区种进 X 页 API 的污染路径关闭
    expect(api.currentPage.selection).toHaveLength(0)
  })

  test('混合选中（部分在本页、部分在别页）→ 仅本页进入 facade selection', () => {
    const { store, graph, state } = makeFakeStore()
    const otherPage = graph.addPage('用户当前页')
    const targetPage = graph.addPage('施工页')
    const inPage = graph.createNode('FRAME', targetPage.id, { width: 100, height: 100 })
    const outPage = graph.createNode('FRAME', otherPage.id, { width: 100, height: 100 })
    state.selectedIds = new Set([inPage.id, outPage.id])

    const api = makeFigmaFromStore(store, targetPage.id)
    const ids = api.currentPage.selection.map((n) => n.id)
    expect(ids).toEqual([inPage.id])
  })

  test('缺省 pageId = 用户当前页：选区全在当前页 → 全部种入（回归原行为）', () => {
    const { store, graph, state } = makeFakeStore()
    const frame = graph.createNode('FRAME', state.currentPageId, { width: 100, height: 100 })
    state.selectedIds = new Set([frame.id])

    const api = makeFigmaFromStore(store) // 不传 pageId = state.currentPageId
    expect(api.currentPage.selection).toHaveLength(1)
    expect(api.currentPage.selection[0].id).toBe(frame.id)
  })
})

describe('makeFigmaFromStore viewport 写回守卫（§7.3 视图层补洞）', () => {
  test('facade 钉页 = 用户视图页 → viewport 工具写回 store（回归原行为）', () => {
    const { store, state, repaintCount } = makeFakeStore()
    const api = makeFigmaFromStore(store) // pageId 缺省 = state.currentPageId

    viewportSet.execute(api, { x: 100, y: 200, zoom: 2 })
    // 钉页一致 → 守卫放行 → 写回成立
    expect(state.panX).toBe(760)
    expect(state.panY).toBe(140)
    expect(state.zoom).toBe(2)
    expect(repaintCount()).toBeGreaterThan(0)
  })

  test('facade 钉页 ≠ 用户视图页（用户在看别页） → viewport 写回被守卫拒绝', () => {
    const { store, graph, state, repaintCount } = makeFakeStore()
    // 用户视图页 = state.currentPageId；agent 钉到另一页
    const agentPage = graph.addPage('施工页')
    const api = makeFigmaFromStore(store, agentPage.id)

    // 记录守卫前 store 三键与 repaint 计数
    const panXBefore = state.panX
    const panYBefore = state.panY
    const zoomBefore = state.zoom
    const repaintsBefore = repaintCount()

    viewportSet.execute(api, { x: 100, y: 200, zoom: 2 })

    // 守卫拒绝：store 三键不变 + 无 repaint
    expect(state.panX).toBe(panXBefore)
    expect(state.panY).toBe(panYBefore)
    expect(state.zoom).toBe(zoomBefore)
    expect(repaintCount()).toBe(repaintsBefore)
  })
})
