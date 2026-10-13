import { ref } from 'vue'

import {
  collectGraphFontRequirements,
  fontManager,
  missingGraphFontScripts,
  type FontFamilyOption
} from '@open-pencil/core/text'
import type { SceneGraph } from '@open-pencil/scene-graph'

import {
  fetchInstalledFonts,
  readFontBytes,
  readInstalledSubsetPieces
} from '@/app/ai/pi-backend/client-fonts'

/**
 * 应用字体库（用户安装）变更信号（install / uninstall）。
 * picker 以本 ref 与 fontListRevision 共同作为 :key 重挂载触发器。
 */
export const userLibraryRevision = ref(0)
export const fontListRevision = ref(0)

/**
 * 应用字体库（用户安装）注入：把 client-fonts 适配成 UserFontProvider 接口。
 * core 域不直接访问 HTTP——本适配在 app 层完成。安装/卸载/加载均经此。
 * subset-collection 族由 readSubsetPieces 通路承载（read 端点 501）。
 */
fontManager.setUserFontProvider({
  list: fetchInstalledFonts,
  read: async (family, styleKey) => {
    try {
      return await readFontBytes(family, styleKey)
    } catch (e) {
      // subset-collection 族的 read 端点按设计返 501——探测即分流（紧接走
      // readSubsetPieces），非故障，不刷 warn；其余失败保留 warn。
      if (e instanceof Error && e.message.includes('subset-collection')) return null
      console.warn(`Installed font read failed for "${family}" (${styleKey}):`, e)
      return null
    }
  },
  readSubsetPieces: async ({ family, styleKey, style, characters }) => {
    try {
      return await readInstalledSubsetPieces(family, styleKey, characters)
    } catch (e) {
      console.warn(`Installed subset pieces read failed for "${family}" (${style}):`, e)
      return null
    }
  }
})

interface FontRenderInvalidator {
  invalidateAllPictures(): void
}

export async function ensureGraphFonts(
  graph: SceneGraph,
  nodeIds: string[],
  renderer?: FontRenderInvalidator | null
): Promise<boolean> {
  fontManager.blockNodesUntilFontsResolve(nodeIds)
  try {
    const generationBefore = fontManager.generation()
    const fontKeys = fontManager.collectFontKeys(graph, nodeIds)
    const requirements = collectGraphFontRequirements(graph, nodeIds)
    const { characters } = requirements
    await Promise.all(fontKeys.map(([family, style]) => loadFont(family, style, characters)))
    const fallbackScripts = missingGraphFontScripts(requirements)
    if (fallbackScripts.length > 0) {
      const fallbacks = await fontManager.ensureFallbackPack(fallbackScripts, characters)
      if (Object.values(fallbacks).some((families) => families.length > 0)) {
        clearTextPictures(graph, nodeIds)
      }
    } else if (fontManager.generation() !== generationBefore) {
      clearTextPictures(graph, nodeIds)
    }
    return fontManager.generation() !== generationBefore || fallbackScripts.length > 0
  } finally {
    fontManager.unblockNodes(nodeIds)
    renderer?.invalidateAllPictures()
  }
}

function clearTextPictures(graph: SceneGraph, nodeIds: string[]): void {
  const clear = (id: string) => {
    const node = graph.getNode(id)
    if (!node) return
    if (node.type === 'TEXT') node.textPicture = null
    for (const childId of node.childIds) clear(childId)
  }
  for (const id of nodeIds) clear(id)
}

export async function predownloadFallbackFonts() {
  return fontManager.ensureFallbackPack()
}

export async function loadFont(
  family: string,
  style = 'Regular',
  characters = '',
  signal?: AbortSignal
): Promise<ArrayBuffer | null> {
  return fontManager.loadFont(family, style, characters, signal)
}

export async function listFamilies(): Promise<FontFamilyOption[]> {
  return fontManager.listFamilyOptions()
}

export async function listAllFamilies(): Promise<FontFamilyOption[]> {
  return fontManager.listFamilyOptions()
}
