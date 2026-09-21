/**
 * 2026-09-21 修法 A+C 端到端断言：桥信封 {name, args, document_id, page_id}
 * 经 resolveAutomationTarget 直接出 target.{documentId, pageId}。
 *
 * 背景（仓外 docs/202609211649-agent-target-routing-research.md §2）：
 *  原实现把 document_id 埋在 args 嵌套内层（args.args.document_id），桥侧
 *  resolveAutomationTarget 在 envelope 读 args.document_id → 读不到 → 兜底
 *  跑活跃 tab。冒烟 target-smoke.mjs 仅断言请求形状，未端到端断言浏览器
 *  解析结果（research §2 标注——本测试补这个缺）。
 *
 * 钉扎：
 *  - 信封有 document_id → 命中该 id tab（不读活跃 tab）
 *  - 信封有 page_id → 命中该 page（不读 currentPageId）
 *  - 信封无 document_id → 退活跃 tab（同旧语义）
 *  - 信封无 page_id → 退该 tab currentPageId
 *  - stripAutomationTargetArgs 在 envelope 层剥 document_id/page_id（不污染
 *    工具 args）——与新信封布局归一
 *
 * mock.module('@/app/tabs')：tabs 模块自身依赖链沉（shell/ui → dom-css → 需要
 * dist 产物），worktree 当前无 dist 编译——以 mock 模块挡掉实际加载，只暴露
 * resolveAutomationTarget 真正消费的 getTabById / getTabForStore / getTabsSnapshot。
 */
