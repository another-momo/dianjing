<script setup lang="ts">
import { computed } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { appRuntimeConfig } from '@/app/runtime/config'
import { appPreferences, updateCanvasRenderingMode } from '@/app/settings/preferences/store'
import SettingsGroup from '@/components/settings/layout/SettingsGroup.vue'
import SettingsSectionHeader from '@/components/settings/layout/SettingsSectionHeader.vue'
import AppAlert from '@/components/ui/feedback/AppAlert.vue'
import AppBadge from '@/components/ui/feedback/AppBadge.vue'
import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'

const { rendering } = useI18n()
const hasURLOverride = appRuntimeConfig.sceneRendererOverride
const tiledRendering = computed(() => appPreferences.value.rendering.canvasMode === 'tiled')
const changed = computed(
  () => appPreferences.value.rendering.canvasMode !== appRuntimeConfig.sceneRenderer
)

function setTiledRendering(enabled: boolean): void {
  updateCanvasRenderingMode(enabled ? 'tiled' : 'retained')
}
</script>

<template>
  <SettingsSectionHeader>
    {{ rendering.settingsTitle }}
    <template #description>{{ rendering.settingsDescription }}</template>
  </SettingsSectionHeader>

  <SettingsGroup>
    <label class="flex items-center justify-between gap-4 px-3 py-2.5">
      <span>
        <!-- 渐进渲染实验标记是 fork 语义（上游无此 badge），塞进行内 label span -->
        <span class="flex flex-wrap items-center gap-2 text-xs text-surface">
          {{ rendering.progressiveTiled }}
          <AppBadge :ui="{ base: 'bg-hover text-surface' }">{{ rendering.experimental }}</AppBadge>
        </span>
        <span class="block text-[10px] text-muted">{{
          rendering.progressiveTiledDescription
        }}</span>
      </span>
      <AppSwitch
        :model-value="tiledRendering"
        :label="rendering.progressiveTiled"
        data-test-id="settings-progressive-tiled-rendering"
        @update:model-value="setTiledRendering"
      />
    </label>
  </SettingsGroup>

  <!-- AppAlert 警示语义强于上游 muted <p>，fork 增量保留不换回 -->
  <AppAlert v-if="hasURLOverride" :heading="rendering.urlOverride" />
  <AppAlert v-else-if="changed" :heading="rendering.reloadRequired" />
</template>
