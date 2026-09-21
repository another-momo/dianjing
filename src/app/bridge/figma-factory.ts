import { FigmaAPI } from '@open-pencil/core/figma-api'

import type { EditorStore } from '@/app/editor/active-store'
import { listFamilies, listFonts } from '@/app/editor/fonts'

export function makeFigmaFromStore(
  store: EditorStore,
  pageId = store.state.currentPageId
): FigmaAPI {
  const api = new FigmaAPI(store.graph, {
    // 接通 viewport 断头路（仓外 docs/202609201112-viewport-focus-dead-path-review.md
    // §5 方案 A）：工具经 FigmaAPI 写的 viewport 在此回写编辑器 store——center/zoom →
    // panX/panY 是下方 seed 的逆变换。bridge 为浏览器上下文，恒有 window。
    onViewportChange: ({ center, zoom }) => {
      store.state.panX = window.innerWidth / 2 - center.x * zoom
      store.state.panY = window.innerHeight / 2 - center.y * zoom
      store.state.zoom = zoom
      store.requestRepaint()
    }
  })
  api.setRenderer(store.renderer ?? null)
  api.currentPage = api.wrapNode(pageId)
  api.currentPage.selection = [...store.state.selectedIds]
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
