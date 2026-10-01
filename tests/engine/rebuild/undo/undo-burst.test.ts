/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * T59（S3 §9 undo burst / PD-19）：一 AI 回合的 mutating 调用按设计区合并为
 * 一个撤销单元。桥侧机制 = undo_group begin/end 边界信号 + UndoManager 既有
 * coalesceKey 相邻合并（见 src/app/bridge/tool-handlers.ts 头注）。
 *
 * 覆盖验收（T59-plan §3）：
 *  1. 同回合同区 3 次 mutating → 撤销栈净增 1 单元，单次 undo 整体回退
 *  2. 同回合跨两区 → 2 单元（组键变化先闭旧组开新组）
 *  3. 跨回合 → 各自成单元；无边界信号来源（MCP/CLI）行为不变
 *  4. 组打开期用户编辑不被吞并（无 key 条目截断合并链）
 *  5. 悬挂组自闭合：end 丢失后下个 begin 覆盖旧组，跨回合不串组合并
 *  6. 只读工具在组打开期零 undo 开销
 */
import { describe, expect, mock, test } from 'bun:test'

import { createEditor, type Editor } from '@open-pencil/core/editor'
import { FigmaAPI } from '@open-pencil/core/figma-api'

// 测试环境无 indexedDB：LibraryService 单例构造会 new LocalLibraryCatalog（idb）。
// 组件目录与撤销语义无关，桩掉 useLibraryService（registerComponentCatalog 只
// 要求 ComponentCatalog 三方法面）
mock.module('@/app/libraries', () => ({
  useLibraryService: () => ({
    bindEditor: () => undefined,
    listLibraries: async () => [],
    listComponents: async () => [],
    insertComponent: async () => {
      throw new Error('not implemented in test stub')
    }
  })
}))

import type { AutomationTarget } from '@/app/bridge/target'
import { createAutomationToolHandler } from '@/app/bridge/tool-handlers'

type ToolResult = Record<string, unknown>

type UndoStackProbe = { undoStack: unknown[] }

function undoDepth(editor: Editor): number {
  // UndoManager 无公开深度口径；测试经私有字段钉住「净增 N 单元」语义
  const manager = editor.undo as Partial<UndoStackProbe>
  return (manager.undoStack ?? []).length
}

function setupBridge() {
  const editor = createEditor()
  const pageId = editor.graph.getPages()[0].id
  // core editor 已带 graph/snapshotPage/pushUndoEntry/requestRender/renderer；
  // flashNodes 是 app store 模块能力，测试打桩（Object.create 走原型委托，
  // 保留 editor 的 getter 语义）
  // Object.assign 返回 any，直接赋给目标类型即可（免双 cast）
  const store: AutomationTarget['store'] = Object.assign(Object.create(editor), {
    flashNodes: () => undefined
  })
  const target: AutomationTarget = {
    store,
    documentId: 'doc-t59',
    documentName: 'T59 Test',
    pageId,
    pageName: 'Page 1'
  }
  const makeFigma = (figmaStore: AutomationTarget['store'], figmaPageId?: string) => {
    const api = new FigmaAPI(figmaStore.graph)
    api.currentPage = api.wrapNode(figmaPageId ?? pageId)
    return api
  }
  const { handleTool, handleUndoGroup } = createAutomationToolHandler(makeFigma)

  async function callTool(name: string, args: ToolResult = {}): Promise<ToolResult> {
    const res = (await handleTool(target, { name, args })) as { ok: boolean; result: ToolResult }
    expect(res.ok).toBe(true)
    return res.result
  }
  async function begin() {
    await handleUndoGroup(target, { action: 'begin' })
  }
  async function end() {
    await handleUndoGroup(target, { action: 'end' })
  }
  /** 模拟用户手动编辑：走编辑器既有 undo 路径（无 coalesceKey 条目） */
  function userRename(nodeId: string, name: string) {
    // getNode 返回活对象——先取值再改，否则 previous 被 updateNode 原地污染
    const previousName = editor.graph.getNode(nodeId)?.name
    if (previousName === undefined) throw new Error(`node gone: ${nodeId}`)
    editor.graph.updateNode(nodeId, { name })
    editor.commitNodeUpdate(nodeId, { name: previousName }, 'Rename')
  }
  return { editor, pageId, callTool, begin, end, userRename }
}

