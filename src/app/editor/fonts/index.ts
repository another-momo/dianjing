import { useLocalStorage } from '@vueuse/core'
import { ref, watch } from 'vue'

import { hasWindowGlobal } from '@open-pencil/core/constants'
import {
  DEFAULT_WEB_FONT_PROVIDER_SETTINGS,
  WEB_FONT_PROVIDER_IDS,
  collectGraphFontRequirements,
  fontManager,
  missingGraphFontScripts,
  type FontFamilyOption,
  type LocalFontAccessState,
  type WebFontProviderId
} from '@open-pencil/core/text'
import type { SceneGraph } from '@open-pencil/scene-graph'

import { browserWebFontFetch } from '@/app/editor/fonts/browser-fetch'
import {
  clearDownloadedFontCache as clearTauriDownloadedFontCache,
  createTauriDownloadedFontCache,
  downloadedFontCacheSummary as tauriDownloadedFontCacheSummary
} from '@/app/editor/fonts/cache'
import { createCnFontPieceCache } from '@/app/editor/fonts/idb-cache'
import { isTauri } from '@/app/tauri/env'
import { tauriFetch } from '@/app/tauri/http'
import { IS_TAURI } from '@/constants'

if (typeof navigator !== 'undefined') {
  fontManager.setFallbackUserAgent(navigator.userAgent)
}

export type FontProviderSettings = Record<WebFontProviderId, boolean>

export const onlineFontsEnabled = useLocalStorage('op-online-fonts-enabled', true)
export const fontProviderSettings = useLocalStorage<FontProviderSettings>(
  'op-font-providers',
  DEFAULT_WEB_FONT_PROVIDER_SETTINGS
)

/**
 * T41 S4/S5：字体白名单运行时开关——存「被关停」清单（默认全启用，D-c），
 * 覆盖 bundled/cdn/provider/local 全来源；bundled 兜底族由 core 锁定恒开（D-d）。
 * fontListRevision 是 picker 一次性缓存的失效信号（D-h：FontPicker.vue 以 :key 重挂载）。
 * T42：catalog 族（中文网字计划全量目录）默认停用（opt-in）——存「已启用」清单；
 * cnFontsEnabled 是 CDN 独立总开关（D-a，与四家在线 provider 解耦）。
 */
export const disabledFontFamilies = useLocalStorage<string[]>('op-font-disabled-families:v1', [])
export const enabledCatalogFamilies = useLocalStorage<string[]>('op-font-enabled-catalog:v1', [])
export const cnFontsEnabled = useLocalStorage('op-cn-fonts-enabled', true)
export const fontListRevision = ref(0)

// CDN 主开关不经 allowlist revision（枚举门禁在 fonts.ts 而不在白名单），
// picker 失效信号需叠加本地 epoch 手动 bump
let cnSwitchEpoch = 0

watch(
  [disabledFontFamilies, enabledCatalogFamilies, cnFontsEnabled],
  ([disabled, enabledCatalog, cnEnabled]) => {
    fontManager.setDisabledFontFamilies(disabled)
    fontManager.setEnabledCatalogFamilies(enabledCatalog)
    if (cnEnabled !== fontManager.isCnFontsEnabled()) cnSwitchEpoch++
    fontManager.setCnFontsEnabled(cnEnabled)
    fontListRevision.value = fontManager.fontAllowlistRevision() + cnSwitchEpoch
  },
  { deep: true, immediate: true }
)

watch(
  [onlineFontsEnabled, fontProviderSettings],
  () => {
    fontManager.setOnlineFontProviders(
      onlineFontsEnabled.value
        ? Object.fromEntries(
            WEB_FONT_PROVIDER_IDS.map((provider) => [
              provider,
              fontProviderSettings.value[provider] && (isTauri() || provider !== 'google')
            ])
          )
        : {}
    )
  },
  { deep: true, immediate: true }
)

let tauriFontCacheConfigured = false

function configureTauriFontCache() {
  if (tauriFontCacheConfigured || !isTauri()) return
  tauriFontCacheConfigured = true
  fontManager.setDownloadedFontCache(createTauriDownloadedFontCache())
  fontManager.setWebFontFetch(tauriFetch)
  fontManager.setHostFontLoader(loadSystemFont)
}

configureTauriFontCache()
if (!isTauri()) fontManager.setWebFontFetch(browserWebFontFetch)

// T40 S5：cn-font piece 级磁盘缓存（IndexedDB，200MB LRU；idb 缺失自动降级内存）。
// 与 Tauri 请求级缓存并存——前者服务 CDN 子集片（URL 键），后者服务 unifont 请求。
fontManager.setCnFontPieceCache(createCnFontPieceCache())

// The browser's local-fonts permission persists across sessions, but
// fontManager's access state is in-memory ('prompt' on every load). Sync it
// on startup so previously granted local fonts actually resolve — without
// this, granted users still get no local fonts (and no CJK fallback).
if (!isTauri() && hasWindowGlobal() && window.queryLocalFonts) {
  void (async () => {
    try {
      const status = await navigator.permissions.query({
        name: 'local-fonts' as PermissionName
      })
      if (status.state === 'granted') await fontManager.requestLocalFontAccess()
      status.addEventListener('change', () => {
        if (status.state === 'granted') void fontManager.requestLocalFontAccess()
      })
    } catch (error) {
      console.warn('Local font access sync skipped:', error)
    }
  })()
}

