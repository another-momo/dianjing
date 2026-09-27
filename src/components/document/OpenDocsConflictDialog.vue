<script setup lang="ts">
import { useFocus } from '@vueuse/core'
import { computed, ref, useTemplateRef } from 'vue'

import { useForkOpenDocs } from '@/app/i18n/fork'
import { answerOpenDocsConflict, openDocsConflict } from '@/app/open-docs/lifecycle'
import AppButton from '@/components/ui/button/AppButton.vue'
import AppAlertDialogRoot from '@/components/ui/dialog/AppAlertDialogRoot.vue'
import AppDialogFooter from '@/components/ui/dialog/AppDialogFooter.vue'
import AppDialogHeader from '@/components/ui/dialog/AppDialogHeader.vue'

const text = useForkOpenDocs()

const forceButton = useTemplateRef('forceButton')
useFocus(forceButton, { initialValue: true, preventScroll: true })

const busy = ref(false)

const holderLine = computed(() => {
  const conflict = openDocsConflict.value
  if (!conflict) return ''
  const minutes = Math.max(1, Math.round((Date.now() - conflict.holder.heartbeatAt) / 60_000))
  return text.value.openDocsConflictHolder({ minutes })
})

async function answer(choice: 'force' | 'close'): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await answerOpenDocsConflict(choice)
  } finally {
    busy.value = false
  }
}

function updateOpen(open: boolean): void {
  if (!open) void answerOpenDocsConflict('dismiss')
}
</script>

<template>
  <AppAlertDialogRoot
    :open="openDocsConflict !== null"
    data-test-id="open-docs-conflict-dialog"
    @update:open="updateOpen"
  >
    <AppDialogHeader
      :heading="text.openDocsConflictHeading"
      :description="holderLine"
      :show-close="false"
    />
    <AppDialogFooter>
      <AppButton color="neutral" variant="outline" :disabled="busy" @click="answer('close')">
        {{ text.openDocsConflictClose }}
      </AppButton>
      <AppButton
        ref="forceButton"
        color="primary"
        variant="solid"
        data-test-id="open-docs-conflict-force"
        :disabled="busy"
        @click="answer('force')"
      >
        {{ text.openDocsConflictForce }}
      </AppButton>
    </AppDialogFooter>
  </AppAlertDialogRoot>
</template>
