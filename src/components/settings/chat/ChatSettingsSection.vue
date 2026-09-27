<script setup lang="ts">
import { computed } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { useForkLocus } from '@/app/i18n/fork'
import {
  appPreferences,
  updateFollowLocusPage,
  type ReasoningDisplay
} from '@/app/settings/preferences/store'
import SettingsGroup from '@/components/settings/layout/SettingsGroup.vue'
import SettingsRow from '@/components/settings/layout/SettingsRow.vue'
import SettingsSection from '@/components/settings/layout/SettingsSection.vue'
import AppSelect from '@/components/ui/select/AppSelect.vue'
import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'

const { ai } = useI18n()
const locusText = useForkLocus()

// P2-a（2026-09-19，路线 B）：chat.reasoningDisplay 三态偏好设置项——基建
// （类型/默认值 collapsed/持久化迁移）休眠在 preferences/store，本组件为
// 设置面消费点；面板渲染消费在 PiChatMessage → ReasoningBlock
const reasoningDisplay = computed({
  get: () => appPreferences.value.chat.reasoningDisplay,
  set: (value: ReasoningDisplay) => {
    appPreferences.value = {
      ...appPreferences.value,
      chat: { ...appPreferences.value.chat, reasoningDisplay: value }
    }
  }
})

const options = computed(() => [
  { value: 'collapsed' as const, label: ai.value.reasoningCollapsed },
  { value: 'while-thinking' as const, label: ai.value.reasoningWhileThinking },
  { value: 'expanded' as const, label: ai.value.reasoningExpanded }
])

// sl-w2-locus-gate（§7.3）：跟随施工页开关——run 起始自动把视图切到冻结施工页。
// 持久化走 preferences/store 同款 useLocalStorage + spread 写路径；走
// updateFollowLocusPage setter 保证深拷贝 + 单字段更新。
const followLocusPage = computed({
  get: () => appPreferences.value.chat.followLocusPage,
  set: (value: boolean) => updateFollowLocusPage(value)
})
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
      <SettingsRow
        :label="locusText.locusFollowToggle"
        :description="locusText.locusFollowDescription"
        class="max-sm:flex-col max-sm:items-stretch"
      >
        <AppSwitch
          :model-value="followLocusPage"
          :label="locusText.locusFollowToggle"
          data-test-id="settings-follow-locus-page"
          @update:model-value="followLocusPage = $event"
        />
      </SettingsRow>
    </SettingsGroup>
  </SettingsSection>
</template>
