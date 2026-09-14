<script setup lang="ts">
import { computed, ref } from 'vue'
import { type Locale, useI18n } from '@open-pencil/vue'

import { recoveryEnabled, setRecoveryEnabled } from '@/app/document/recovery/preferences'
import { setSnappingPreference } from '@/app/settings/preferences/apply'
import { appPreferences } from '@/app/settings/preferences/store'
import AppSelect from '@/components/ui/select/AppSelect.vue'
import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'
import Tip from '@/components/ui/overlay/Tip.vue'
import { animationPreference } from '@/app/shell/motion'
import RenderingSettingsSection from '@/components/settings/general/RenderingSettingsSection.vue'
import SettingsGroup from '@/components/settings/layout/SettingsGroup.vue'
import SettingsSectionHeader from '@/components/settings/layout/SettingsSectionHeader.vue'
import AppSelect from '@/components/ui/select/AppSelect.vue'
import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'

const { availableLocales, locale, localeLabels, menu, recovery, setLocale, settings } = useI18n()

const language = computed<Locale>({
  get: () => locale.value,
  set: setLocale
})

const languageOptions = availableLocales.map((value) => ({
  value,
  label: localeLabels[value]
}))

const preserveUnsavedWork = computed({
  get: () => recoveryEnabled.value,
  set: setRecoveryEnabled
})

const snapToGeometry = computed({
  get: () => appPreferences.value.editing.snapping.geometry,
  set: (enabled: boolean) => setSnappingPreference('geometry', enabled)
})

const snapToObjects = computed({
  get: () => appPreferences.value.editing.snapping.objects,
  set: (enabled: boolean) => setSnappingPreference('objects', enabled)
})

const snapToPixelGrid = computed({
  get: () => appPreferences.value.editing.snapping.pixelGrid,
  set: (enabled: boolean) => setSnappingPreference('pixelGrid', enabled)
})

// P2-11：studio 文件夹入口。当前 fork 尚未提供 Electron/Tauri IPC 桥让 UI
// 直接调 shell.openPath；浏览器环境也无 file:// 链接等价行为。采用降级策略：
// 显式展示路径文本 + 「复制路径」按钮——用户自行粘贴到资源管理器/终端/Finder
// 打开。后续 IPC 桥就位后可在此 hook 上接 openPath，UI 与 i18n 不变。
//
// 路径以 POSIX 风格相对显示（`~/.openpencil/studio`），跨平台用户均能识别；
// Windows 实际为 `%USERPROFILE%\.openpencil\studio`，macOS 为
// `$HOME/.openpencil/studio`，Linux 同 macOS。绝对路径需后端 IPC 才能解析，
// 留待 IPC 桥就位后由后端注入。
const studioFolderPath = '~/.openpencil/studio'
const copyStatus = ref<'idle' | 'copied' | 'failed'>('idle')

async function copyStudioFolderPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(studioFolderPath)
    copyStatus.value = 'copied'
  } catch {
    copyStatus.value = 'failed'
  }
  // 1.2s 后回归 idle，避免状态文字长期残留
  setTimeout(() => {
    copyStatus.value = 'idle'
  }, 1200)
}

const copyStatusLabel = computed(() => {
  if (copyStatus.value === 'copied') return '已复制'
  if (copyStatus.value === 'failed') return '复制失败'
  return '复制路径'
})
</script>

