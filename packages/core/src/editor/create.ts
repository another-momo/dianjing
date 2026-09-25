import type { CanvasKit } from 'canvaskit-wasm'
import { createNanoEvents } from 'nanoevents'
import type { Emitter } from 'nanoevents'

import { SceneGraph } from '@open-pencil/scene-graph'
import type { SceneNode } from '@open-pencil/scene-graph'
import { UndoManager } from '@open-pencil/scene-graph/undo'

import type { SkiaRenderer } from '#core/canvas/renderer'
import { prefetchFigmaSchema } from '#core/clipboard'
import { hasWindowGlobal } from '#core/constants'
import { clearLazyFigImportContext } from '#core/kiwi/fig/lazy-import'
import { releaseFigPopulationWorker } from '#core/kiwi/fig/population/client'
import { releaseOriginalFigArchive } from '#core/kiwi/fig/session/original-archive'
import { computeAllLayouts, setTextMeasurer } from '#core/layout'
import { emitNavigationTrace } from '#core/profiler'
import { TextEditor } from '#core/text/editor'
import { fontManager } from '#core/text/fonts'
import { fontResolver } from '#core/text/resolver'

import { createAlignmentActions } from './alignment'
import { createClipboardBridge } from './bridges/clipboard'
import { createComponentBridge } from './bridges/components'
import { createStructureBridge } from './bridges/structure'
import { createUndoBridge } from './bridges/undo'
import { createClipboardActions } from './clipboard'
import { createColorSpaceActions } from './color-space'
import { createComponentSyncScheduler } from './component-sync'
import { createComponentActions } from './components'
import { createGraphEventSubscription } from './graph-events'
import { createGraphReadActions } from './graph-reads'
import { createGuideActions } from './guides'
import { createLayoutRunner } from './layout-runner'
import { createNodeActions } from './nodes'
import { createPageActions } from './pages'
import { createSelectionActions } from './selection'
import { createShapeActions } from './shapes'
import { createDefaultEditorState } from './state'
import { createStructureActions } from './structure'
import { createTextActions } from './text'
import { textAutoResizeChanges } from './text/auto-resize'
import type {
  EditorContext,
  EditorEventName,
  EditorEvents,
  EditorOptions,
  EditorState
} from './types'
import { createUndoActions } from './undo'
import { createVariableActions } from './variables'
import { createVectorizeActions } from './vectorize'
import { createViewportActions } from './viewport'

export { createDefaultEditorState } from './state'