describe('T59 undo burst coalesce（AI 回合撤销组合并）', () => {
  test('同回合同区 3 次 mutating → 净增 1 撤销单元，单次 undo 整体回退、redo 整体重做', async () => {
    const b = setupBridge()
    const base = undoDepth(b.editor)

    await b.begin()
    const zone = await b.callTool('create_shape', {
      type: 'FRAME',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      name: 'Zone A'
    })
    const zoneId = zone.id as string
    const rect = await b.callTool('create_shape', {
      type: 'RECTANGLE',
      parent_id: zoneId,
      x: 10,
      y: 10,
      width: 100,
      height: 100
    })
    await b.callTool('set_radius', { id: rect.id, radius: 8 })
    await b.end()

    expect(undoDepth(b.editor)).toBe(base + 1)
    expect(b.editor.undo.undoLabel).toBe('AI: create_shape +2 more')
    expect(b.editor.graph.getNode(zoneId)).toBeDefined()

    // 一次 undo 回退整个回合爆发（区 frame + 子矩形 + 圆角全部消失）
    b.editor.undo.undo()
    expect(undoDepth(b.editor)).toBe(base)
    expect(b.editor.graph.getNode(zoneId)).toBeUndefined()
    expect(b.editor.graph.getNode(rect.id as string)).toBeUndefined()

    // 一次 redo 整体重做
    b.editor.undo.redo()
    expect(undoDepth(b.editor)).toBe(base + 1)
    expect(b.editor.graph.getNode(zoneId)).toBeDefined()
    const restored = b.editor.graph.getNode(rect.id as string)
    expect(restored).toBeDefined()
    expect(restored?.cornerRadius).toBe(8)
  })

  test('同回合跨两区 → 2 撤销单元，按区各自整体回退', async () => {
    const b = setupBridge()
    const base = undoDepth(b.editor)

    await b.begin()
    const zoneA = await b.callTool('create_shape', {
      type: 'FRAME',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      name: 'Zone A'
    })
    const rectA = await b.callTool('create_shape', {
      type: 'RECTANGLE',
      parent_id: zoneA.id as string,
      x: 10,
      y: 10,
      width: 50,
      height: 50
    })
    const zoneB = await b.callTool('create_shape', {
      type: 'FRAME',
      x: 500,
      y: 0,
      width: 400,
      height: 300,
      name: 'Zone B'
    })
    const ellipseB = await b.callTool('create_shape', {
      type: 'ELLIPSE',
      parent_id: zoneB.id as string,
      x: 10,
      y: 10,
      width: 50,
      height: 50
    })
    await b.end()

    expect(undoDepth(b.editor)).toBe(base + 2)

    // 栈顶 = 区 B 爆发单元：undo 只回退 B 区，A 区原样
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(zoneB.id as string)).toBeUndefined()
    expect(b.editor.graph.getNode(ellipseB.id as string)).toBeUndefined()
    expect(b.editor.graph.getNode(zoneA.id as string)).toBeDefined()
    expect(b.editor.graph.getNode(rectA.id as string)).toBeDefined()

    // 再一次 undo 回退 A 区爆发
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(zoneA.id as string)).toBeUndefined()
    expect(b.editor.graph.getNode(rectA.id as string)).toBeUndefined()
    expect(undoDepth(b.editor)).toBe(base)
  })

  test('跨回合各自成单元；无边界信号（MCP/CLI 语义）每次调用独立成单元', async () => {
    const b = setupBridge()
    const base = undoDepth(b.editor)

    // 回合 1：建区 frame
    await b.begin()
    const zone = await b.callTool('create_shape', {
      type: 'FRAME',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      name: 'Zone A'
    })
    await b.end()
    expect(undoDepth(b.editor)).toBe(base + 1)

    // 回合 2：同区加子节点——turnKey 不同，不与回合 1 合并
    await b.begin()
    await b.callTool('create_shape', {
      type: 'RECTANGLE',
      parent_id: zone.id as string,
      x: 10,
      y: 10,
      width: 50,
      height: 50
    })
    await b.end()
    expect(undoDepth(b.editor)).toBe(base + 2)

    // 无 begin/end 的 mutating 调用（MCP/CLI 来源语义）：各自成单元
    await b.callTool('rename_node', { id: zone.id as string, name: 'Renamed A' })
    await b.callTool('set_radius', { id: zone.id as string, radius: 4 })
    expect(undoDepth(b.editor)).toBe(base + 4)

    // 逐层回退顺序：圆角 → 改名 → 回合 2 子节点 → 回合 1 区 frame
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(zone.id as string)?.cornerRadius).toBe(0)
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(zone.id as string)?.name).toBe('Zone A')
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(zone.id as string)?.childIds).toHaveLength(0)
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(zone.id as string)).toBeUndefined()
    expect(undoDepth(b.editor)).toBe(base)
  })

  test('组打开期用户手动编辑不被吞并：用户条目截断合并链、独立成单元', async () => {
    const b = setupBridge()
    const base = undoDepth(b.editor)

    await b.begin()
    const zone = await b.callTool('create_shape', {
      type: 'FRAME',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      name: 'Zone A'
    })
    const rect = await b.callTool('create_shape', {
      type: 'RECTANGLE',
      parent_id: zone.id as string,
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      name: 'Card'
    })
    // 组打开期间用户手动改名
    b.userRename(rect.id as string, 'User Card')
    // 用户编辑后同区 AI 继续操作
    const ellipse = await b.callTool('create_shape', {
      type: 'ELLIPSE',
      parent_id: zone.id as string,
      x: 100,
      y: 10,
      width: 50,
      height: 50
    })
    await b.end()

    // AI 前两步合并 1 单元 + 用户编辑 1 单元 + 用户后 AI 步骤 1 单元
    expect(undoDepth(b.editor)).toBe(base + 3)

    // undo 第一段 AI（椭圆）：用户改名必须原样保留（不被吞）
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(ellipse.id as string)).toBeUndefined()
    expect(b.editor.graph.getNode(rect.id as string)?.name).toBe('User Card')

    // undo 用户编辑：名字回到 AI 所起
    expect(b.editor.undo.undoLabel).toBe('Rename')
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(rect.id as string)?.name).toBe('Card')

    // undo 区 A 爆发单元：frame + 矩形整体消失
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(zone.id as string)).toBeUndefined()
    expect(b.editor.graph.getNode(rect.id as string)).toBeUndefined()
    expect(undoDepth(b.editor)).toBe(base)
  })

  test('悬挂组自闭合：end 丢失后下个 begin 覆盖旧组，跨回合同区不串组', async () => {
    const b = setupBridge()
    const base = undoDepth(b.editor)

    // 回合 1：begin 后 end 丢失（后端崩溃/桥断连语义）
    await b.begin()
    const zone = await b.callTool('create_shape', {
      type: 'FRAME',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      name: 'Zone A'
    })
    // （无 end）

    // 回合 2：begin 直接覆盖悬挂旧组；同区操作不得并入回合 1 的单元
    await b.begin()
    const rect = await b.callTool('create_shape', {
      type: 'RECTANGLE',
      parent_id: zone.id as string,
      x: 10,
      y: 10,
      width: 50,
      height: 50
    })
    await b.end()

    expect(undoDepth(b.editor)).toBe(base + 2)
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(rect.id as string)).toBeUndefined()
    expect(b.editor.graph.getNode(zone.id as string)).toBeDefined()
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(zone.id as string)).toBeUndefined()

    // end 之后组已关闭：后续无 begin 的调用不残留组语义（各自成单元）
    await b.callTool('create_shape', {
      type: 'ELLIPSE',
      x: 600,
      y: 0,
      width: 50,
      height: 50
    })
    await b.callTool('create_shape', {
      type: 'STAR',
      x: 700,
      y: 0,
      width: 50,
      height: 50
    })
    expect(undoDepth(b.editor)).toBe(base + 2)
  })

  test('只读工具在组打开期零 undo 开销', async () => {
    const b = setupBridge()
    const base = undoDepth(b.editor)

    await b.begin()
    const zone = await b.callTool('create_shape', {
      type: 'FRAME',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      name: 'Zone A'
    })
    const before = undoDepth(b.editor)
    const bounds = await b.callTool('node_bounds', { id: zone.id as string })
    expect(bounds.bounds).toBeDefined()
    expect(undoDepth(b.editor)).toBe(before)
    await b.end()

    // 整回合（含只读调用）仍净增 1 单元
    expect(undoDepth(b.editor)).toBe(base + 1)
  })
})

