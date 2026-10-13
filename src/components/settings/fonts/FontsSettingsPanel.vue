<script setup lang="ts">
import { computed, ref } from 'vue'

import { useForkFonts } from '@/app/i18n/fork'
import FontStorePanel from '@/components/settings/fonts/FontStorePanel.vue'
import MyFontLibrary from '@/components/settings/fonts/MyFontLibrary.vue'

type FontsSegment = 'library' | 'store'
const activeSegment = ref<FontsSegment>('library')
const msgs = useForkFonts()
const segments = computed<{ key: FontsSegment; label: string }[]>(() => [
  { key: 'library', label: msgs.value.fontsMyLibrary },
  { key: 'store', label: msgs.value.fontsStoreTab }
])
</script>

<template>
  <section class="flex flex-col gap-3" data-test-id="settings-fonts-panel">
    <div>
      <h3 class="text-xs font-semibold text-surface">{{ msgs.fontsPanelTitle }}</h3>
      <p class="mt-0.5 text-[10px] leading-relaxed text-muted">
        {{ msgs.fontsPanelDescription }}
      </p>
    </div>

    <div class="flex gap-1 border-b border-border pb-2" data-test-id="fonts-panel-tabs">
      <button
        v-for="segment in segments"
        :key="segment.key"
        type="button"
        class="rounded px-2 py-1 text-[11px]"
        :class="
          segment.key === activeSegment ? 'bg-input text-surface' : 'text-muted hover:bg-hover'
        "
        :data-test-id="`fonts-tab-${segment.key}`"
        @click="activeSegment = segment.key"
      >
        {{ segment.label }}
      </button>
    </div>
    <MyFontLibrary v-if="activeSegment === 'library'" />
    <FontStorePanel v-else />
  </section>
</template>
