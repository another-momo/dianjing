import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createEditor } from '@open-pencil/core/editor'
import { SceneGraph } from '@open-pencil/scene-graph'

import {
  PI_DOC_ENTRY_KEY as DOC_KEY_ENTRY_KEY,
  PI_DOC_NAMESPACE as DOC_KEY_NAMESPACE
} from '@/app/ai/pi-backend/document-key'
import {
  applyImportedDocument,
  PI_DOC_ENTRY_KEY as IO_ENTRY_KEY,
  PI_DOC_NAMESPACE as IO_NAMESPACE
} from '@/app/document/io/imported-document'
import { createEditorPreparationController } from '@/app/editor/preparation/controller'
import { createInitialAppEditorState } from '@/app/editor/session/types'

test('cancelled imported-document staging preserves the live graph', async () => {
  const liveGraph = new SceneGraph()
  const liveEditor = createEditor({ graph: liveGraph, skipInitialGraphSetup: true })
  const imported = new SceneGraph()
  const importedPage = imported.getPages()[0]
  if (!importedPage) throw new Error('Expected imported page')
  imported.updateNode(importedPage.id, { name: 'Imported' })
  const controller = createEditorPreparationController(
    createInitialAppEditorState(liveGraph.rootId)
  )
  const preparation = controller.begin({ kind: 'document-open' })
  preparation.cancel()

  await expect(applyImportedDocument(liveEditor, imported, preparation)).rejects.toHaveProperty(
    'name',
    'AbortError'
  )
  expect(liveEditor.graph).toBe(liveGraph)
  liveEditor.dispose()
})

test('prepared imported documents replace the live graph only after staging', async () => {
  const liveGraph = new SceneGraph()
  const liveEditor = createEditor({ graph: liveGraph, skipInitialGraphSetup: true })
  const imported = new SceneGraph()
  const page = imported.getPages()[0]
  if (!page) throw new Error('Expected imported page')
  imported.updateNode(page.id, { name: 'Imported' })

  await applyImportedDocument(liveEditor, imported)

  expect(liveEditor.graph).toBe(imported)
  expect(liveEditor.state.currentPageId).toBe(page.id)
  liveEditor.dispose()
})

// docUuid 图替换 merge 保留三态矩阵（2026-09-30 方案定稿）：导入自带不动 /
// 导入缺 + 旧图有 → 保留 / 双缺 no-op——已铸未落盘的 docUuid 挺过图替换，
// page-state 与会话族不再成孤儿。
const DOC_NAMESPACE = 'openpencil.ai'
const DOC_ENTRY_KEY = 'openpencil.ai/docId'

function setRootDocUuid(graph: SceneGraph, value: string): void {
  graph.updateNode(graph.rootId, {
    pluginData: [{ pluginId: DOC_NAMESPACE, key: DOC_ENTRY_KEY, value }]
  })
}

function readRootDocUuid(graph: SceneGraph): string | null {
  return (
    graph
      .getNode(graph.rootId)
      ?.pluginData.find((entry) => entry.pluginId === DOC_NAMESPACE && entry.key === DOC_ENTRY_KEY)
      ?.value ?? null
  )
}

function makeImportedGraph(): SceneGraph {
  const imported = new SceneGraph()
  const page = imported.getPages()[0]
  if (!page) throw new Error('Expected imported page')
  imported.updateNode(page.id, { name: 'Imported' })
  return imported
}

test('graph replace preserves the live docUuid when the imported graph lacks one', async () => {
  const liveGraph = new SceneGraph()
  setRootDocUuid(liveGraph, 'live-doc-uuid')
  const liveEditor = createEditor({ graph: liveGraph, skipInitialGraphSetup: true })
  const imported = makeImportedGraph()

  await applyImportedDocument(liveEditor, imported)

  expect(liveEditor.graph).toBe(imported)
  expect(readRootDocUuid(liveEditor.graph)).toBe('live-doc-uuid')
  liveEditor.dispose()
})

test('imported graph docUuid wins over the live one (file persisted identity first)', async () => {
  const liveGraph = new SceneGraph()
  setRootDocUuid(liveGraph, 'live-doc-uuid')
  const liveEditor = createEditor({ graph: liveGraph, skipInitialGraphSetup: true })
  const imported = makeImportedGraph()
  setRootDocUuid(imported, 'file-doc-uuid')

  await applyImportedDocument(liveEditor, imported)

  expect(liveEditor.graph).toBe(imported)
  expect(readRootDocUuid(liveEditor.graph)).toBe('file-doc-uuid')
  liveEditor.dispose()
})

test('graph replace is a no-op for docUuid when neither graph has one', async () => {
  const liveGraph = new SceneGraph()
  const liveEditor = createEditor({ graph: liveGraph, skipInitialGraphSetup: true })
  const imported = makeImportedGraph()

  await applyImportedDocument(liveEditor, imported)

  expect(liveEditor.graph).toBe(imported)
  expect(readRootDocUuid(liveEditor.graph)).toBeNull()
  expect(imported.getNode(imported.rootId)?.pluginData).toEqual([])
  liveEditor.dispose()
})

// docUuid 命名空间两侧常量（ai/pi-backend document-key 与 document/io 本档）
// 同值异点不互相 import——改名漂移在此拦截：两侧各自等于字面量且彼此相等。
test('docUuid namespace constants match across document-key and imported-document', () => {
  expect(IO_NAMESPACE).toBe('openpencil.ai')
  expect(IO_ENTRY_KEY).toBe('openpencil.ai/docId')
  expect(DOC_KEY_NAMESPACE).toBe('openpencil.ai')
  expect(DOC_KEY_ENTRY_KEY).toBe('openpencil.ai/docId')
  expect(DOC_KEY_NAMESPACE).toBe(IO_NAMESPACE)
  expect(DOC_KEY_ENTRY_KEY).toBe(IO_ENTRY_KEY)
})

// 桥视图探针 eval 片段（active-design-host.ts）内嵌同值字面量——条目以自命名
// 空间编码形存储（getSharedPluginData 传命名空间 + 短键 'docId'），eval 内无法
// 引 TS 常量，改以源码文本钉扎：字面量漂移即红。
test('bridge view probe eval pins the docUuid namespace and key literals', () => {
  const probeSourcePath = join(
    import.meta.dir,
    '../../../../../src/app/ai/pi-backend/active-design-host.ts'
  )
  const probeSource = readFileSync(probeSourcePath, 'utf8')
  expect(probeSource).toContain("getSharedPluginData('openpencil.ai', 'docId')")
})