// ── §8 布局重算脏页作用域：跨页引用 → 他页布局不再陈旧 ──────────────────────
//
// 落点页 ∪ 本次被改节点所在页逐页 computeAllLayouts。
// 验证方式：在 pageB 建 HORIZONTAL/AUTO frame + 子节点，落点 = pageA 时按
// id 改 pageB 子节点宽度——若只重算落点页，他页 frame 宽度停在旧值；扩展作
// 用域后他页 frame 宽度 = 子节点宽度（证明他页被重算）。

function setupBridgeMultiPage() {
  const editor = createEditor()
  const pageA = editor.graph.getPages()[0].id
  const pageB = editor.graph.addPage('Page B').id
  const store: AutomationTarget['store'] = Object.assign(Object.create(editor), {
    flashNodes: () => undefined
  })
  const target: AutomationTarget = {
    store,
    documentId: 'doc-scope',
    documentName: 'Scope Test',
    pageId: pageA,
    pageName: 'Page A'
  }
  const makeFigma = (figmaStore: AutomationTarget['store'], figmaPageId?: string) => {
    const api = new FigmaAPI(figmaStore.graph)
    api.currentPage = api.wrapNode(figmaPageId ?? pageA)
    return api
  }
  const { handleTool } = createAutomationToolHandler(makeFigma)
  async function callTool(name: string, args: ToolResult): Promise<ToolResult> {
    const res = (await handleTool(target, { name, args })) as { ok: boolean; result: ToolResult }
    expect(res.ok).toBe(true)
    return res.result
  }
  return { editor, pageA, pageB, callTool }
}

