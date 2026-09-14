import { renderTreeNode } from '@open-pencil/core/design-jsx'
import type { FigmaAPI } from '@open-pencil/core/figma-api'
import { computeAllLayouts } from '@open-pencil/core/layout'
import { ALL_TOOLS, registerComponentCatalog } from '@open-pencil/core/tools'
import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import type { JSONObject } from '@open-pencil/scene-graph/primitives'

import type { AutomationTarget } from '@/app/bridge/target'
import { ensureGraphFonts } from '@/app/editor/fonts'
import { useLibraryService } from '@/app/libraries'

type FigmaFactory = (store: AutomationTarget['store'], pageId?: string) => FigmaAPI

/**
 * T59（S3 §9 undo burst / PD-19）：一个 AI 回合的 mutating 调用按设计区合并
 * 撤销单元。机制：pi service 在回合开始/结束各发一次 `undo_group` begin/end
 * 边界信号；组打开期间 withAIUndo 的撤销条目携带
 * `ai-burst:<documentId>:<turnSeq>:<zoneKey>` coalesceKey，复用 UndoManager
 * 既有 coalesce 合并（undo.ts pushUndoEntry：同 key 相邻条目合并为首 inverse
 * + 末 forward——opacity 滑杆同款先例）：
 *  - 同回合同区连续 mutating → 净增 1 撤销单元；组键（区）变化 → 先闭旧组
 *    开新组（等价于合并链断裂，新条目自立）
 *  - 用户手动编辑的条目无 coalesceKey → 天然截断合并链，用户编辑不被吞并
 *  - 悬挂组失效安全：组状态只是「当前回合号 + 标签簿」，不持有快照/缓冲；
 *    回合异常（end 丢失）时下个 begin 直接覆盖（turnSeq 递增即旧组作废），
 *    下个非组编辑动作（无 key 条目入栈）即截断合并链——无悬挂打开组可残留
 *  - 无 begin 的来源（MCP/CLI）组不存在 → 条目不带 key，行为与 T21 原样
 *
 * 组键 = documentId + 设计区根 id：从工具参数涉及的节点向上解析顶层根
 * frame（T60 宿主路由未落地前的层级推导）；无节点参数的 mutating 工具落
 * 文档级默认组 'document'。
 */
type AITurnGroup = {
  turnKey: string
  /** zone → 首工具名/合并计数（label 沿 `AI: <首工具名> +N more` 形态） */
  zones: Map<string, { firstTool: string; count: number }>
}

/** 节点 → 其设计区根（顶层根 frame = CANVAS 直属子）；页本身/游离节点 → null */
function topLevelZoneRootId(graph: SceneGraph, nodeId: string): string | null {
  let node: SceneNode | undefined = graph.getNode(nodeId)
  if (!node || node.type === 'CANVAS') return null
  // 循环内 node 恒真（parent 缺失/到页即返回）——type-aware 门禁钉住，勿加回条件
  for (;;) {
    const parent: SceneNode | undefined = node.parentId ? graph.getNode(node.parentId) : undefined
    if (!parent) return null
    if (parent.type === 'CANVAS') return node.id
    node = parent
  }
  return null
}

/** 工具参数浅扫描：字符串/字符串数组值中能在图里命中的节点 id（ParamDef
 * 类型域无嵌套对象，浅扫足够；名字/颜色等字面量 getNode 不中即跳过） */
function collectArgNodeIds(args: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (const value of Object.values(args)) {
    if (typeof value === 'string') ids.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') ids.push(item)
    }
  }
  return ids
}

function resolveZoneRootId(graph: SceneGraph, candidateIds: string[]): string | null {
  for (const id of candidateIds) {
    const rootId = topLevelZoneRootId(graph, id)
    if (rootId) return rootId
  }
  return null
}

async function withAIUndo<T>(
  store: AutomationTarget['store'],
  documentId: string,
  group: AITurnGroup | undefined,
  toolName: string,
  toolArgs: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  // 参数侧区键必须在执行前解析（delete 类工具执行后节点已不在图里）
  const argZoneRootId = group ? resolveZoneRootId(store.graph, collectArgNodeIds(toolArgs)) : null
  const before = store.snapshotPage()
  const result = await fn()
  const after = store.snapshotPage()

  let label = `AI: ${toolName}`
  let coalesceKey: string | undefined
  if (group) {
    // 结果侧补解析（create/render 顶层新建：新节点自身即区根，执行前不可知）
    const zoneRootId = argZoneRootId ?? resolveZoneRootId(store.graph, extractNodeIds(result))
    const zoneKey = zoneRootId ?? 'document'
    const stat = group.zones.get(zoneKey)
    if (stat) {
      stat.count += 1
      label = `AI: ${stat.firstTool} +${stat.count - 1} more`
    } else {
      group.zones.set(zoneKey, { firstTool: toolName, count: 1 })
    }
    coalesceKey = `ai-burst:${documentId}:${group.turnKey}:${zoneKey}`
  }

  store.pushUndoEntry({
    label,
    forward: () => store.restorePageFromSnapshot(after),
    inverse: () => store.restorePageFromSnapshot(before),
    ...(coalesceKey ? { coalesceKey } : {})
  })
  return result
}

