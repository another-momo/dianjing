import { computed } from 'vue'

import { fontManager } from '@open-pencil/core/text'

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
  load: (family: string, style: string) => Promise<unknown>
}

export interface UseTypographyOptions {
  /**
   * Optional font loader invoked before changing family or weight.
   */
  fontLoader?: TypographyFontLoader
}

/**
 * Filters the static weight ladder against the current font's VF range. VF
 * families expose a contiguous weight axis; the picker should only show steps
 * inside `[min, max]`. Static families and unresolved/unknown names fall back
 * to the full nine-step ladder.
 */
function filterWeightsForFamily(family: string): typeof TYPOGRAPHY_WEIGHTS {
  if (!family) return TYPOGRAPHY_WEIGHTS
  const range = fontManager.variableWeightRange(family)
  if (!range) return TYPOGRAPHY_WEIGHTS
  return TYPOGRAPHY_WEIGHTS.filter((entry) => entry.value >= range.min && entry.value <= range.max)
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
