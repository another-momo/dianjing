<script setup lang="ts">
import { DialogClose } from 'reka-ui'
import { computed } from 'vue'

import { IS_TAURI } from '@open-pencil/core/constants'
import { useI18n } from '@open-pencil/vue'

import { useForkFonts } from '@/app/i18n/fork'
import { appCredentialServices } from '@/app/settings/credentials/app'
import {
  browserCredentialsRemembered,
  setRememberCredentials
} from '@/app/settings/credentials/stock-photo-keys'
import { settingsDialogOpen, settingsDialogSection } from '@/app/settings/dialog'
import AgentSettingsPanel from '@/components/settings/agent/AgentSettingsPanel.vue'
import FontsSettingsPanel from '@/components/settings/fonts/FontsSettingsPanel.vue'
import GeneralSettingsPanel from '@/components/settings/general/GeneralSettingsPanel.vue'
import PiModelsPanel from '@/components/settings/models/PiModelsPanel.vue'
import ImageGenKeysSection from '@/components/settings/provider/ImageGenKeysSection.vue'
import StockPhotoKeysSection from '@/components/settings/provider/StockPhotoKeysSection.vue'
import StorageSettingsPanel from '@/components/settings/storage/StorageSettingsPanel.vue'
import VectorizeSettingsSection from '@/components/settings/vectorize/VectorizeSettingsSection.vue'
import { AppDialogFooter, AppDialogHeader, AppDialogRoot } from '@/components/ui/dialog'
import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'

const { settings, common, credentials } = useI18n()
const fontsMsgs = useForkFonts()
function onOpenChange(open: boolean): void {
  settingsDialogOpen.value = open
}

const rememberCredentials = computed({
  get: () => browserCredentialsRemembered.value,
  set: (remembered: boolean) => {
    void setRememberCredentials(remembered)
  }
})

const credentialBackendLabel = computed(() => {
  void browserCredentialsRemembered.value
  if (appCredentialServices.manager.backend === 'native') return credentials.value.backendNative
  if (appCredentialServices.manager.backend === 'browser') {
    return credentials.value.backendBrowser
  }
  return credentials.value.backendMemory
})

const navigationClass =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted transition-colors hover:bg-hover hover:text-surface data-[state=active]:bg-hover data-[state=active]:text-surface'
</script>