describe('§8 布局重算脏页作用域（tool-handlers 跨页引用）', () => {
  test('按 id 直改他页节点 → 他页自动布局 frame 宽度被刷新（不被脏页作用域遗漏）', async () => {
    const b = setupBridgeMultiPage()

    // 在 pageB 建 frame + 子节点，启用 HORIZONTAL/AUTO 自动布局（HUG 宽度）
    const frameB = await b.callTool('create_shape', {
      type: 'FRAME',
      parent_id: b.pageB,
      x: 0,
      y: 0,
      width: 10,
      height: 100,
      name: 'AutoB'
    })
    await b.callTool('set_layout', { id: frameB.id as string, direction: 'HORIZONTAL' })
    await b.callTool('create_shape', {
      type: 'RECTANGLE',
      parent_id: frameB.id as string,
      x: 0,
      y: 0,
      width: 100,
      height: 50
    })
    const frameBId = frameB.id as string

    // 落点 = pageA。按 id 改 pageB 子节点的宽度——当前实现按 args 浅扫会
    // 命中子节点 id（仅字符串值，不区分键名），触发 dirty-page 集合加入 pageB。
    await b.callTool('update_node', {
      id: b.editor.graph.getChildren(frameBId)[0].id,
      width: 250
    })

    // §8 修法成立条件：pageB layout 被刷新 → frameB 宽度 = 子节点宽度 = 250
    expect(b.editor.graph.getNode(frameBId)?.width).toBe(250)
  })

  test('同页 mutate：作用域仍含落点页（回归不漏）', async () => {
    const b = setupBridgeMultiPage()

    const frameA = await b.callTool('create_shape', {
      type: 'FRAME',
      parent_id: b.pageA,
      x: 0,
      y: 0,
      width: 10,
      height: 100,
      name: 'AutoA'
    })
    await b.callTool('set_layout', { id: frameA.id as string, direction: 'HORIZONTAL' })
    const childA = await b.callTool('create_shape', {
      type: 'RECTANGLE',
      parent_id: frameA.id as string,
      x: 0,
      y: 0,
      width: 80,
      height: 50
    })

    await b.callTool('update_node', { id: childA.id as string, width: 175 })

    expect(b.editor.graph.getNode(frameA.id as string)?.width).toBe(175)
  })
})

