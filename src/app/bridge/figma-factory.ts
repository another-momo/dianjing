import { FigmaAPI } from '@open-pencil/core/figma-api'
import type { SceneGraph } from '@open-pencil/scene-graph'

import type { EditorStore } from '@/app/editor/active-store'
import { listFamilies, listFonts } from '@/app/editor/fonts'

/** 节点是否在指定页内——经 parent 链向上走直至 pageId 命中或抵达根。
 *  选中种进 facade 前过滤：用户在 Y 页选中、agent 在 X 页施工时，Y 页选区
 *  不应被种进 X 页 API（裸 id 在 X 页图里要么悬空要么错指同名节点）。 */
function nodeBelongsToPage(graph: SceneGraph, nodeId: string, pageId: string): boolean {
  const visited = new Set<string>()
  let current: string | undefined = nodeId
  while (current && !visited.has(current)) {
    visited.add(current)
    if (current === pageId) return true
    const node = graph.getNode(current)
    if (!node) return false
    current = node.parentId
  }
  return false
}

export function makeFigmaFromStore(
  store: EditorStore,
  pageId = store.state.currentPageId
): FigmaAPI {
  const api = new FigmaAPI(store.graph, {
    // 接通 viewport 断头路（仓外 docs/202609201112-viewport-focus-dead-path-review.md
    // §5 方案 A）：工具经 FigmaAPI 写的 viewport 在此回写编辑器 store——center/zoom →
    // panX/panY 是下方 seed 的逆变换。bridge 为浏览器上下文，恒有 window。
    // §7.3 视图层补洞：viewport 写回守卫——仅当 facade 钉页与用户实时视角一致
    // 时生效。agent 跨页施工期间 viewport 工具不可拽走用户浏览视角（落点 ≠
    // 视图页 = 用户在看别处，tooling 写 viewport 不动 store）。
    onViewportChange: ({ center, zoom }) => {
      if (pageId !== store.state.currentPageId) return
      store.state.panX = window.innerWidth / 2 - center.x * zoom
      store.state.panY = window.innerHeight / 2 - center.y * zoom
      store.state.zoom = zoom
      store.requestRepaint()
    }
  })
  api.setRenderer(store.renderer ?? null)
  api.currentPage = api.wrapNode(pageId)
  // §7.3 视图层补洞：selection 种子过滤到目标页。pageId 与节点 parent 链
  // 不一致（用户在别页选中、agent 在本页施工）的 id 一律剔除，避免跨页污染。
  api.currentPage.selection = [...store.state.selectedIds]
    .filter((id) => nodeBelongsToPage(store.graph, id, pageId))
    .map((id) => api.getNodeById(id))
    .filter((n): n is NonNullable<typeof n> => n !== null)
  api.viewport = {
    center: {
      x: (-store.state.panX + window.innerWidth / 2) / store.state.zoom,
      y: (-store.state.panY + window.innerHeight / 2) / store.state.zoom
    },
    zoom: store.state.zoom
  }
  api.exportImage = (nodeIds, opts) =>
    store.renderExportImage(
      nodeIds,
      opts.scale ?? 1,
      opts.format ?? 'PNG',
      undefined,
      opts.quality,
      {
        renderInContext: opts.renderInContext,
        clip: opts.clip
      }
    )
  api.listAvailableFontsAsync = async () => {
    const [systemFonts, familyOptions] = await Promise.all([listFonts(), listFamilies()])
    const fonts = systemFonts.flatMap(({ family, styles }) =>
      styles.map((style) => ({ fontName: { family, style } }))
    )
    const seenFamilies = new Set(systemFonts.map(({ family }) => family))
    for (const { family } of familyOptions) {
      if (!seenFamilies.has(family)) fonts.push({ fontName: { family, style: 'Regular' } })
    }
    return fonts
  }
  return api
}
