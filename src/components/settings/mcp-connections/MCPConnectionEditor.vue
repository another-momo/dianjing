<script setup lang="ts">
/**
 * MCP 连接编辑器（列表项点入 / 添加按钮进入）。
 *
 * 字段 6 项：名称/slug、transport（http/stdio）、url、headers（可选，value 永不回显）、
 * command/args（stdio）、env（可选，value 不回显）+ 状态徽章（未测 / 已连 N tools /
 * 失败原因）。
 */

import { computed, useTemplateRef } from 'vue'

import { useAutomationMessages, useCommonMessages } from '@open-pencil/vue'

import type { SettingsSaveResult } from '@/app/settings/save-result'
import { focusInvalidField } from '@/components/settings/layout/focus'
import SettingsGroup from '@/components/settings/layout/SettingsGroup.vue'
import SettingsRow from '@/components/settings/layout/SettingsRow.vue'
import SettingsSaveFeedback from '@/components/settings/layout/SettingsSaveFeedback.vue'
import SettingsSection from '@/components/settings/layout/SettingsSection.vue'
import ProviderSettingsField from '@/components/settings/provider/ProviderSettingsField.vue'
import AppButton from '@/components/ui/button/AppButton.vue'
import AppInput from '@/components/ui/input/AppInput.vue'
import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'

import type { MCPConnectionDraft, MCPConnectionFieldErrors } from './types'

const draft = defineModel<MCPConnectionDraft>('draft', { required: true })
const {
  busy,
  error,
  saveResult,
  fieldErrors = {},
  hasHeaders,
  hasEnv,
  connectionStatus,
  toolCount,
  statusError,
  stdioWarning
} = defineProps<{
  busy: boolean
  error: string
  saveResult?: SettingsSaveResult | null
  fieldErrors?: MCPConnectionFieldErrors
  hasHeaders: boolean
  hasEnv: boolean
  connectionStatus: 'untested' | 'connected' | 'failed'
  toolCount?: number
  statusError?: string
  stdioWarning: string
}>()
defineEmits<{
  cancel: []
  save: []
  remove: []
  blurField: [field: 'name' | 'url' | 'command' | 'argsText']
  addHeader: []
  removeHeader: [index: number]
  updateHeaderKey: [index: number, value: string]
  updateHeaderValue: [index: number, value: string]
  addEnv: []
  removeEnv: [index: number]
  updateEnvKey: [index: number, value: string]
  updateEnvValue: [index: number, value: string]
}>()

const automation = useAutomationMessages()
const common = useCommonMessages()
const formElement = useTemplateRef<HTMLFormElement>('formElement')
defineExpose({ focusInvalid: () => focusInvalidField(formElement.value) })

const statusLabel = computed(() => {
  if (connectionStatus === 'connected') {
    return automation.value.statusConnected.replace('{count}', String(toolCount ?? 0))
  }
  if (connectionStatus === 'failed') {
    return automation.value.statusFailed
  }
  return automation.value.statusUntested
})

function statusTone(): string {
  if (connectionStatus === 'connected') return 'text-success'
  if (connectionStatus === 'failed') return 'text-danger'
  return 'text-muted'
}

// 凭据区提示文案：已配置 → 保留/替换语义；未配置且无行 → 空态；有行在填 → 不打扰
const headersHintText = computed(() => {
  if (hasHeaders) return automation.value.savedHeadersHint
  return draft.value.headers.length === 0 ? automation.value.headersEmpty : ''
})

const envHintText = computed(() => {
  if (hasEnv) return automation.value.savedEnvHint
  return draft.value.env.length === 0 ? automation.value.envEmpty : ''
})
</script>

