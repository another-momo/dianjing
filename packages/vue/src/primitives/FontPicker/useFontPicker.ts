import { tryOnScopeDispose, watchImmediate } from '@vueuse/core'
import { useFilter } from 'reka-ui'
import { computed, ref, watch } from 'vue'

import type { FontFamilyOption } from '@open-pencil/core/text'

import { useRetainedActivity } from '#vue/lifecycle/retention/context'

export type { FontFamilyOption, FontFamilySource } from '@open-pencil/core/text'

/**
 * Options for {@link useFontPicker}.
 */
export interface UseFontPickerOptions {
  /** Writable model for the selected font family. */
  modelValue: { value: string }
  /** Async source for available font families. */
  listFamilies: () => Promise<string[] | FontFamilyOption[]>
  /** Custom search matcher (e.g. also matching catalog display names). Defaults to case-insensitive family substring. */
  filterOption?: (option: FontFamilyOption, searchTerm: string) => boolean
  /** Optional callback fired after a family is selected. */
  onSelect?: (family: string) => void
}

function normalizeOptions(items: string[] | FontFamilyOption[]): FontFamilyOption[] {
  return items.map((item) =>
    typeof item === 'string' ? { family: item, source: 'bundled' } : item
  )
}

/**
 * Returns searchable font-picker state and selection helpers.
 */
export function useFontPicker(options: UseFontPickerOptions) {
  const families = ref<FontFamilyOption[]>([])
  const searchTerm = ref('')
  const open = ref(false)
  const loading = ref(false)
  const active = useRetainedActivity()
  let requestVersion = 0

  function cancelLoad() {
    requestVersion++
    loading.value = false
  }

  watchImmediate(
    () => active?.value ?? true,
    (enabled) => {
      if (!enabled) cancelLoad()
    },
    { flush: 'sync' }
  )
  tryOnScopeDispose(cancelLoad)

  const { contains } = useFilter({ sensitivity: 'base' })
  const filtered = computed(() => {
    if (!searchTerm.value) return families.value
    return families.value.filter((option) =>
      options.filterOption
        ? options.filterOption(option, searchTerm.value)
        : contains(option.family, searchTerm.value)
    )
  })

  async function loadFamilies() {
    if (families.value.length > 0 || loading.value) return
    loading.value = true
    const version = ++requestVersion
    try {
      const items = await options.listFamilies()
      if (version !== requestVersion) return
      families.value = normalizeOptions(items)
    } finally {
      if (version === requestVersion) loading.value = false
    }
  }

  watch(open, async (isOpen) => {
    if (!isOpen) return
    searchTerm.value = ''
    await loadFamilies()
  })

  function select(family: string) {
    options.modelValue.value = family
    options.onSelect?.(family)
    open.value = false
  }

  return {
    families,
    searchTerm,
    open,
    filtered,
    loading,
    select
  }
}
