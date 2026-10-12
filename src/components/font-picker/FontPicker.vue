<script setup lang="ts">
import { computed } from 'vue'

import { PREVIEWABLE_FONT_SOURCES, fontFamilyDisplayName } from '@open-pencil/core/text'
import { FontPickerRoot, useI18n } from '@open-pencil/vue'
import type { FontPickerUI } from '@open-pencil/vue'

import {
  fontListRevision,
  listFamilies,
  loadFont,
  localFontAccessState,
  requestLocalFontAccess,
  userLibraryRevision
} from '@/app/editor/fonts'
import { useForkFonts } from '@/app/i18n/fork'
import { openSettingsDialog } from '@/app/settings/dialog'
import { matchFontFamilyOrDisplayName } from '@/components/font-picker/font-option-filter'
import { usePopoverUI } from '@/components/ui/overlay/popover'
import { useSelectUI } from '@/components/ui/select/select'

const { panels } = useI18n()
const forkMsgs = useForkFonts()
/** The placeholder shows while no family is set, such as Mixed for texts in different fonts. */
const { label: labelProp, placeholder } = defineProps<{ label?: string; placeholder?: string }>()
const label = computed(() => labelProp ?? panels.value.fontFamily)
const modelValue = defineModel<string>({ required: true })
const emit = defineEmits<{ select: [family: string] }>()

const cls = usePopoverUI({
  content: 'w-[var(--reka-combobox-trigger-width)] min-w-56 overflow-hidden p-0'
})
const selectCls = useSelectUI({
  trigger: 'w-full rounded px-2 py-1 text-xs',
  item: 'w-full gap-2 px-3 py-2.5 text-sm leading-tight'
})

const ui = computed<FontPickerUI>(() => ({
  trigger: selectCls.trigger,
  content: cls.content,
  item: selectCls.item,
  search:
    'w-full border-b border-border bg-transparent px-3 py-2 text-sm text-surface outline-none placeholder:text-muted',
  empty: 'px-2 py-3 text-center text-xs text-muted',
  emptyAction:
    'mt-2 rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent disabled:opacity-50',
  emptyInstallAction:
    'mt-1 inline-flex w-full items-center justify-center rounded border border-border px-2 py-1 text-xs font-medium text-surface hover:bg-hover disabled:opacity-50'
}))

const previewFontLoads = new Set<string>()

const localFontAccess = {
  state: localFontAccessState,
  load: requestLocalFontAccess
}

function loadPreviewFont(family: string, source: string) {
  if (!PREVIEWABLE_FONT_SOURCES.includes(source as (typeof PREVIEWABLE_FONT_SOURCES)[number])) {
    return
  }
  if (previewFontLoads.has(family)) return
  previewFontLoads.add(family)
  void loadFont(family)
}

function rowLabel(family: string, source: string): string {
  if (source === 'cdn' || source === 'catalog') {
    const dn = fontFamilyDisplayName(family)
    if (dn) return dn
  }
  return family
}

/**
 * Composite revision key — picker remounts on either allowlist toggles
 * (T41 D-h) or user-installed font library mutations (install / uninstall).
 */
const pickerRevision = computed(() => fontListRevision.value + userLibraryRevision.value)

function openFontLibrarySection() {
  openSettingsDialog('fonts')
}
</script>

<template>
  <FontPickerRoot
    :key="pickerRevision"
    v-model="modelValue"
    data-test-id="font-picker-root"
    :list-families="listFamilies"
    :local-font-access="localFontAccess"
    :filter-option="matchFontFamilyOrDisplayName"
    :ui="ui"
    :search-placeholder="panels.searchFonts"
    :empty-search-text="panels.noFontsFound"
    :empty-fonts-text="panels.noLocalFontsAvailable"
    :empty-fonts-hint="panels.localFontsAccessHint"
    @select="emit('select', $event)"
  >
    <template #trigger>
      <button
        type="button"
        data-test-id="font-picker-trigger"
        :aria-label="label"
        :class="selectCls.trigger"
      >
        <span class="truncate" :class="{ 'text-muted': !modelValue }">{{
          modelValue || placeholder
        }}</span>
        <icon-lucide-chevron-down class="size-3 shrink-0 text-muted" />
      </button>
    </template>

    <template #item="{ family, selected, source }">
      <div
        data-test-id="font-picker-item"
        class="flex min-w-0 flex-1 items-center gap-2"
        @vue:mounted="loadPreviewFont(family, source)"
      >
        <icon-lucide-check v-if="selected" class="size-3 shrink-0 text-primary" />
        <span v-else class="size-3 shrink-0" />
        <span class="truncate" :style="{ fontFamily: `'${family}', sans-serif` }">{{
          rowLabel(family, source)
        }}</span>
        <span
          class="font-sans ml-auto shrink-0 rounded bg-input px-1.5 py-0.5 text-[9px] uppercase text-muted"
        >
          {{
            source === 'custom'
              ? forkMsgs.fontsSourceCustom
              : source === 'user'
                ? forkMsgs.fontsSourceUser
                : source === 'bundled'
                  ? forkMsgs.fontsSourceBundled
                  : source
          }}
        </span>
      </div>
    </template>

    <template #empty-install-action>
      <button
        type="button"
        :class="ui.emptyInstallAction"
        data-test-id="font-picker-install-action"
        @click="openFontLibrarySection"
      >
        {{ forkMsgs.fontsInstallAction }}
      </button>
    </template>
  </FontPickerRoot>
</template>