/* oxlint-disable open-pencil/no-module-mocking -- tabs 模块依赖链沉（shell/ui→dom-css→需要 dist），worktree 无 dist 编译；mock 暴露 target 消费的三函数即可 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { createEditorStore } from '@/app/editor/session/create'

type FakeTab = {
  id: string
  store: {
    state: { documentName: string; currentPageId: string }
    graph: { getNode: (id: string) => { name: string; type: string } | undefined }
    getDocumentFilePath: () => string | null
  }
}

const TAB_A_ID = 'tab-A'
const TAB_B_ID = 'tab-B'
const PAGE_A1 = 'page-A1'
const PAGE_A2 = 'page-A2'
const PAGE_B1 = 'page-B1'

const fakeTabs: FakeTab[] = [
  {
    id: TAB_A_ID,
    store: {
      state: { documentName: 'Doc A', currentPageId: PAGE_A1 },
      graph: {
        getNode: (id: string) => {
          if (id === PAGE_A1) return { name: 'Page A1', type: 'CANVAS' }
          if (id === PAGE_A2) return { name: 'Page A2', type: 'CANVAS' }
          return undefined
        }
      },
      getDocumentFilePath: () => '/tmp/doc-a.fig'
    }
  },
  {
    id: TAB_B_ID,
    store: {
      state: { documentName: 'Doc B', currentPageId: PAGE_B1 },
      graph: {
        getNode: (id: string) => {
          if (id === PAGE_B1) return { name: 'Page B1', type: 'CANVAS' }
          return undefined
        }
      },
      getDocumentFilePath: () => null
    }
  }
]

// 桩 tab 图：fakeTabId → fakeTab 映射（允许测试中覆写，模拟缺页/非 CANVAS）
let tabGraph: Map<string, FakeTab> = new Map(fakeTabs.map((t) => [t.id, t]))

mock.module('@/app/tabs', () => ({
  getTabById: (id: string) => tabGraph.get(id),
  getTabForStore: (_store: unknown) => tabGraph.get(TAB_A_ID) ?? tabGraph.values().next().value,
  getTabsSnapshot: () => Array.from(tabGraph.values())
}))

// mock.module 设置后必须动态 import 才生效（保证 mock 先于模块求值）
const targetModule = await import('@/app/bridge/target')
const resolveAutomationTarget = targetModule.resolveAutomationTarget
const stripAutomationTargetArgs = targetModule.stripAutomationTargetArgs
type AutomationTargetArgs = Parameters<typeof resolveAutomationTarget>[1]

// activeStore 入参用真空 store（clipboard 测试同族先例：直接 createEditorStore()）——
// getTabForStore 已被 mock 接管（无 document_id 时直接回 tab-A，行为与「活跃 tab = tab-A」
// 一致），该入参仅过类型闸，字段不被读取
const activeStore = createEditorStore()

beforeEach(() => {
  // 重置 tab 图（防测试间串状态）
  tabGraph = new Map(fakeTabs.map((t) => [t.id, t]))
})

describe('resolveAutomationTarget 信封端到端（2026-09-21 修法 A+C）', () => {
  test('信封 { document_id } → 命中该 id tab（修法 A：document_id 在 envelope 层被读到）', () => {
    const target = resolveAutomationTarget(activeStore, { document_id: TAB_B_ID })
    expect(target.documentId).toBe(TAB_B_ID)
    expect(target.documentName).toBe('Doc B')
    // page_id 缺省 → 退该 tab currentPageId
    expect(target.pageId).toBe(PAGE_B1)
    expect(target.pageName).toBe('Page B1')
    expect(target.path).toBeUndefined()
  })

  test('信封 { document_id, page_id } → 命中指定 page，不读 currentPageId（修法 C 端点）', () => {
    const target = resolveAutomationTarget(activeStore, {
      document_id: TAB_A_ID,
      page_id: PAGE_A2
    })
    expect(target.documentId).toBe(TAB_A_ID)
    expect(target.pageId).toBe(PAGE_A2)
    expect(target.pageName).toBe('Page A2')
    // 即使 currentPageId 是 PAGE_A1，page_id override 生效
  })

  test('信封无 document_id → 退活跃 tab（旧语义保留）', () => {
    const target = resolveAutomationTarget(activeStore, undefined)
    expect(target.documentId).toBe(TAB_A_ID)
    expect(target.pageId).toBe(PAGE_A1)
  })

  test('信封 { document_id: unknownId } → 抛错（不是静默兜底活跃 tab）', () => {
    expect(() => resolveAutomationTarget(activeStore, { document_id: 'tab-unknown' })).toThrow(
      /not found/i
    )
  })

  test('信封 { document_id, page_id: unknownPage } → 抛错', () => {
    expect(() =>
      resolveAutomationTarget(activeStore, {
        document_id: TAB_A_ID,
        page_id: 'page-nope'
      })
    ).toThrow(/Page "page-nope" not found/i)
  })

  test('信封 page_id 是非 CANVAS 节点 → 抛错（page 类型校验）', () => {
    // 覆写 tab-A 的 graph：PAGE_A1 返回 FRAME（不是 CANVAS）——即使 id 存在也不当 page
    const tabA = tabGraph.get(TAB_A_ID)
    if (!tabA) throw new Error('fixture broken: tab-A missing from tabGraph')
    tabGraph.set(TAB_A_ID, {
      ...tabA,
      store: {
        ...tabA.store,
        graph: {
          getNode: (nid: string) => {
            if (nid === PAGE_A1) return { name: 'X', type: 'FRAME' }
            return undefined
          }
        }
      }
    })
    expect(() =>
      resolveAutomationTarget(activeStore, {
        document_id: TAB_A_ID,
        page_id: PAGE_A1
      })
    ).toThrow(/Page "page-A1" not found/i)
  })
})

describe('stripAutomationTargetArgs（信封层剥除）', () => {
  test('剥 document_id 与 page_id，rest 不动', () => {
    const envelope: AutomationTargetArgs & { name: string; args: Record<string, unknown> } = {
      name: 'create_shape',
      args: { type: 'RECTANGLE' },
      document_id: TAB_A_ID,
      page_id: PAGE_A2
    }
    const stripped = stripAutomationTargetArgs(envelope)
    expect(stripped).toEqual({ name: 'create_shape', args: { type: 'RECTANGLE' } })
    expect('document_id' in stripped).toBe(false)
    expect('page_id' in stripped).toBe(false)
  })

  test('剥除不残留脏数据：原实现 document_id 漏进工具 args 内层，现不在 envelope 留痕', () => {
    // 修法 A 同步断言：信封 envelope.document_id 剥掉后，args.args 内层没有
    // document_id 漏进——确保 tools.ts 不会把 document_id 当工具参数喂给
    // schema（schema 无此键被忽略、无害但脏）
    const envelope: AutomationTargetArgs & { name: string; args: Record<string, unknown> } = {
      name: 'create_shape',
      args: { type: 'RECTANGLE' },
      document_id: TAB_A_ID
    }
    const stripped = stripAutomationTargetArgs(envelope)
    const innerArgs: unknown = stripped.args
    if (typeof innerArgs !== 'object' || innerArgs === null) {
      throw new Error('stripped.args should remain an object')
    }
    expect('document_id' in innerArgs).toBe(false)
  })
})
