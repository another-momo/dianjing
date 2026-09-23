import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import type { SkiaRenderer } from '#core/canvas/renderer'
import {
  COMPONENT_LABEL_FONT_SIZE,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  LABEL_FONT_SIZE,
  SECTION_TITLE_FONT_SIZE,
  SIZE_FONT_SIZE
} from '#core/constants'
import { fontManager } from '#core/text/fonts'
import type { FontManager } from '#core/text/fonts'
import { prepareGraphFonts } from '#core/text/prepare'
import {
  fontCoverageDemand,
  fontResolver,
  missingGlyphsByScript,
  type MissingGlyphOccurrence,
  type FontResolutionSnapshot
} from '#core/text/resolver'

export function resolveLabelFontCoverage(
  r: Pick<SkiaRenderer, 'isDestroyed' | 'onFontResolutionSettled'>,
  missing: readonly MissingGlyphOccurrence[],
  resolver = fontResolver
): void {
  if (r.isDestroyed()) return
  for (const [script, characters] of missingGlyphsByScript(missing)) {
    const demand = fontCoverageDemand(script, characters)
    const state = resolver.state(demand).state
    if (state === 'loaded') resolver.exhaust(demand)
    else if (state === 'idle' || state === 'loading') {
      // No fake TEXT node: the shared settlement callback refreshes font generation and repaints.
      void resolver.demand(demand, r.onFontResolutionSettled)
    }
  }
}

export function syncFontGeneration(r: SkiaRenderer): void {
  r.fontGeneration = fontManager.generation()
}

export function trackFontDemand(r: SkiaRenderer, node: SceneNode, key: string): void {
  const pending = r.pendingFontNodes.get(node.id) ?? { node, keys: new Set<string>() }
  pending.node = node
  pending.keys.add(key)
  r.pendingFontNodes.set(node.id, pending)
}

interface TextPictureGenerationState {
  fontGeneration: number
  textPictureGenerations: Map<string, { data: Uint8Array; generation: number }>
}

export function isTextPictureCurrent(r: TextPictureGenerationState, node: SceneNode): boolean {
  const data = node.textPicture
  if (!data) {
    r.textPictureGenerations.delete(node.id)
    return false
  }
  const cached = r.textPictureGenerations.get(node.id)
  if (!cached || cached.data !== data) {
    r.textPictureGenerations.set(node.id, { data, generation: r.fontGeneration })
    return true
  }
  return cached.generation === r.fontGeneration
}

function settleFontDemand(
  r: SkiaRenderer,
  snapshot: FontResolutionSnapshot,
  nodeIds: readonly string[]
): void {
  syncFontGeneration(r)
  for (const nodeId of nodeIds) {
    const pending = r.pendingFontNodes.get(nodeId)
    if (pending) {
      pending.node.textPicture = null
      pending.keys.delete(snapshot.key)
      if (pending.keys.size === 0) r.pendingFontNodes.delete(nodeId)
    }
    r.textPictureGenerations.delete(nodeId)
    r.invalidateNodePicture(nodeId)
  }
  maybeCompactFontProvider(r)
}

/**
 * provider 压实阈值（WASM 侧注册字节）。TypefaceFontProvider 没有 unregister：
 * 逐出/重载循环产生的死副本在 WASM 线性内存里单调累积，wasm32 天花板 4GB，
 * 撞线即 RuntimeError 或渲染进程被杀（dev 轮 4 实测注册字节 4070MB 撞线）。
 * 1536MB 触发压实，给 surface/glyph/picture 等非字体分配留 2.5GB 余量。
 */
export const PROVIDER_COMPACTION_THRESHOLD_BYTES = 1536 * 1024 * 1024

type FontProviderHost = Pick<
  SkiaRenderer,
  'ck' | 'fontProvider' | 'fontGeneration' | 'isDestroyed' | 'invalidateAllPictures'
>

type FontProviderRegistrar = Pick<
  FontManager,
  'attachProvider' | 'detachProvider' | 'providerRegisteredBytes' | 'generation'
>

/**
 * provider 压实：新建 TypefaceFontProvider 并回放存活字体集（attachProvider 的
 * 全量重注册语义），旧 provider 整体 delete——其持有的全部 WASM 字体副本（含
 * 已逐出字体的死注册）随 C++ 对象释放。两处 paragraph 缓存按 provider 同一性
 * 自清（provider !== this.provider 分支），fontGeneration 跳变使 textPicture
 * 失效重排，存活字形在下次排版时对新 provider 重建。
 */
