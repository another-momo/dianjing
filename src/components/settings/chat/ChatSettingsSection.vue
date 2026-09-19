<script setup lang="ts">
import { computed } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { appPreferences, type ReasoningDisplay } from '@/app/settings/preferences/store'
import SettingsGroup from '@/components/settings/layout/SettingsGroup.vue'
import SettingsRow from '@/components/settings/layout/SettingsRow.vue'
import SettingsSection from '@/components/settings/layout/SettingsSection.vue'
import AppSelect from '@/components/ui/select/AppSelect.vue'

const { ai } = useI18n()

// P2-a（2026-09-19，路线 B）：chat.reasoningDisplay 三态偏好设置项——基建
// （类型/默认值 collapsed/持久化迁移）休眠在 preferences/store，本组件为
// 设置面消费点；面板渲染消费在 PiChatMessage → ReasoningBlock
const reasoningDisplay = computed({
  get: () => appPreferences.value.chat.reasoningDisplay,
  set: (value: ReasoningDisplay) => {
    appPreferences.value = { ...appPreferences.value, chat: { reasoningDisplay: value } }
  }
})

const options = computed(() => [
  { value: 'collapsed' as const, label: ai.value.reasoningCollapsed },
  { value: 'while-thinking' as const, label: ai.value.reasoningWhileThinking },
  { value: 'expanded' as const, label: ai.value.reasoningExpanded }
])
</script>

<template>
  <SettingsSection>
    <template #title>{{ ai.chatSettings }}</template>
    <SettingsGroup>
      <SettingsRow :label="ai.reasoningDisplay" class="max-sm:flex-col max-sm:items-stretch">
        <AppSelect
          v-model="reasoningDisplay"
          :label="ai.reasoningDisplay"
          :options="options"
          :ui="{ trigger: 'w-full sm:w-52' }"
          data-test-id="settings-reasoning-display"
        />
      </SettingsRow>
    </SettingsGroup>
  </SettingsSection>
</template>
