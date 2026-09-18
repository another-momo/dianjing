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