// ── undo 快照面 = 视图页（非冻结落点页）——已知缺口现状钉扎 ────────────────────
//
// 页快照的取材与还原双双跟随 editor.state.currentPageId（视图页）：
// snapshotPage 按当前视图页取子树，restorePageFromSnapshot 按执行 undo 时刻的
// 视图页查快照。而 AI 工具的落点页在 run 起始冻结（target.pageId），与视图页
// 是两个事实——run 中用户翻页后，冻结落点页上的 AI 改动不在撤销条目面内：
//  - 停在视图页 B 上 undo：还原的是 B 页快照（不含 A 页改动）→ A 页改动保留；
//  - 翻回落点页 A 再 undo：快照 Map 无 A 页条目 → 还原整体提前返回（no-op）。
// 常规场景（落点页 == 视图页）两事实同页故正确——同页基线由上方各用例覆盖。
// 已知缺口，按现状钉扎；修法（快照面改用冻结落点页）待拍板，拍板后本组用例
// 应随新语义改写。
// 钉扎的偶发耦合面（2026-10-01 独立 review P2-3）：①测试 2 前提依赖
// withAIUndo 无「前后快照相等不压栈」闸门——未来加空条目优化会让测试 2
// 弹出 create 条目而变红，红因与所钉缺口无关；②只修快照侧不修还原侧时
// 测试 1 在视图页 undo 仍查不到快照 → no-op 半修无红灯——修缺口须两侧同修。

describe('undo 快照面 = 视图页（冻结落点页改动不在撤销面）现状钉扎', () => {
  test('用户翻页后，冻结落点页上的 AI 改动不随 undo 撤销', async () => {
    const b = setupBridgeMultiPage()

    // 落点冻结 = pageA（target.pageId）；AI 在落点页建节点（此刻视图页仍 = pageA）
    const created = await b.callTool('create_shape', {
      type: 'RECTANGLE',
      parent_id: b.pageA,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      name: 'Card'
    })
    const nodeId = created.id as string

    // 用户翻页：视图页 → pageB（快照面跟随视图页）
    b.editor.state.currentPageId = b.pageB

    // AI 按 id 直改落点页节点：执行面钉在 pageA，快照面停在 pageB
    await b.callTool('rename_node', { id: nodeId, name: 'AI Renamed' })
    expect(b.editor.graph.getNode(nodeId)?.name).toBe('AI Renamed')

    // undo：撤销条目 inverse 还原的是「快照时刻的视图页」= pageB——落点页改动不在撤销面
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(nodeId)?.name).toBe('AI Renamed')
  })

  test('翻回落点页再 undo：快照无该页条目，还原 no-op（改动依旧保留）', async () => {
    const b = setupBridgeMultiPage()

    const created = await b.callTool('create_shape', {
      type: 'RECTANGLE',
      parent_id: b.pageA,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      name: 'Card'
    })
    const nodeId = created.id as string

    b.editor.state.currentPageId = b.pageB
    await b.callTool('rename_node', { id: nodeId, name: 'AI Renamed' })

    // 翻回落点页后 undo：还原按执行时刻视图页（pageA）查快照 Map——无条目即
    // 整体提前返回，落点页零改动
    b.editor.state.currentPageId = b.pageA
    b.editor.undo.undo()
    expect(b.editor.graph.getNode(nodeId)?.name).toBe('AI Renamed')
  })
})