<template>
  <form
    ref="formElement"
    class="flex flex-col gap-4"
    :aria-busy="busy"
    novalidate
    @submit.prevent="$emit('save')"
  >
    <!-- 在 AI 段流内联渲染——不套 SettingsPage（整页 tab 根容器，见列表态同注） -->
    <SettingsSection>
      <template #title>{{
        draft.id ? automation.editConnection : automation.addServerConnection
      }}</template>
      <template #description>{{ automation.connectionEditorDescription }}</template>
      <fieldset :disabled="busy" class="flex min-w-0 flex-col gap-3">
        <div class="flex items-center gap-2 text-xs" :class="statusTone()" role="status">
          <icon-lucide-circle-dot class="size-3" />
          <span>{{ statusLabel }}</span>
          <span v-if="connectionStatus === 'failed' && statusError" class="text-muted"
            >— {{ statusError }}</span
          >
        </div>

        <ProviderSettingsField
          v-slot="{ control }"
          :label="automation.connectionName"
          :hint="automation.connectionNameHint"
          :error="fieldErrors.name"
          @blur="$emit('blurField', 'name')"
        >
          <AppInput
            v-bind="control"
            v-model="draft.name"
            tone="panel"
            :aria-label="automation.connectionName"
            autocomplete="off"
            :disabled="busy || draft.id !== null"
          />
        </ProviderSettingsField>

        <SettingsGroup>
          <SettingsRow :label="automation.transportHttp">
            <AppSwitch
              :model-value="draft.transport === 'http'"
              :label="automation.transportHttp"
              :disabled="busy"
              @update:model-value="draft.transport = $event ? 'http' : 'stdio'"
            />
          </SettingsRow>
        </SettingsGroup>

        <template v-if="draft.transport === 'http'">
          <ProviderSettingsField
            v-slot="{ control }"
            :label="automation.serverURL"
            :hint="automation.serverURLHint"
            :error="fieldErrors.url"
            @blur="$emit('blurField', 'url')"
          >
            <AppInput
              v-bind="control"
              v-model="draft.url"
              type="url"
              tone="panel"
              :aria-label="automation.serverURL"
              placeholder="https://example.com/mcp"
              autocomplete="off"
              autocapitalize="off"
              :spellcheck="false"
            />
          </ProviderSettingsField>

          <SettingsGroup>
            <SettingsRow :label="automation.headersTitle" :description="headersHintText">
              <AppButton
                color="neutral"
                variant="outline"
                :disabled="busy"
                @click="$emit('addHeader')"
              >
                <template #leading><icon-lucide-plus class="size-3.5" /></template>
                {{ automation.addHeader }}
              </AppButton>
            </SettingsRow>
            <SettingsRow
              v-for="(entry, index) in draft.headers"
              :key="`header-${index}`"
              :label="entry.key || automation.headerKeyPlaceholder"
            >
              <div class="flex w-full items-center gap-2">
                <AppInput
                  :model-value="entry.key"
                  :aria-label="`${automation.headersTitle} key ${index + 1}`"
                  :placeholder="automation.headerKeyPlaceholder"
                  :disabled="busy"
                  @update:model-value="$emit('updateHeaderKey', index, String($event))"
                />
                <AppInput
                  :model-value="entry.value"
                  type="password"
                  :aria-label="`${automation.headersTitle} value ${index + 1}`"
                  :placeholder="automation.headerValuePlaceholder"
                  :disabled="busy"
                  autocomplete="off"
                  @update:model-value="$emit('updateHeaderValue', index, String($event))"
                />
                <AppButton
                  color="neutral"
                  variant="ghost"
                  :disabled="busy"
                  :aria-label="common.clear"
                  @click="$emit('removeHeader', index)"
                >
                  <icon-lucide-trash-2 class="size-3.5" />
                </AppButton>
              </div>
            </SettingsRow>
          </SettingsGroup>
        </template>

        <template v-else>
          <div
            class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            <icon-lucide-terminal class="mr-1 inline size-3.5 align-text-bottom" />
            {{ stdioWarning }}
          </div>
          <ProviderSettingsField
            v-slot="{ control }"
            :label="automation.commandLabel"
            :hint="automation.commandHint"
            :error="fieldErrors.command"
            @blur="$emit('blurField', 'command')"
          >
            <AppInput
              v-bind="control"
              v-model="draft.command"
              tone="panel"
              :aria-label="automation.commandLabel"
              placeholder="npx"
              autocomplete="off"
              autocapitalize="off"
              :spellcheck="false"
            />
          </ProviderSettingsField>
          <ProviderSettingsField
            v-slot="{ control }"
            :label="automation.argsLabel"
            :hint="automation.argsHint"
            :error="fieldErrors.args"
            @blur="$emit('blurField', 'argsText')"
          >
            <AppInput
              v-bind="control"
              v-model="draft.argsText"
              tone="panel"
              :aria-label="automation.argsLabel"
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              autocomplete="off"
              autocapitalize="off"
              :spellcheck="false"
            />
          </ProviderSettingsField>

          <SettingsGroup>
            <SettingsRow :label="automation.envTitle" :description="envHintText">
              <AppButton
                color="neutral"
                variant="outline"
                :disabled="busy"
                @click="$emit('addEnv')"
              >
                <template #leading><icon-lucide-plus class="size-3.5" /></template>
                {{ automation.addEnv }}
              </AppButton>
            </SettingsRow>
            <SettingsRow
              v-for="(entry, index) in draft.env"
              :key="`env-${index}`"
              :label="entry.key || automation.envKeyPlaceholder"
            >
              <div class="flex w-full items-center gap-2">
                <AppInput
                  :model-value="entry.key"
                  :aria-label="`${automation.envTitle} key ${index + 1}`"
                  :placeholder="automation.envKeyPlaceholder"
                  :disabled="busy"
                  @update:model-value="$emit('updateEnvKey', index, String($event))"
                />
                <AppInput
                  :model-value="entry.value"
                  type="password"
                  :aria-label="`${automation.envTitle} value ${index + 1}`"
                  :placeholder="automation.envValuePlaceholder"
                  :disabled="busy"
                  autocomplete="off"
                  @update:model-value="$emit('updateEnvValue', index, String($event))"
                />
                <AppButton
                  color="neutral"
                  variant="ghost"
                  :disabled="busy"
                  :aria-label="common.clear"
                  @click="$emit('removeEnv', index)"
                >
                  <icon-lucide-trash-2 class="size-3.5" />
                </AppButton>
              </div>
            </SettingsRow>
          </SettingsGroup>
        </template>
      </fieldset>
      <SettingsSaveFeedback :error="error" :result="saveResult" />
    </SettingsSection>
    <div class="flex items-center justify-end gap-2">
      <AppButton
        v-if="draft.id"
        class="mr-auto"
        color="error"
        variant="link"
        :disabled="busy"
        @click="$emit('remove')"
        >{{ automation.deleteConnection }}</AppButton
      >
      <AppButton :disabled="busy" @click="$emit('cancel')">{{ common.cancel }}</AppButton>
      <AppButton type="submit" color="primary" variant="solid" :loading="busy">{{
        common.save
      }}</AppButton>
    </div>
  </form>
</template>