export function createEditor(options?: EditorOptions) {
  let _graph = options?.graph ?? new SceneGraph()
  const skipInitialGraphSetup = options?.skipInitialGraphSetup ?? false
  const undo = new UndoManager({ onChange: () => emitEditorEvent('history:changed') })
  const _loadFont = options?.loadFont ?? fontManager.loadFont.bind(fontManager)
  const _getViewportSize =
    options?.getViewportSize ??
    (() => {
      if (hasWindowGlobal()) return { width: window.innerWidth, height: window.innerHeight }
      return { width: 800, height: 600 }
    })
  let _ck: CanvasKit | null = null
  let _renderer: SkiaRenderer | null = null
  const _renderers = new Set<SkiaRenderer>()
  const interactiveEdits = new Set<symbol>()
  let _textEditor: TextEditor | null = null
  const events: Emitter<EditorEvents> = createNanoEvents()
  // 字体异步装完后 layout 追排（2026-09-25）：settle 渲染链只刷新 picture（glyph
  // 自愈），apply 时回退度量产的节点宽高须随真实度量重算，否则滞留到下次
  // mutation。CDN 分片渐进加载会连发 settle，短防抖合批；整图重排覆盖跨页节点。
  let fontSettleRelayoutTimer: ReturnType<typeof setTimeout> | null = null
  const FONT_SETTLE_RELAYOUT_DEBOUNCE_MS = 50
  const scheduleFontSettleRelayout = () => {
    if (fontSettleRelayoutTimer !== null) return
    fontSettleRelayoutTimer = setTimeout(() => {
      fontSettleRelayoutTimer = null
      reflowAutoResizeTextAfterFontSettle()
      computeAllLayouts(_graph)
      requestRender()
    }, FONT_SETTLE_RELAYOUT_DEBOUNCE_MS)
  }

  // 页级文本的 auto-resize 不经 yoga（computeLayoutsBottomUp 只排 layoutMode≠'NONE'
  // 的框）——按真实度量重测宽高，仅在实际变化时写回（避免 settle 噪声刷 node:updated）。
  function reflowAutoResizeTextAfterFontSettle(): void {
    for (const page of _graph.getPages()) reflowAutoResizeTextInSubtree(page.id)
  }
  function reflowAutoResizeTextInSubtree(rootId: string): void {
    const node = _graph.getNode(rootId)
    if (!node) return
    if (
      node.type === 'TEXT' &&
      (node.textAutoResize === 'HEIGHT' || node.textAutoResize === 'WIDTH_AND_HEIGHT')
    ) {
      const resized = textAutoResizeChanges(node, { fontFamily: node.fontFamily })
      const widthChanged = resized.width !== undefined && resized.width !== node.width
      const heightChanged = resized.height !== undefined && resized.height !== node.height
      if (widthChanged || heightChanged) nodes.updateNode(node.id, resized)
    }
    for (const childId of node.childIds) reflowAutoResizeTextInSubtree(childId)
  }

  const stopFontResolutionEvents = fontResolver.subscribe((event, snapshot) => {
    events.emit('font:resolution-changed', event, snapshot)
    if (event === 'settled' && snapshot.state === 'loaded') scheduleFontSettleRelayout()
  })

  void prefetchFigmaSchema()

  const state: EditorState = options?.state ?? createDefaultEditorState(_graph.getPages()[0].id)

  function emitEditorEvent<K extends EditorEventName>(
    event: K,
    ...args: Parameters<EditorEvents[K]>
  ) {
    events.emit(event, ...args)
  }

  function onEditorEvent<K extends EditorEventName>(event: K, handler: EditorEvents[K]) {
    return events.on(event, handler)
  }

  function requestRender() {
    state.renderVersion++
    state.sceneVersion++
    emitNavigationTrace('render:requested', {
      kind: 'render',
      renderVersion: state.renderVersion,
      sceneVersion: state.sceneVersion
    })
    emitEditorEvent('render:requested', {
      renderVersion: state.renderVersion,
      sceneVersion: state.sceneVersion
    })
  }

  function requestRepaint() {
    state.renderVersion++
    emitNavigationTrace('render:requested', {
      kind: 'repaint',
      renderVersion: state.renderVersion,
      sceneVersion: state.sceneVersion
    })
    emitEditorEvent('repaint:requested', {
      renderVersion: state.renderVersion,
      sceneVersion: state.sceneVersion
    })
  }

  /** Track an actual live edit independently of history batching. Release is idempotent. */
  function beginInteractiveEdit() {
    const token = Symbol('interactive-edit')
    interactiveEdits.add(token)
    requestRepaint()
    return () => {
      if (interactiveEdits.delete(token)) requestRepaint()
    }
  }

  function setNavigationPhase(phase: EditorState['navigation']['phase'], inputAt = 0) {
    const previous = { ...state.navigation }
    const active = phase === 'pan' || phase === 'zoom' || phase === 'momentum'
    const wasActive =
      previous.phase === 'pan' || previous.phase === 'zoom' || previous.phase === 'momentum'
    state.navigation = {
      phase,
      generation: active && !wasActive ? previous.generation + 1 : previous.generation,
      lastInputAt: inputAt || previous.lastInputAt
    }
    if (
      state.navigation.phase !== previous.phase ||
      state.navigation.generation !== previous.generation ||
      state.navigation.lastInputAt !== previous.lastInputAt
    ) {
      emitNavigationTrace('navigation:phase', {
        phase: state.navigation.phase,
        previousPhase: previous.phase,
        generation: state.navigation.generation,
        lastInputAt: state.navigation.lastInputAt
      })
      emitEditorEvent('navigation:changed', state.navigation, previous)
    }
  }

  function setSelectedIds(ids: Set<string>) {
    const previous = [...state.selectedIds]
    state.selectedIds = ids
    if (ids.size === 0) state.measurementMode = 'off'
    const selected = [...ids]
    if (
      previous.length !== selected.length ||
      previous.some((id, index) => id !== selected[index])
    ) {
      emitEditorEvent('selection:changed', selected, previous)
    }
  }

  function setActiveTool(tool: EditorState['activeTool']) {
    const previous = state.activeTool
    state.activeTool = tool
    if (tool !== 'SELECT') state.measurementMode = 'off'
    if (previous !== tool) emitEditorEvent('tool:changed', tool, previous)
  }

  const graphReads = createGraphReadActions(() => _graph)
  const { runLayoutForNode, runMutationWithLayout } = createLayoutRunner(() => _graph)
  const { scheduleComponentSync } = createComponentSyncScheduler(() => _graph, requestRender)

  const { subscribeToGraph, unsubscribeFromGraph } = createGraphEventSubscription({
    getGraph: () => _graph,
    getRenderers: () => _renderers,
    scheduleComponentSync,
    requestRender,
    emitEditorEvent
  })

  if (!skipInitialGraphSetup) {
    subscribeToGraph()
  }

  // Build the shared context
  const ctx: EditorContext = {
    get graph() {
      return _graph
    },
    set graph(g) {
      _graph = g
    },
    undo,
    state,
    loadFont: _loadFont,
    resolveFigmaClipboardImages: options?.resolveFigmaClipboardImages ?? null,
    getViewportSize: _getViewportSize,
    getCk: () => _ck,
    getRenderer: () => _renderer,
    getTextEditor: () => _textEditor,
    requestRender,
    requestRepaint,
    beginInteractiveEdit,
    onEditorEvent,
    emitEditorEvent,
    setSelectedIds,
    setActiveTool,
    setNavigationPhase,
    runLayoutForNode,
    runMutationWithLayout,
    subscribeToGraph
  }

  // Assemble domain modules
  const viewport = createViewportActions(ctx)
  const selection = createSelectionActions(ctx)
  const pages = createPageActions(ctx)
  const guides = createGuideActions(ctx)
  const shapes = createShapeActions(ctx)
  const structure = createStructureActions(ctx)
  const components = createComponentActions(ctx)
  const clipboard = createClipboardActions(ctx)
  const colorSpace = createColorSpaceActions(ctx)
  const undoActions = createUndoActions(ctx)
  const text = createTextActions(ctx)
  const nodes = createNodeActions(ctx)
  const variables = createVariableActions(ctx)
  const vectorize = createVectorizeActions(ctx)
  const alignment = createAlignmentActions(ctx)
  const clipboardBridge = createClipboardBridge(clipboard, selection)
  const componentBridge = createComponentBridge(components, selection, structure, pages)
  const structureBridge = createStructureBridge(structure, selection)
  const undoBridge = createUndoBridge(undoActions, selection)

  function setCanvasKit(ck: CanvasKit, renderer: SkiaRenderer) {
    _ck = ck
    _renderer = renderer
    _renderers.add(renderer)
    _textEditor ??= new TextEditor(ck)
    setTextMeasurer(
      typeof renderer.measureTextNode === 'function'
        ? (node, maxWidth) => renderer.measureTextNode(node, maxWidth)
        : null
    )
  }

  function removeCanvasRenderer(renderer: SkiaRenderer) {
    _renderers.delete(renderer)
    if (_renderer === renderer) {
      _renderer = _renderers.values().next().value ?? null
    }
  }

  function replaceGraph(newGraph: SceneGraph) {
    nodes.cancelNodePreviews()
    undo.discardBatches()
    _graph = newGraph
    subscribeToGraph()
    const previousPageId = state.currentPageId
    state.currentPageId = _graph.getPages()[0]?.id ?? _graph.rootId
    setSelectedIds(new Set())
    state.hoveredNodeId = null
    state.measurementMode = 'off'
    state.snapGuides = []
    state.guides = { preview: null, hovered: null, selected: null, redline: null }
    state.layoutInsertIndicator = null
    state.dropTargetId = null
    pages.clearPageViewports()
    for (const renderer of _renderers) renderer.tiledScene.invalidateStructure()
    emitEditorEvent('graph:replaced', _graph)
    if (previousPageId !== state.currentPageId) {
      emitEditorEvent('page:changed', state.currentPageId, previousPageId)
    }
    requestRender()
  }

  function dispose() {
    nodes.cancelNodePreviews()
    interactiveEdits.clear()
    if (fontSettleRelayoutTimer !== null) clearTimeout(fontSettleRelayoutTimer)
    stopFontResolutionEvents()
    unsubscribeFromGraph()
  }

  function releaseGraphResources() {
    releaseFigPopulationWorker(_graph)
    releaseOriginalFigArchive(_graph)
    clearLazyFigImportContext(_graph)
  }

  return {
    get graph() {
      return _graph
    },
    get renderer() {
      return _renderer
    },
    get canvasRenderers() {
      return [..._renderers]
    },
    get textEditor() {
      return _textEditor
    },
    undo,
    state,

    // Graph reads
    runLayoutForNode,
    runMutationWithLayout,
    ...graphReads,

    // Lifecycle
    beginInteractiveEdit,
    isInteractiveEditing: () => interactiveEdits.size > 0,
    requestRender,
    requestRepaint,
    onEditorEvent,
    setCanvasKit,
    setNavigationPhase,
    removeCanvasRenderer,
    replaceGraph,
    subscribeToGraph,
    dispose,
    releaseGraphResources,

    // Selection
    ...selection,

    // Pages
    ...pages,

    // Canvas and frame guides
    ...guides,

    // Shapes & tools
    ...shapes,

    // Structure (group, reorder, reparent, z-order)
    ...structure,

    // Nodes (update, layout)
    ...nodes,

    // Alignment (align, flip, rotate)
    ...alignment,

    // Bitmap-to-vector replacement
    ...vectorize,

    // Variables
    ...variables,

    // Text editing
    ...text,

    // Viewport
    ...viewport,

    // Undo — bridge functions that need cross-module refs
    ...undoBridge,

    setDocumentColorSpace: colorSpace.setDocumentColorSpace,

    // Clipboard — bridge functions that need selectedNodes
    ...clipboardBridge,

    // Components — bridge functions
    ...componentBridge,

    // Structure — bridge functions that need selectedNodes
    ...structureBridge
  }
}

export type Editor = ReturnType<typeof createEditor>
