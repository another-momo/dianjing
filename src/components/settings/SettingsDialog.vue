<script setup lang="ts">
import { DialogClose } from 'reka-ui'
import { computed } from 'vue'

import { IS_TAURI } from '@open-pencil/core/constants'
import { useI18n, useViewportKind } from '@open-pencil/vue'

import { useForkFonts } from '@/app/i18n/fork'
import { appCredentialServices, browserCredentialsRemembered } from '@/app/settings/credentials/app'
import { useCredentialSettings } from '@/app/settings/credentials/preferences/use'
import { settingsDialogOpen, settingsDialogSection } from '@/app/settings/dialog'
import AgentSettingsPanel from '@/components/settings/agent/AgentSettingsPanel.vue'
import ChatSettingsSection from '@/components/settings/chat/ChatSettingsSection.vue'
import FontsSettingsPanel from '@/components/settings/fonts/FontsSettingsPanel.vue'
import GeneralSettingsPanel from '@/components/settings/general/GeneralSettingsPanel.vue'
import McpConnectionsSection from '@/components/settings/mcp-connections/MCPConnectionsSection.vue'
import MediaSettingsPanel from '@/components/settings/media/MediaSettingsPanel.vue'
import PiModelsPanel from '@/components/settings/models/PiModelsPanel.vue'
import ImageGenKeysSection from '@/components/settings/provider/ImageGenKeysSection.vue'
import StorageSettingsPanel from '@/components/settings/storage/StorageSettingsPanel.vue'
import AppButton from '@/components/ui/button/AppButton.vue'
import {
  AppDialogBody,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogRoot
} from '@/components/ui/dialog'
import AppTabsContent from '@/components/ui/tabs/AppTabsContent.vue'
import AppTabsList from '@/components/ui/tabs/AppTabsList.vue'
import AppTabsRoot from '@/components/ui/tabs/AppTabsRoot.vue'
import AppTabsTrigger from '@/components/ui/tabs/AppTabsTrigger.vue'
import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'

const { isMobile } = useViewportKind()
const { settings, common, credentials } = useI18n()
const fontsMsgs = useForkFonts()
function onOpenChange(open: boolean): void {
  settingsDialogOpen.value = open
}

// PR713 凭据延迟链吸收：remember 开关改接 useCredentialSettings（remembered/busy/failed；
// paused/retry 是 Tauri 面，Electron 下休眠不接线——见 credentials/preferences/use.ts）
const {
  busy: credentialSettingsBusy,
  failed: credentialSettingsFailed,
  remembered: rememberCredentials
} = useCredentialSettings()

const credentialBackendLabel = computed(() => {
  void browserCredentialsRemembered.value
  if (appCredentialServices.manager.backend === 'native') return credentials.value.backendNative
  if (appCredentialServices.manager.backend === 'browser') {
    return credentials.value.backendBrowser
  }
  return credentials.value.backendMemory
})
</script>

