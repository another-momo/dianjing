import { useLocalStorage } from '@vueuse/core'

import { DEFAULT_SNAPPING_PREFERENCES, type SnappingPreferences } from '@open-pencil/core/editor'

export type AnimationPreference = 'system' | 'off'

export type ReasoningDisplay = 'collapsed' | 'while-thinking' | 'expanded'

export type CanvasRenderingMode = 'retained' | 'tiled'

export interface AppPreferences {
  appearance: { animations: AnimationPreference }
  chat: { reasoningDisplay: ReasoningDisplay; followLocusPage: boolean }
  version: 1
  recovery: {
    enabled: boolean
  }
  editing: {
    snapping: SnappingPreferences
  }
  rendering: {
    canvasMode: CanvasRenderingMode
  }
}

export const DEFAULT_APP_PREFERENCES: Readonly<AppPreferences> = {
  appearance: { animations: 'system' },
  chat: { reasoningDisplay: 'collapsed', followLocusPage: false },
  version: 1,
  recovery: { enabled: true },
  editing: {
    snapping: { ...DEFAULT_SNAPPING_PREFERENCES }
  },
  rendering: { canvasMode: 'retained' }
}

const STORAGE_KEY = 'open-pencil:preferences:v1'

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

interface StoredSnappingPreferences {
  geometry?: unknown
  objects?: unknown
  pixelGrid?: unknown
}

interface StoredAppPreferences {
  appearance?: { animations?: unknown }
  chat?: { reasoningDisplay?: unknown; followLocusPage?: unknown }
  recovery?: { enabled?: unknown }
  editing?: { snapping?: StoredSnappingPreferences }
  rendering?: { canvasMode?: unknown }
}

function isStoredAppPreferences(value: unknown): value is StoredAppPreferences {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAnimationPreference(value: unknown): AnimationPreference {
  return value === 'off' ? 'off' : 'system'
}

function normalizeReasoningDisplay(value: unknown): ReasoningDisplay {
  return value === 'expanded' || value === 'while-thinking' ? value : 'collapsed'
}

function normalizeSnapping(stored: StoredSnappingPreferences | undefined): SnappingPreferences {
  return {
    geometry: booleanOrDefault(stored?.geometry, DEFAULT_APP_PREFERENCES.editing.snapping.geometry),
    objects: booleanOrDefault(stored?.objects, DEFAULT_APP_PREFERENCES.editing.snapping.objects),
    pixelGrid: booleanOrDefault(
      stored?.pixelGrid,
      DEFAULT_APP_PREFERENCES.editing.snapping.pixelGrid
    )
  }
}

function normalizePreferences(value: unknown): AppPreferences {
  const stored = isStoredAppPreferences(value) ? value : undefined

  return {
    appearance: { animations: normalizeAnimationPreference(stored?.appearance?.animations) },
    chat: {
      reasoningDisplay: normalizeReasoningDisplay(stored?.chat?.reasoningDisplay),
      followLocusPage: booleanOrDefault(
        stored?.chat?.followLocusPage,
        DEFAULT_APP_PREFERENCES.chat.followLocusPage
      )
    },
    version: 1,
    recovery: {
      enabled: booleanOrDefault(stored?.recovery?.enabled, DEFAULT_APP_PREFERENCES.recovery.enabled)
    },
    editing: {
      snapping: normalizeSnapping(stored?.editing?.snapping)
    },
    rendering: {
      canvasMode: stored?.rendering?.canvasMode === 'tiled' ? 'tiled' : 'retained'
    }
  }
}

export const appPreferences = useLocalStorage<AppPreferences>(
  STORAGE_KEY,
  structuredClone(DEFAULT_APP_PREFERENCES),
  { mergeDefaults: (storageValue) => normalizePreferences(storageValue) }
)

export function updateAnimationPreference(animations: AnimationPreference): void {
  appPreferences.value = { ...appPreferences.value, appearance: { animations } }
}

export function updateRecoveryEnabled(enabled: boolean): void {
  // 禁 structuredClone(appPreferences.value)：useLocalStorage 的 value 是 Vue
  // reactive proxy，structuredClone 遇 Proxy 抛 DataCloneError，开关静默失效。
  appPreferences.value = {
    ...appPreferences.value,
    recovery: { enabled }
  }
}

export function updateCanvasRenderingMode(canvasMode: CanvasRenderingMode): void {
  appPreferences.value = {
    ...appPreferences.value,
    rendering: { canvasMode }
  }
}

export function updateFollowLocusPage(follow: boolean): void {
  appPreferences.value = {
    ...appPreferences.value,
    chat: { ...appPreferences.value.chat, followLocusPage: follow }
  }
}

export function updateSnappingPreferences(changes: Partial<SnappingPreferences>): void {
  appPreferences.value = {
    ...appPreferences.value,
    editing: {
      ...appPreferences.value.editing,
      snapping: {
        ...appPreferences.value.editing.snapping,
        ...changes
      }
    }
  }
}