<template>
  <AppDialogRoot
    :open="settingsDialogOpen"
    size="xl"
    :ui="{ content: 'w-[min(52.5rem,96vw)]' }"
    height="full"
    data-test-id="app-settings-dialog"
    @update:open="onOpenChange"
  >
    <AppDialogHeader
      :heading="settings.title"
      :description="settings.description"
      :close-label="common.close"
    />

    <div class="flex min-h-0 flex-1">
      <nav class="w-40 shrink-0 border-r border-border p-2" :aria-label="settings.title">
        <button
          type="button"
          :class="navigationClass"
          :data-state="settingsDialogSection === 'general' ? 'active' : 'inactive'"
          data-test-id="settings-section-general"
          @click="settingsDialogSection = 'general'"
        >
          <icon-lucide-settings class="size-3.5" />
          {{ settings.general }}
        </button>
        <button
          type="button"
          :class="navigationClass"
          :data-state="settingsDialogSection === 'ai' ? 'active' : 'inactive'"
          data-test-id="settings-section-ai"
          @click="settingsDialogSection = 'ai'"
        >
          <icon-lucide-sparkles class="size-3.5" />
          {{ settings.aiAndAgents }}
        </button>
        <button
          type="button"
          :class="navigationClass"
          :data-state="settingsDialogSection === 'media' ? 'active' : 'inactive'"
          data-test-id="settings-section-media"
          @click="settingsDialogSection = 'media'"
        >
          <icon-lucide-image class="size-3.5" />
          {{ settings.media }}
        </button>
        <button
          type="button"
          :class="navigationClass"
          :data-state="settingsDialogSection === 'fonts' ? 'active' : 'inactive'"
          data-test-id="settings-section-fonts"
          @click="settingsDialogSection = 'fonts'"
        >
          <icon-lucide-type class="size-3.5" />
          {{ fontsMsgs.settingsFonts }}
        </button>
        <button
          type="button"
          :class="navigationClass"
          :data-state="settingsDialogSection === 'storage' ? 'active' : 'inactive'"
          data-test-id="settings-section-storage"
          @click="settingsDialogSection = 'storage'"
        >
          <icon-lucide-cloud class="size-3.5" />
          {{ settings.storage }}
        </button>
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <GeneralSettingsPanel v-if="settingsDialogSection === 'general'" />

        <section
          v-else-if="settingsDialogSection === 'ai'"
          class="flex flex-col gap-4"
          data-test-id="settings-ai-panel"
        >
          <!-- T91k：去 h-full——本区与 Agent 能力同流，由外层对话框容器统一滚动 -->
          <PiModelsPanel />
          <!-- T96：ModelsPanel 与下一节之间的视觉分隔（预研 §5.3） -->
          <div class="border-t border-border" />
          <!-- ai-panel-ux-consolidation：图像生成凭证由 media 段迁入 ai 段
               （与 PiModelsPanel / AgentSettingsPanel 同流——三件 AI 相关） -->
          <ImageGenKeysSection />
          <!-- ai-panel-ux-consolidation：图像生成与 Agent 能力之间的视觉分隔 -->
          <div class="border-t border-border" />
          <!-- T87：Agent 能力配置（T96：builtinTools 三档位 + agentSkills 开关） -->
          <AgentSettingsPanel />
        </section>

        <section
          v-else-if="settingsDialogSection === 'media'"
          class="flex flex-col gap-2.5"
          data-test-id="settings-media-panel"
        >
          <h3 class="text-xs font-semibold text-surface">{{ settings.media }}</h3>
          <StockPhotoKeysSection />
          <VectorizeSettingsSection />
        </section>

        <StorageSettingsPanel v-else-if="settingsDialogSection === 'storage'" />

        <FontsSettingsPanel v-else-if="settingsDialogSection === 'fonts'" />

        <!-- T36（owner 拍板③）：裸 v-else 收窄——SettingsSection 全体成员的落点必须显式，
             未知/未来成员落显式空态而非静默落到 Storage（mcp 僵尸 nav 曾借裸 v-else 落 Storage） -->
        <div v-else class="text-xs text-muted" data-test-id="settings-unknown-section" />
      </div>
    </div>

    <AppDialogFooter :ui="{ footer: 'justify-between' }">
      <div class="mr-auto flex items-center gap-2">
        <AppSwitch
          v-if="!IS_TAURI"
          v-model="rememberCredentials"
          :label="credentials.remember"
          data-test-id="settings-remember-credentials"
        />
        <div>
          <p v-if="!IS_TAURI" class="text-[10px] text-surface">
            {{ credentials.remember }}
          </p>
          <p class="text-[10px] text-muted" data-test-id="settings-credential-backend">
            {{ credentials.storage({ backend: credentialBackendLabel }) }}
          </p>
        </div>
      </div>
      <DialogClose as-child>
        <button
          type="button"
          class="rounded bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:bg-accent/90"
          data-test-id="app-settings-done"
        >
          {{ common.done }}
        </button>
      </DialogClose>
    </AppDialogFooter>
  </AppDialogRoot>
  <AppAlertDialogRoot :open="confirming" @update:open="!$event && navigation.keepEditing()">
    <AppDialogHeader
      :heading="settings.discardChanges"
      :description="settings.discardChangesDescription"
      :show-close="false"
    />
    <AppDialogFooter>
      <AlertDialogCancel as-child
        ><AppButton>{{ settings.keepEditing }}</AppButton></AlertDialogCancel
      >
      <AppButton color="error" variant="solid" @click="navigation.discard">{{
        settings.discard
      }}</AppButton>
    </AppDialogFooter>
  </AppAlertDialogRoot>
</template>
