<script setup lang="ts">
/**
 * MCP 连接设置面（§5.6 拷改 + 路径分离）：列表 + 添加/编辑/删除 + 空态 +
 * 保存反馈 + 状态徽章。
 *
 * 路径：src/components/settings/mcp-connections/（避开墓碑 src/components/settings/mcp/）。
 * 数据层：fetch client（照 image-gen/client.ts 样板，详 ./client）。
 * 表单/编排：照上游 useMCPConnectionForm + useMCPConnectionSettings（详 ./form + ./use），
 * 字段切双档 transport、headers/env 表、stdio 子进程提示、状态徽章三态。
 */

import { AlertDialogAction, AlertDialogCancel } from 'reka-ui'
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue'

import { useAutomationMessages, useCommonMessages, useSettingsMessages } from '@open-pencil/vue'

import { useSettingsFormGuard } from '@/app/settings/navigation/use'
import SettingsSection from '@/components/settings/layout/SettingsSection.vue'
import AppButton from '@/components/ui/button/AppButton.vue'
import { AppAlertDialogRoot, AppDialogFooter, AppDialogHeader } from '@/components/ui/dialog'
import AppPlaceholder from '@/components/ui/feedback/AppPlaceholder.vue'
import AppActionRow from '@/components/ui/list/AppActionRow.vue'

import {
  mcpConnectionList,
  mcpConnectionListError,
  mcpConnectionListLoading,
  refreshMCPConnections
} from './client'
import { useMCPConnectionForm } from './form'
import MCPConnectionEditor from './MCPConnectionEditor.vue'
import { compactKeyValuePairs, type MCPConnectionDraft } from './types'
import { useMCPConnectionSettings } from './use'

const automation = useAutomationMessages()
const common = useCommonMessages()
const settings = useSettingsMessages()

const editing = ref(false)
const deleteOpen = ref(false)

const editorElement = useTemplateRef('editorElement')
const form = useMCPConnectionForm(
  computed(() => ({
    requiredField: settings.value.requiredField,
    connectionNameInvalid: automation.value.connectionNameInvalid,
    duplicateName: automation.value.duplicateConnectionName,
    serverURLHint: automation.value.serverURLHint,
    commandInvalid: automation.value.commandInvalid,
    argsInvalid: automation.value.argsInvalid
  })),
  (name, excludeSlug) => {
    const lower = name.toLowerCase()
    return mcpConnectionList.value.some(
      (connection) => connection.slug !== excludeSlug && connection.slug.toLowerCase() === lower
    )
  }
)
const { draft, fieldErrors } = form
const connection = useMCPConnectionSettings(draft)

const dirty = computed(() => form.dirty.value)
const busy = computed(
  () => connection.busy.value || form.isSubmitting.value || mcpConnectionListLoading.value
)
const stdioWarning = computed(() => automation.value.stdioLocalProcessHint)
// 模板向 props 传值需解包——connection 是普通对象，嵌套 ref 模板不自动解
const connectionError = computed(() => connection.error.value)
const connectionSaveResult = computed(() => connection.saveResult.value)

useSettingsFormGuard({ dirty, busy, cancel: cancel }, editing)

onMounted(() => {
  void refreshMCPConnections()
})

watch(
  () => draft.value.transport,
  () => {
    form.blur('command')
    form.blur('url')
  }
)

function startAdd(): void {
  connection.startAdd()
  editing.value = true
}

function startEdit(targetSlug: string): void {
  const source = mcpConnectionList.value.find((connection) => connection.slug === targetSlug)
  if (!source) return
  // 名称即 slug（编辑态锁名）；headers/env 预置空行 = 凭据「已配置」占位——
  // 空行保存时被压缩丢弃，后端按「省略 = 保留旧值」处理
  const draftSource: MCPConnectionDraft = {
    id: source.slug,
    name: source.slug,
    transport: source.transport,
    url: source.url ?? '',
    command: source.command ?? '',
    argsText: (source.args ?? []).join(' '),
    headers: source.hasHeaders ? [{ key: '', value: '' }] : [],
    env: source.hasEnv ? [{ key: '', value: '' }] : []
  }
  connection.startEdit(draftSource)
  editing.value = true
}

function cancel(): void {
  connection.startAdd()
  editing.value = false
}

const submit = form.handleSubmit(async () => {
  const compacted = {
    ...draft.value,
    headers: compactKeyValuePairs(draft.value.headers),
    env: compactKeyValuePairs(draft.value.env)
  }
  draft.value = compacted
  if ((await connection.save()) === 'saved') cancel()
})

async function save(): Promise<void> {
  if (busy.value) return
  await submit()
  await editorElement.value?.focusInvalid()
}

async function remove(): Promise<void> {
  if (await connection.remove()) cancel()
  deleteOpen.value = false
}

function headerAdd(): void {
  draft.value = { ...draft.value, headers: [...draft.value.headers, { key: '', value: '' }] }
}

function headerRemove(index: number): void {
  draft.value = {
    ...draft.value,
    headers: draft.value.headers.filter((_, i) => i !== index)
  }
}

function headerKey(index: number, value: string): void {
  draft.value = {
    ...draft.value,
    headers: draft.value.headers.map((entry, i) => (i === index ? { ...entry, key: value } : entry))
  }
}

