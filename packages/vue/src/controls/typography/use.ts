import { computed } from 'vue'

import { fontManager, fontRegistryEntry, weightToStyle } from '@open-pencil/core/text'

import {
  TYPOGRAPHY_WEIGHTS,
  createTypographyActions,
  createTypographyState
} from '#vue/controls/typography/actions'
import { useEditor } from '#vue/editor/context'

/**
 * Options for {@link useTypography}.
 */
export interface TypographyFontLoader {
  /**
   * characters 供 subset 形态族按文本选片——空串选片恒空会被误译作「该字重
   * 不存在」，调用方应传目标节点的实际文本。
   */
  load: (family: string, style: string, characters?: string) => Promise<unknown>
}

export interface UseTypographyOptions {
  /**
   * Optional font loader invoked before changing family or weight.
   */
  fontLoader?: TypographyFontLoader
  /**
   * Invoked when a weight pick fails to load for a family (the face does not
   * exist). Lets the app surface a toast; the ladder itself filters known
   * static families, so this only fires for families with unknown style sets.
   */
  onMissingWeight?: (family: string, weight: number) => void
}

/**
 * Filters the static weight ladder for the current font. VF families expose a
 * contiguous weight axis — only steps inside `[min, max]` are offered. Static
 * families registered with an explicit style list (bundled) are filtered to
 * those styles, so picking an uninstalled weight is impossible instead of
 * silently applied. Unknown families (user-installed, unenumerated) keep the
 * full nine-step ladder; load failures there surface via `onMissingWeight`.
 */
export function filterWeightsForFamily(family: string): typeof TYPOGRAPHY_WEIGHTS {
  if (!family) return TYPOGRAPHY_WEIGHTS
  const range = fontManager.variableWeightRange(family)
  if (range) {
    return TYPOGRAPHY_WEIGHTS.filter(
      (entry) => entry.value >= range.min && entry.value <= range.max
    )
  }
  const entry = fontRegistryEntry(family)
  if (entry && !entry.variable && entry.weights.length > 0) {
    const available = new Set(entry.weights)
    return TYPOGRAPHY_WEIGHTS.filter((item) => available.has(weightToStyle(item.value)))
  }
  return TYPOGRAPHY_WEIGHTS
}

/**
 * Returns typography-related state and actions for the current text selection.
 *
 * This composable is designed for text property panels and formatting controls.
 */
export function useTypography(options: UseTypographyOptions = {}) {
  const editor = useEditor()
  const typographyState = createTypographyState(editor)
  const actions = createTypographyActions({ editor, ...typographyState, options })
  const weights = computed(() => filterWeightsForFamily(typographyState.fontFamily.value))

  return {
    editor,
    ...typographyState,
    weights,
    ...actions
  }
}
