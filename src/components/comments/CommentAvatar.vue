<script setup lang="ts">
import { colorToCSS } from '@open-pencil/scene-graph/color'
import type { Color } from '@open-pencil/scene-graph/primitives'

import { initials } from '@/app/shell/ui'

/** A comment author's initials on their color. */
defineProps<{ name: string; color: Color }>()
</script>

<template>
  <span
    class="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white select-none"
    :style="{ background: colorToCSS(color) }"
  >
    {{ initials(name) }}
  </span>
</template>