function headerValue(index: number, value: string): void {
  draft.value = {
    ...draft.value,
    headers: draft.value.headers.map((entry, i) => (i === index ? { ...entry, value } : entry))
  }
}

function envAdd(): void {
  draft.value = { ...draft.value, env: [...draft.value.env, { key: '', value: '' }] }
}

function envRemove(index: number): void {
  draft.value = {
    ...draft.value,
    env: draft.value.env.filter((_, i) => i !== index)
  }
}

function envKey(index: number, value: string): void {
  draft.value = {
    ...draft.value,
    env: draft.value.env.map((entry, i) => (i === index ? { ...entry, key: value } : entry))
  }
}

function envValue(index: number, value: string): void {
  draft.value = {
    ...draft.value,
    env: draft.value.env.map((entry, i) => (i === index ? { ...entry, value } : entry))
  }
}

const headerHasConfigured = computed(() => {
  const current = mcpConnectionList.value.find((item) => item.slug === draft.value.id)
  return current?.hasHeaders ?? false
})

const envHasConfigured = computed(() => {
  const current = mcpConnectionList.value.find((item) => item.slug === draft.value.id)
  return current?.hasEnv ?? false
})

const currentStatus = computed(() => {
  const current = mcpConnectionList.value.find((item) => item.slug === draft.value.id)
  return current?.status ?? 'untested'
})

const currentToolCount = computed(() => {
  const current = mcpConnectionList.value.find((item) => item.slug === draft.value.id)
  return current?.toolCount
})

const currentStatusError = computed(() => {
  const current = mcpConnectionList.value.find((item) => item.slug === draft.value.id)
  return current?.error
})

const transportLabel = (item: (typeof mcpConnectionList.value)[number]): string => {
  return item.transport === 'http'
    ? automation.value.transportHttp
    : automation.value.transportStdio
}

const statusLabel = (item: (typeof mcpConnectionList.value)[number]): string => {
  if (item.status === 'connected') {
    return automation.value.statusConnected.replace('{count}', String(item.toolCount ?? 0))
  }
  if (item.status === 'failed') {
    return automation.value.statusFailed
  }
  return automation.value.statusUntested
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <MCPConnectionEditor
      v-if="editing"
      ref="editorElement"
      v-model:draft="draft"
      :busy="busy"
      :error="connectionError"
      :save-result="connectionSaveResult"
      :field-errors="fieldErrors"
      :has-headers="headerHasConfigured"
      :has-env="envHasConfigured"
      :connection-status="currentStatus"
      :tool-count="currentToolCount"
      :status-error="currentStatusError"
      :stdio-warning="stdioWarning"
      @cancel="cancel"
      @save="save"
      @blur-field="form.blur"
      @remove="deleteOpen = true"
      @add-header="headerAdd"
      @remove-header="headerRemove"
      @update-header-key="headerKey"
      @update-header-value="headerValue"
      @add-env="envAdd"
      @remove-env="envRemove"
      @update-env-key="envKey"
      @update-env-value="envValue"
    />

    <!-- 本区块在 AI 段流内联渲染——不套 SettingsPage：那是整页 tab 根容器
         （自带 AppDialogBody 内边距与滚动），嵌在流内会与兄弟区块双倍缩进 -->
    <SettingsSection v-else :aria-busy="busy" data-mcp-connections>
      <template #title>{{ automation.connections }}</template>
      <template #description>{{ automation.connectionsDescription }}</template>
      <AppButton class="self-start" variant="outline" :loading="busy" @click="startAdd">
        <template #leading><icon-lucide-plus class="size-3.5" /></template>
        {{ automation.addConnection }}
      </AppButton>
      <div v-if="mcpConnectionList.length" class="flex flex-col gap-1.5">
        <AppActionRow
          v-for="item in mcpConnectionList"
          :key="item.slug"
          :disabled="busy"
          @click="startEdit(item.slug)"
        >
          <template #leading><icon-lucide-plug class="size-3.5" /></template>
          {{ item.slug }}
          <template #description>{{ transportLabel(item) }}</template>
          <template #trailing>
            <span class="text-xs">{{ statusLabel(item) }}</span>
            <icon-lucide-chevron-right class="size-3.5" />
          </template>
        </AppActionRow>
      </div>
      <AppPlaceholder v-else-if="mcpConnectionListError" :label="mcpConnectionListError" />
      <AppPlaceholder v-else :label="automation.noConnections" />
    </SettingsSection>

    <AppAlertDialogRoot v-model:open="deleteOpen">
      <AppDialogHeader
        :heading="automation.deleteConnection"
        :description="automation.deleteConnectionDescription"
        :show-close="false"
      />
      <AppDialogFooter>
        <AlertDialogCancel as-child>
          <AppButton>{{ common.cancel }}</AppButton>
        </AlertDialogCancel>
        <AlertDialogAction as-child>
          <AppButton color="error" variant="solid" :loading="busy" @click="remove">
            {{ automation.deleteConnection }}
          </AppButton>
        </AlertDialogAction>
      </AppDialogFooter>
    </AppAlertDialogRoot>
  </div>
</template>
