import { createEditor, type Editor } from '@open-pencil/core/editor'
import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import { loadFont } from '@/app/editor/fonts'
import type { EditorPreparationHandle as DocumentLoadSession } from '@/app/editor/preparation/types'

// docUuid 图替换 merge 保留（2026-09-30 方案定稿）：import 管线每次导入全新建图、
// 根 pluginData 按文件内容整段重写——已铸未落盘的 docUuid 会随旧图静默丢弃，
// page-state / 会话族索引成孤儿，下次发送重铸新 uuid 即二次初始化（落点重锚、
// 规制回缺省、会话历史断层）。三态规则：导入自带 → 导入胜不动（文件持久身份
// 优先）；导入缺 + 旧图有 → 旧值 append 保留；双缺 → no-op。
// 命名空间字符串与 ai/pi-backend document-key 同源；document/io 层取裸字符串
// 先例，不反向引 ai 域模块（避免跨域依赖）。
const PI_DOC_NAMESPACE = 'openpencil.ai'
const PI_DOC_ENTRY_KEY = 'openpencil.ai/docId'

function preserveDocUuidAcrossGraphReplace(live: SceneGraph, imported: SceneGraph): void {
  const liveDocUuid = live
    .getNode(live.rootId)
    ?.pluginData.find(
      (entry) => entry.pluginId === PI_DOC_NAMESPACE && entry.key === PI_DOC_ENTRY_KEY
    )
  if (!liveDocUuid) return
  const importedRoot = imported.getNode(imported.rootId)
  if (!importedRoot) return
  const importedHasDocUuid = importedRoot.pluginData.some(
    (entry) => entry.pluginId === PI_DOC_NAMESPACE && entry.key === PI_DOC_ENTRY_KEY
  )
  if (importedHasDocUuid) return
  imported.updateNode(imported.rootId, {
    pluginData: [...importedRoot.pluginData, { ...liveDocUuid }]
  })
}

export async function applyImportedDocument(
  editor: Editor,
  imported: SceneGraph,
  load?: DocumentLoadSession
) {
  const firstPage = imported.getPages()[0] as SceneNode | undefined
  const pageId = firstPage?.id ?? imported.rootId
  const stagingEditor = createEditor({
    graph: imported,
    loadFont,
    skipInitialGraphSetup: true
  })
  try {
    load?.update({ phase: 'populating-page', detail: firstPage?.name ?? null })
    const prepared = await stagingEditor.preparePage(pageId, {
      signal: load?.signal,
      onProgress: (progress) => load?.update(progress)
    })
    load?.signal.throwIfAborted()
    if (!prepared) throw new Error('Imported page preparation was superseded')

    preserveDocUuidAcrossGraphReplace(editor.graph, imported)
    editor.replaceGraph(imported)
    editor.undo.clear()
    editor.clearSelection()
  } finally {
    stagingEditor.dispose()
  }
}