interface TauriFontFamily {
  family: string
  styles: string[]
}

let tauriFontsCache: TauriFontFamily[] | null = null
let tauriFontsPromise: Promise<TauriFontFamily[]> | null = null

async function getTauriFonts(): Promise<TauriFontFamily[]> {
  if (tauriFontsCache) return tauriFontsCache
  if (!tauriFontsPromise) {
    tauriFontsPromise = import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<TauriFontFamily[]>('list_system_fonts'))
      .then((fonts) => {
        tauriFontsCache = fonts
        return fonts
      })
      .catch(() => [])
  }
  return tauriFontsPromise
}

export function preloadFonts(): void {
  configureTauriFontCache()
  if (isTauri()) {
    void getTauriFonts().then(registerFontFaces)
    return
  }
  if (onlineFontsEnabled.value) fontManager.preloadWebFontFamilies()
}

export function localFontAccessState(): LocalFontAccessState {
  return isTauri() ? 'granted' : fontManager.localAccessState()
}

export async function requestLocalFontAccess(): Promise<FontFamilyOption[]> {
  if (isTauri()) return listFamilies()
  await fontManager.requestLocalFontAccess()
  return listFamilies()
}

export async function downloadedFontCacheSummary() {
  configureTauriFontCache()
  if (!isTauri()) return { count: 0, byteLength: 0, updatedAt: null }
  return tauriDownloadedFontCacheSummary()
}

export async function clearDownloadedFontCache(): Promise<void> {
  configureTauriFontCache()
  if (!isTauri()) return
  await clearTauriDownloadedFontCache()
}

export async function predownloadFallbackFonts() {
  return fontManager.ensureFallbackPack()
}

function registerFontFaces(fonts: TauriFontFamily[]): void {
  if (typeof document === 'undefined') return
  for (const { family } of fonts) {
    const face = new FontFace(family, `local("${family}")`)
    document.fonts.add(face)
  }
}

async function listTauriMergedFamilies(
  listWebFonts: () => Promise<FontFamilyOption[]>
): Promise<FontFamilyOption[]> {
  const [systemFonts, webFonts] = await Promise.all([getTauriFonts(), listWebFonts()])
  const byFamily = new Map(webFonts.map((font) => [font.family, font]))
  for (const font of systemFonts)
    byFamily.set(font.family, { family: font.family, source: 'local' })
  return [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family))
}

export async function listFamilies(): Promise<FontFamilyOption[]> {
  configureTauriFontCache()
  if (isTauri()) {
    return listTauriMergedFamilies(() => fontManager.listFamilyOptions())
  }
  return fontManager.listFamilyOptions()
}

/**
 * T41 S5：白名单管理面板专用枚举——不过滤 disabled 家族，面板要列出
 * 关停行（含其开关状态）才能重开；picker 仍走 listFamilies（过滤版）。
 */
export async function listAllFamilies(): Promise<FontFamilyOption[]> {
  configureTauriFontCache()
  if (isTauri()) {
    return listTauriMergedFamilies(() => fontManager.listFamilyOptions({ includeDisabled: true }))
  }
  return fontManager.listFamilyOptions({ includeDisabled: true })
}

export async function listFonts(): Promise<TauriFontFamily[]> {
  configureTauriFontCache()
  if (isTauri()) {
    return getTauriFonts()
  }
  return []
}

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
    const fallbackScripts = missingGraphFontScripts(requirements, {
      treatUnknownCoverageAsMissing: IS_TAURI
    })
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

// Session cache for system font bytes. The CJK fallback loop in fontManager
// calls the host loader directly (bypassing its own loadedFamilies cache), so
// without this every text/font operation re-fetches up to 7 full CJK system
// fonts (~100MB) over IPC and re-registers them in CanvasKit — leaking WASM
// memory each time until the webview OOMs. Returning the same ArrayBuffer
// reference lets registerAndCache dedupe and skips re-registration.
const systemFontDataCache = new Map<string, ArrayBuffer | null>()

async function loadSystemFont(family: string, style = 'Regular'): Promise<ArrayBuffer | null> {
  if (!isTauri()) return null
  const key = `${family}|${style}`
  const cached = systemFontDataCache.get(key)
  if (cached !== undefined) return cached
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const data = await invoke<ArrayBuffer>('load_system_font', {
      family,
      style
    })
    const buffer = data.byteLength === 0 ? null : data
    systemFontDataCache.set(key, buffer)
    return buffer
  } catch {
    systemFontDataCache.set(key, null)
    return null
  }
}

export async function loadFont(
  family: string,
  style = 'Regular',
  characters = '',
  signal?: AbortSignal
): Promise<ArrayBuffer | null> {
  configureTauriFontCache()
  return fontManager.loadFont(family, style, characters, signal)
}