export function compactFontProvider(
  r: FontProviderHost,
  manager: FontProviderRegistrar = fontManager
): boolean {
  if (r.isDestroyed() || !r.fontProvider) return false
  const beforeBytes = manager.providerRegisteredBytes()
  const stale = r.fontProvider
  r.fontProvider = r.ck.TypefaceFontProvider.Make()
  manager.attachProvider(r.ck, r.fontProvider)
  manager.detachProvider(stale)
  stale.delete()
  r.fontGeneration = manager.generation()
  r.invalidateAllPictures()
  // watcher 经 console 订阅对齐压实时刻与水表曲线（崩溃归因取证）
  console.debug(
    `[font-provider] compacted WASM registrations: ${Math.round(beforeBytes / 1048576)}MB -> ${Math.round(manager.providerRegisteredBytes() / 1048576)}MB`
  )
  return true
}

/**
 * 注册字节超阈值才压实。压实后水位降到存活集大小——天然回差，不会在阈值线
 * 上反复压实；存活集自身超阈值时压实退化为每次结算一次全量回放（正确性不变）。
 */
export function maybeCompactFontProvider(
  r: FontProviderHost,
  manager: FontProviderRegistrar = fontManager,
  thresholdBytes = PROVIDER_COMPACTION_THRESHOLD_BYTES
): boolean {
  if (manager.providerRegisteredBytes() <= thresholdBytes) return false
  return compactFontProvider(r, manager)
}

export function getFontProvider(r: SkiaRenderer) {
  return r.isDestroyed() || !r.fontProvider ? null : r.fontProvider
}

export async function loadFonts(
  r: SkiaRenderer,
  onFallbackFontsLoaded?: () => void
): Promise<void> {
  if (r.isDestroyed()) return
  r.onFontResolutionSettled = (snapshot, nodeIds) => {
    if (r.isDestroyed()) return
    settleFontDemand(r, snapshot, nodeIds)
    onFallbackFontsLoaded?.()
  }
  r.fontProvider?.delete()
  r.fontProvider = r.ck.TypefaceFontProvider.Make()

  fontManager.attachProvider(r.ck, r.fontProvider)
  syncFontGeneration(r)

  const fontData = await fontManager.loadFont(DEFAULT_FONT_FAMILY, 'Regular')
  if (r.isDestroyed()) return
  if (fontData) {
    const typeface = r.ck.Typeface.MakeFreeTypeFaceFromData(fontData)
    if (typeface) {
      r.textFont?.delete()
      r.labelFont?.delete()
      r.sizeFont?.delete()
      r.sectionTitleFont?.delete()
      r.componentLabelFont?.delete()
      r.textFont = new r.ck.Font(typeface, DEFAULT_FONT_SIZE)
      r.labelFont = new r.ck.Font(typeface, LABEL_FONT_SIZE)
      r.sizeFont = new r.ck.Font(typeface, SIZE_FONT_SIZE)
      r.sectionTitleFont = new r.ck.Font(typeface, SECTION_TITLE_FONT_SIZE)
      r.componentLabelFont = new r.ck.Font(typeface, COMPONENT_LABEL_FONT_SIZE)
      r.profiler.setTypeface(typeface)
    }
    r.fontMgr = r.ck.FontMgr.FromData(fontData) ?? null
  }

  // T98：恢复启动期 CJK/Arabic 预加载（T88 随上游回退失去的语义）——上游
  // loadFonts 只装 Inter；label 走 labelParagraphCache → fontProvider 字形
  // 回退，而需求触发链（trackFontDemand）只挂在 text 节点布局上，label 无
  // 入口。不预装 PuHuiTi/Noto Naskh Arabic 进 provider，CJK 标签首渲染即
  // tofu 且永不自愈（A2 NOTES §3 闸门 1 前提）。须在 fontsLoaded/syncFontGeneration
  // 终态前完成注册，保证 paragraph-cache 见到的 generation 覆盖本次注册。
  if (!r.isDestroyed()) await fontManager.ensureFallbackPack()

  r.fontsLoaded = true
  syncFontGeneration(r)
  r.invalidateAllPictures()
}

export async function prepareForExport(
  r: SkiaRenderer,
  graph: SceneGraph,
  pageId: string,
  nodeIds: string[]
): Promise<() => void> {
  const { getTextMeasurer, setTextMeasurer, computeAllLayouts } = await import('#core/layout')

  const previousTextMeasurer = getTextMeasurer()
  setTextMeasurer((node, maxWidth) => r.measureTextNode(node, maxWidth))

  await prepareGraphFonts(graph, nodeIds)
  syncFontGeneration(r)
  computeAllLayouts(graph, pageId)

  return () => setTextMeasurer(previousTextMeasurer)
}