export function createAutomationToolHandler(makeFigma: FigmaFactory) {
  // 组状态存活期 = 回合：按文档各一份（undo 栈本就按 tab/文档独立）
  const turnSeqByDocument = new Map<string, number>()
  const openGroupByDocument = new Map<string, AITurnGroup>()

  async function handleUndoGroup(target: AutomationTarget, args: unknown): Promise<unknown> {
    const action = (args as { action?: unknown } | null)?.action
    if (action === 'begin') {
      const seq = (turnSeqByDocument.get(target.documentId) ?? 0) + 1
      turnSeqByDocument.set(target.documentId, seq)
      // 悬挂组自闭合：上个回合 end 丢失时本次 begin 直接覆盖旧组（无快照可泄）
      openGroupByDocument.set(target.documentId, { turnKey: `turn-${seq}`, zones: new Map() })
      return { ok: true, result: { turn: seq } }
    }
    if (action === 'end') {
      openGroupByDocument.delete(target.documentId)
      return { ok: true, result: { closed: true } }
    }
    throw new Error('undo_group requires args.action "begin" or "end"')
  }

  async function handleToolRender(
    target: AutomationTarget,
    toolArgs: Record<string, unknown>
  ): Promise<unknown> {
    const store = target.store
    const tree = toolArgs.tree as Parameters<typeof renderTreeNode>[1]
    const result = await withAIUndo(
      store,
      target.documentId,
      openGroupByDocument.get(target.documentId),
      'render',
      toolArgs,
      () =>
        renderTreeNode(store.graph, tree, {
          parentId: (toolArgs.parent_id as string | undefined) ?? target.pageId,
          x: toolArgs.x as number | undefined,
          y: toolArgs.y as number | undefined
        })
    )
    await ensureGraphFonts(store.graph, [result.id], store.renderer)
    computeAllLayouts(store.graph, target.pageId)
    store.requestRender()
    store.flashNodes([result.id])
    return {
      ok: true,
      result: { id: result.id, name: result.name, type: result.type, children: result.childIds }
    }
  }

  async function handleTool(target: AutomationTarget, args: unknown): Promise<unknown> {
    const toolName = (args as { name?: string }).name
    const toolArgs = (args as { args?: Record<string, unknown> }).args ?? {}
    if (!toolName) throw new Error('Missing "name" in args')

    if (toolName === 'render' && toolArgs.tree) {
      return handleToolRender(target, toolArgs)
    }

    const def = ALL_TOOLS.find((t) => t.name === toolName)
    if (!def) throw new Error(`Unknown tool: ${toolName}`)
    const store = target.store
    const libraryService = useLibraryService()
    libraryService.bindEditor(store)
    registerComponentCatalog(store.graph, libraryService)
    const figma = makeFigma(store, target.pageId)
    const execute = () => Promise.resolve(def.execute(figma, toolArgs))
    const result = def.mutates
      ? await withAIUndo(
          store,
          target.documentId,
          openGroupByDocument.get(target.documentId),
          toolName,
          toolArgs,
          execute
        )
      : await execute()

    if (def.mutates) {
      const pageNode = store.graph.getNode(figma.currentPageId)
      if (pageNode) await ensureGraphFonts(store.graph, pageNode.childIds, store.renderer)
      computeAllLayouts(store.graph, figma.currentPageId)
      store.requestRender()
      store.flashNodes(extractNodeIds(result))
    }
    return { ok: true, result }
  }

  return { handleTool, handleUndoGroup }
}

function extractNodeIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') return []
  const obj = result as JSONObject
  if (typeof obj.deleted === 'string') return []
  const ids: string[] = []
  if (typeof obj.id === 'string') ids.push(obj.id)
  if (Array.isArray(obj.results)) {
    for (const item of obj.results) {
      if (item && typeof item === 'object' && typeof (item as JSONObject).id === 'string')
        ids.push((item as JSONObject).id as string)
    }
  }
  return ids
}