<template>
  <AppDialogRoot
    :open="settingsDialogOpen"
    size="lg"
    height="tall"
    data-test-id="app-settings-dialog"
    @update:open="onOpenChange"
  >
    <AppDialogHeader
      :heading="settings.title"
      :description="settings.description"
      :close-label="common.close"
    />

    <AppTabsRoot
      v-model="settingsDialogSection"
      :orientation="isMobile ? 'horizontal' : 'vertical'"
    >
      <AppTabsList :label="settings.title">
        <AppTabsTrigger value="general" data-test-id="settings-section-general">
          <template #leading><icon-lucide-settings class="size-3.5" /></template>
          {{ settings.general }}
        </AppTabsTrigger>
        <AppTabsTrigger value="ai" data-test-id="settings-section-ai">
          <template #leading><icon-lucide-sparkles class="size-3.5" /></template>
          {{ settings.aiAndAgents }}
        </AppTabsTrigger>
        <AppTabsTrigger value="media" data-test-id="settings-section-media">
          <template #leading><icon-lucide-image class="size-3.5" /></template>
          {{ settings.media }}
        </AppTabsTrigger>
        <AppTabsTrigger value="fonts" data-test-id="settings-section-fonts">
          <template #leading><icon-lucide-type class="size-3.5" /></template>
          {{ fontsMsgs.settingsFonts }}
        </AppTabsTrigger>
        <AppTabsTrigger value="storage" data-test-id="settings-section-storage">
          <template #leading><icon-lucide-cloud class="size-3.5" /></template>
          {{ settings.storage }}
        </AppTabsTrigger>
      </AppTabsList>

      <AppTabsContent value="general" as-child>
        <AppDialogBody><GeneralSettingsPanel /></AppDialogBody>
      </AppTabsContent>
      <AppTabsContent value="ai" as-child>
        <AppDialogBody>
          <section class="flex flex-col gap-4" data-test-id="settings-ai-panel">
            <!-- T91k：去 h-full——本区与 Agent 能力同流，由外层对话框容器统一滚动 -->
            <PiModelsPanel />
            <!-- P2-a（2026-09-19，路线 B）：聊天展示偏好节（reasoningDisplay 三态），
                 语义位置对齐上游 ChatSettingsSection（ai 段紧随 ModelsPanel） -->
            <div class="border-t border-border" />
            <ChatSettingsSection />
            <!-- T96：ModelsPanel 与下一节之间的视觉分隔（预研 §5.3） -->
            <div class="border-t border-border" />
            <!-- ai-panel-ux-consolidation：图像生成凭证由 media 段迁入 ai 段
                 （与 PiModelsPanel / AgentSettingsPanel 同流——三件 AI 相关） -->
            <ImageGenKeysSection />
            <!-- ai-panel-ux-consolidation：图像生成与 Agent 能力之间的视觉分隔 -->
            <div class="border-t border-border" />
            <!-- MCP 接入阶段 1：第三方 MCP 连接设置面（§5.6 拷改 + 路径分离，
                 见 src/components/settings/mcp-connections/） -->
            <McpConnectionsSection />
            <div class="border-t border-border" />
            <!-- T87：Agent 能力配置（T96：builtinTools 三档位 + agentSkills 开关） -->
            <AgentSettingsPanel />
          </section>
        </AppDialogBody>
      </AppTabsContent>
      <AppTabsContent value="media" as-child>
        <!-- v0.15.0 内容代吸收：媒体段整取上游钻取式面板（AppActionRow 列表 + MediaCredentialEditor） -->
        <AppDialogBody><MediaSettingsPanel /></AppDialogBody>
      </AppTabsContent>
      <AppTabsContent value="fonts" as-child>
        <AppDialogBody><FontsSettingsPanel /></AppDialogBody>
      </AppTabsContent>
      <AppTabsContent value="storage" as-child>
        <AppDialogBody><StorageSettingsPanel /></AppDialogBody>
      </AppTabsContent>
    </AppTabsRoot>

    <AppDialogFooter :ui="{ footer: 'justify-between' }">
      <div class="mr-auto flex items-center gap-2">
        <AppSwitch
          v-if="!IS_TAURI"
          v-model="rememberCredentials"
          :label="credentials.remember"
          :disabled="credentialSettingsBusy"
          data-test-id="settings-remember-credentials"
        />
        <div>
          <p v-if="!IS_TAURI" class="text-[10px] text-surface">
            {{ credentials.remember }}
          </p>
          <p v-if="credentialSettingsFailed" class="text-[10px] text-danger" role="alert">
            {{ credentials.retryFailed }}
          </p>
          <p class="text-[10px] text-muted" data-test-id="settings-credential-backend">
            {{ credentials.storage({ backend: credentialBackendLabel }) }}
          </p>
        </div>
      </div>
      <DialogClose as-child>
        <AppButton color="primary" variant="solid" data-test-id="app-settings-done">
          {{ common.done }}
        </AppButton>
      </DialogClose>
    </AppDialogFooter>
  </AppDialogRoot>
</template>
