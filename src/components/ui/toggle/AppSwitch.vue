<script lang="ts">
import type { ComponentUI } from '@/components/ui/types'
import type { SwitchTheme } from '@/theme/toggle/switch'

export type AppSwitchUI = ComponentUI<SwitchTheme>

export interface AppSwitchProps {
  label: string
  size?: keyof SwitchTheme['variants']['size']
  state?: keyof SwitchTheme['variants']['state']
  ui?: AppSwitchUI
  /** T41：禁用态透传（字体白名单 bundled 锁定族开关置灰） */
  disabled?: boolean
}
</script>

<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui'
import { tv } from 'tailwind-variants'
import { computed } from 'vue'

import theme from '@/theme/toggle/switch'

const { label, size = 'sm', state = 'idle', ui, disabled } = defineProps<AppSwitchProps>()
const modelValue = defineModel<boolean>({ required: true })
const styles = computed(() => tv(theme)({ size, state }))
</script>

<template>
  <SwitchRoot
    v-model="modelValue"
    :aria-label="label"
    :disabled="disabled"
    :data-mixed="state === 'mixed' || undefined"
    :class="styles.root({ class: ui?.root })"
  >
    <SwitchThumb :class="styles.thumb({ class: ui?.thumb })" />
  </SwitchRoot>
</template>