<template>
  <section class="flex flex-col gap-4" data-test-id="settings-general-panel">
    <div>
      <h3 class="text-xs font-semibold text-surface">{{ menu.language }}</h3>
      <p class="mt-1 text-[11px] text-muted">{{ settings.languageDescription }}</p>
    </div>

    <div class="flex flex-col rounded border border-border">
      <label class="flex items-center justify-between gap-4 px-3 py-2.5">
        <span class="text-xs text-surface">{{ menu.language }}</span>
        <AppSelect
          v-model="language"
          :label="menu.language"
          :options="languageOptions"
          class="w-44"
          data-test-id="settings-language"
        />
      </label>
    </div>

    <SettingsGroup>
      <label class="flex items-center justify-between gap-4 px-3 py-2.5">
        <span class="text-xs text-surface">{{ settings.animations }}</span>
        <AppSelect
          v-model="animationPreference"
          :label="settings.animations"
          :options="[
            { value: 'system', label: settings.animationsSystem },
            { value: 'off', label: settings.animationsOff }
          ]"
          class="w-44"
        />
      </label>
    </SettingsGroup>

    <SettingsSectionHeader>
      {{ recovery.settingsTitle }}
      <template #description>{{ recovery.settingsDescription }}</template>
    </SettingsSectionHeader>

    <SettingsGroup>
      <label class="flex items-center justify-between gap-4 px-3 py-2.5">
        <span>
          <span class="block text-xs text-surface">{{ recovery.preserveUnsavedWork }}</span>
          <span class="block text-[10px] text-muted">{{
            recovery.preserveUnsavedWorkDescription
          }}</span>
        </span>
        <AppSwitch
          v-model="preserveUnsavedWork"
          :label="recovery.preserveUnsavedWork"
          data-test-id="settings-recovery-enabled"
        />
      </label>
    </SettingsGroup>

    <SettingsSectionHeader>
      {{ settings.editing }}
      <template #description>{{ settings.snappingDescription }}</template>
    </SettingsSectionHeader>

    <SettingsGroup>
      <label class="flex items-center justify-between gap-4 px-3 py-2.5">
        <span>
          <span class="block text-xs text-surface">{{ settings.snapToGeometry }}</span>
          <span class="block text-[10px] text-muted">{{ settings.snapToGeometryDescription }}</span>
        </span>
        <AppSwitch
          v-model="snapToGeometry"
          :label="settings.snapToGeometry"
          data-test-id="settings-snap-geometry"
        />
      </label>
      <label class="flex items-center justify-between gap-4 px-3 py-2.5">
        <span>
          <span class="block text-xs text-surface">{{ settings.snapToObjects }}</span>
          <span class="block text-[10px] text-muted">{{ settings.snapToObjectsDescription }}</span>
        </span>
        <AppSwitch
          v-model="snapToObjects"
          :label="settings.snapToObjects"
          data-test-id="settings-snap-objects"
        />
      </label>
      <label class="flex items-center justify-between gap-4 px-3 py-2.5">
        <span>
          <span class="block text-xs text-surface">{{ settings.snapToPixelGrid }}</span>
          <span class="block text-[10px] text-muted">{{
            settings.snapToPixelGridDescription
          }}</span>
        </span>
        <AppSwitch
          v-model="snapToPixelGrid"
          :label="settings.snapToPixelGrid"
          data-test-id="settings-snap-pixel-grid"
        />
      </label>
    </SettingsGroup>

    <p class="text-[10px] text-muted">{{ settings.temporaryDisableSnappingHint }}</p>

    <SettingsSectionHeader>
      Studio 资产扩展
      <template #description>
        你的自定义 workflow / profile 放在用户目录
        <code>~/.openpencil/studio/</code> 下，以同名子目录包裹（<code
          >workflows/&lt;id&gt;/workflow.md</code
        >
        与 <code>profiles/&lt;id&gt;/profile.md</code>）。首跑时已自动复制
        <code>_example</code> 示例模板，复制后即可改名改写。
      </template>
    </SettingsSectionHeader>

    <SettingsGroup>
      <div class="flex items-center justify-between gap-4 px-3 py-2.5">
        <div class="min-w-0">
          <span class="block text-xs text-surface">Studio 文件夹路径</span>
          <Tip :label="studioFolderPath">
            <span
              class="mt-0.5 block truncate font-mono text-[10px] text-muted"
              data-test-id="settings-studio-folder-path"
              >{{ studioFolderPath }}</span
            >
          </Tip>
        </div>
        <button
          type="button"
          class="shrink-0 rounded border border-border bg-surface px-2 py-1 text-[11px] text-surface transition-colors hover:bg-hover disabled:opacity-50"
          :disabled="copyStatus !== 'idle'"
          data-test-id="settings-studio-folder-copy"
          @click="copyStudioFolderPath"
        >
          {{ copyStatusLabel }}
        </button>
      </div>
    </SettingsGroup>

    <RenderingSettingsSection />
  </section>
</template>
