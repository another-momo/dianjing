<script setup lang="ts">
import { computed } from 'vue'

import { WEB_FONT_PROVIDER_IDS, fontFamilyDisplayName } from '@open-pencil/core/text'
import { FontPickerRoot, useI18n } from '@open-pencil/vue'
import type { FontPickerUI } from '@open-pencil/vue'

import {
  fontListRevision,
  listFamilies,
  loadFont,
  localFontAccessState,
  requestLocalFontAccess
} from '@/app/editor/fonts'
import { matchFontFamilyOrDisplayName } from '@/components/font-picker/font-option-filter'
import { usePopoverUI } from '@/components/ui/overlay/popover'
import { useSelectUI } from '@/components/ui/select/select'

const { panels } = useI18n()
const { label: labelProp } = defineProps<{ label?: string }>()
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
  emptyAction: 'mt-2 rounded bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-50'
}))

const previewFontLoads = new Set<string>()

const localFontAccess = {
  state: localFontAccessState,
  load: requestLocalFontAccess
}

function loadPreviewFont(family: string, source: string) {
  if (!WEB_FONT_PROVIDER_IDS.includes(source as (typeof WEB_FONT_PROVIDER_IDS)[number])) return
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
</script>

<template>
  <!-- T41（D-h）：白名单运行时开关后重挂载——useFontPicker 的 families 一次性缓存
       无失效机制，:key 变更重建 picker 使关停的家族即时消失（picker 此时必然处于
       关闭态——开关操作发生在设置面板，重挂载不损失任何打开态 UI 状态） -->
  <FontPickerRoot
    :key="fontListRevision"
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
        <span class="truncate">{{ modelValue }}</span>
        <icon-lucide-chevron-down class="size-3 shrink-0 text-muted" />
      </button>
    </template>

    <template #item="{ family, selected, source }">
      <div
        data-test-id="font-picker-item"
        class="flex min-w-0 flex-1 items-center gap-2"
        @vue:mounted="loadPreviewFont(family, source)"
      >
        <icon-lucide-check v-if="selected" class="size-3 shrink-0 text-accent" />
        <span v-else class="size-3 shrink-0" />
        <span class="truncate" :style="{ fontFamily: `'${family}', sans-serif` }">{{
          rowLabel(family, source)
        }}</span>
        <span
          class="font-sans ml-auto shrink-0 rounded bg-input px-1.5 py-0.5 text-[9px] uppercase text-muted"
        >
          {{ source }}
        </span>
      </div>
    </template>
  </FontPickerRoot>
</template>
