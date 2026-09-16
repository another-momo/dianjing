<script setup lang="ts">
/**
 * ux-polish④：设计模型卡——合并面板顶部的四字段（provider / model / thinking / api key）。
 *  无条件渲染（catalog 就绪后），引导门 unlock 路径全靠它（无指派时存 key 自动指派）。
 *
 * 从 PiModelsPanel.vue 拆出：行为零变化，状态真源仍在父面板（selectedProviderId 由父
 * 面板 watch catalog 钉初值 → 子卡 v-model 反向同步；保存/清除/验证/思考/模型选择事件
 * 子卡 emit → 父面板写指派与 row/busy/state）。
 * 子卡独占 UI：provider / model 搜索框、selectedProvider 派生、sourceLabel 摘要。
 */
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
  type AcceptableValue
} from 'reka-ui'
import { computed, ref } from 'vue'

import type { PiDesignAssignment } from '@/app/ai/pi-backend/assignment'
import type { PiCatalogModel, PiCatalogProvider } from '@/app/ai/pi-backend/catalog'
import type { PiThinkingLevel } from '@/app/ai/pi-backend/client'
import {
  classifyAuthSource,
  filterCatalogModels,
  filterCatalogProviders,
  groupProvidersByConfigured,
  type VerifyResultClass
} from '@/app/ai/pi-backend/models-panel-rules'
import { useForkPi } from '@/app/i18n/fork'
import Tip from '@/components/ui/overlay/Tip.vue'

const dialogs = useForkPi()

const {
  providers,
  assignment,
  modelDrafts,
  keyDrafts,
  busyProviderId,
  rowErrors,
  verifyStates,
  isCurrentProvider,
  connectedLabel,
  modelNeedsCredentialLabel
} = defineProps<{
  providers: PiCatalogProvider[]
  assignment: PiDesignAssignment | null
  modelDrafts: Record<string, string>
  keyDrafts: Record<string, string>
  busyProviderId: string | null
  rowErrors: Record<string, string>
  verifyStates: Record<string, VerifyResultClass | 'busy'>
  isCurrentProvider: (providerId: string) => boolean
  connectedLabel: string
  modelNeedsCredentialLabel: string
}>()

const emit = defineEmits<{
  'update:keyDraft': [value: string]
  'provider-change': [providerId: string]
  'model-change': [modelId: string]
  'thinking-change': [level: PiThinkingLevel]
  'save-key': []
  'clear-key': []
  'verify-key': []
}>()

/** 子卡本地状态——纯 UI（搜索框 + 选中 provider 派生），不外泄 */
const selectedProviderId = defineModel<string>('selectedProviderId', { default: '' })
const providerSearchDesign = ref('')
const modelSearchDesign = ref('')

/** reka ComboboxInput 的 immediate watcher 会把当前选中值播种进输入框 v-model
 *  （dist/Combobox/ComboboxInput.js resetSearchTerm）——与选中值完全相等的
 *  搜索词视为无过滤，否则开列表只剩选中项；用户清空后键入不受影响。 */
const designProviderFilterTerm = computed(() =>
  providerSearchDesign.value === selectedProviderId.value ? '' : providerSearchDesign.value
)
const designModelFilterTerm = computed(() => {
  const currentModelId = modelFor(selectedProviderId.value)
  return modelSearchDesign.value === currentModelId ? '' : modelSearchDesign.value
})

/** 设计模型卡的 provider 选项——按 groupProvidersByConfigured 顺序（已配置置顶）+ filterCatalogProviders 搜索过滤。
 *  与现有 provider 列表同款分组头文案/样式。 */
const designProviderGroups = computed(() =>
  groupProvidersByConfigured(filterCatalogProviders(providers, designProviderFilterTerm.value))
)

const selectedProvider = computed<PiCatalogProvider | null>(() => {
  const id = selectedProviderId.value
  if (!id) return null
  return providers.find((p) => p.id === id) ?? null
})

/** 设计模型卡的当前 provider 模型列表（按 catalog 原序） */
const designProviderModels = computed<PiCatalogModel[]>(() => selectedProvider.value?.models ?? [])

/** 设计模型卡 — modelFor 派生：父面板 modelDrafts > 指派 modelId > 空。
 *  子卡独占：父面板的行内 Combobox 已删（讨论稿 §4 指派段独立 UI 删除），唯一消费即本卡。 */
function modelFor(providerId: string): string {
  const v = modelDrafts[providerId]
  if (v) return v
  if (assignment?.providerId === providerId) {
    return assignment.modelId
  }
  return ''
}

/** 设计模型卡 — thinking 派生：thinking 挂指派不挂 provider（2026-09-16 拍板）。 */
function thinkingFor(providerId: string): PiThinkingLevel {
  if (assignment?.providerId === providerId) {
    return assignment.thinkingLevel ?? 'off'
  }
  return 'off'
}

function thinkingLabel(level: PiThinkingLevel): string {
  const labels: Record<PiThinkingLevel, string> = {
    off: dialogs.value.thinkingOff,
    minimal: dialogs.value.thinkingMinimal,
    low: dialogs.value.thinkingLow,
    medium: dialogs.value.thinkingMedium,
    high: dialogs.value.thinkingHigh,
    xhigh: dialogs.value.thinkingExtraHigh
  }
  return labels[level]
}

/** 子卡独占 key 状态摘要——沿用父面板现有 provider 行内 source 标签语义（仅 env 来源打标） */
function designKeySourceLabel(): string | null {
  const provider = selectedProvider.value
  if (!provider?.auth.configured) return null
  const sourceClass = classifyAuthSource(provider.auth.source)
  if (sourceClass === 'environment') return dialogs.value.providerAuthSourceEnvironment
  return null
}

function supportsImageInput(model: PiCatalogModel): boolean {
  return model.input.includes('image')
}

function contextLabel(model: PiCatalogModel): string {
  return `${Math.round(model.contextWindow / 1024)}k`
}

/** 设计模型卡 — provider 变更：触发父面板写 draftModel + 可能 setPiDesignAssignment；本地清搜索框 */
function onDesignProviderChange(value: AcceptableValue): void {
  if (typeof value !== 'string') return
  const providerId = value
  if (!providerId) return
  selectedProviderId.value = providerId
  providerSearchDesign.value = ''
  emit('provider-change', providerId)
}

function onDesignModelChange(value: AcceptableValue): void {
  if (typeof value !== 'string') return
  emit('model-change', value)
}

function onDesignThinkingChange(value: AcceptableValue): void {
  if (typeof value !== 'string') return
  emit('thinking-change', value as PiThinkingLevel)
}

function onDesignSaveKey(): void {
  emit('save-key')
}

function onDesignClearKey(): void {
  emit('clear-key')
}

function onDesignVerifyKey(): void {
  emit('verify-key')
}

/** keyDraft 输入双向绑定——keyDrafts 父面板真源，子卡只映射到当前 selectedProviderId 行 */
const currentKeyDraft = computed({
  get: () => keyDrafts[selectedProviderId.value] ?? '',
  set: (value: string) => emit('update:keyDraft', value)
})
</script>

<template>
  <section
    v-if="providers.length > 0"
    class="mb-3 flex flex-col gap-1.5"
    data-test-id="pi-design-card"
  >
    <h3 class="text-xs font-semibold text-surface">{{ dialogs.designCardTitle }}</h3>
    <div class="rounded border border-border p-3">
      <label class="block text-[10px] text-muted">{{ dialogs.designCardProvider }}</label>
      <ComboboxRoot
        :model-value="selectedProviderId"
        class="relative mt-1"
        @update:model-value="onDesignProviderChange"
      >
        <ComboboxAnchor as-child>
          <ComboboxTrigger
            class="flex w-full items-center justify-between gap-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
            data-test-id="pi-design-provider-trigger"
          >
            <span class="min-w-0 flex-1 truncate text-left">
              <template v-if="selectedProvider">
                {{ selectedProvider.name }}
              </template>
              <template v-else>—</template>
            </span>
            <icon-lucide-chevron-down class="size-3 shrink-0 text-muted" />
          </ComboboxTrigger>
        </ComboboxAnchor>
        <ComboboxPortal>
          <ComboboxContent
            position="popper"
            :side-offset="2"
            class="z-[110] min-w-[var(--reka-combobox-trigger-width)] overflow-hidden rounded-md bg-panel p-1 text-[11px] shadow-[0_8px_30px_rgb(0_0_0/0.4)]"
          >
            <ComboboxInput
              v-model="providerSearchDesign"
              class="mb-1 w-full rounded border border-border bg-panel-field px-2 py-1 text-[11px] text-surface outline-none focus:border-panel-focus"
              :placeholder="dialogs.designCardProviderSearchPlaceholder"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              :spellcheck="false"
              data-test-id="pi-design-provider-search"
            />
            <ComboboxViewport class="scrollbar-thin max-h-48 overflow-y-auto">
              <template v-for="group in designProviderGroups" :key="group.id">
                <p
                  class="px-2 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted uppercase"
                  data-test-id="pi-design-provider-group-header"
                >
                  {{
                    group.id === 'configured'
                      ? dialogs.providerGroupConfigured
                      : dialogs.providerGroupAll
                  }}
                </p>
                <ComboboxItem
                  v-for="provider in group.providers"
                  :key="provider.id"
                  :value="provider.id"
                  :text-value="`${provider.name} ${provider.id}`"
                  class="relative flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-surface select-none data-[highlighted]:bg-hover"
                  :data-provider-id="provider.id"
                  data-test-id="pi-design-provider-item"
                >
                  <ComboboxItemIndicator class="flex size-3 shrink-0 items-center justify-center">
                    <icon-lucide-check class="size-3 text-accent" />
                  </ComboboxItemIndicator>
                  <span class="min-w-0 flex-1 truncate">{{ provider.name }}</span>
                  <span class="flex shrink-0 items-center gap-1 text-[9px] text-muted">
                    <span class="truncate">{{ provider.id }}</span>
                    <span
                      class="size-1.5 rounded-full bg-muted"
                      :class="provider.auth.configured ? 'bg-[var(--color-success)]' : ''"
                      :data-state="provider.auth.configured ? 'configured' : 'missing'"
                    />
                    <span>{{
                      provider.auth.configured ? connectedLabel : modelNeedsCredentialLabel
                    }}</span>
                  </span>
                  <span
                    v-if="isCurrentProvider(provider.id)"
                    class="shrink-0 text-[10px] font-medium text-accent"
                    data-test-id="pi-design-provider-current"
                  >
                    {{ dialogs.currentAssignmentCurrent }}
                  </span>
                </ComboboxItem>
              </template>
              <ComboboxEmpty
                class="px-2 py-1 text-[10px] text-muted"
                data-test-id="pi-design-provider-empty"
              >
                {{ dialogs.designCardProviderEmpty }}
              </ComboboxEmpty>
            </ComboboxViewport>
          </ComboboxContent>
        </ComboboxPortal>
      </ComboboxRoot>

      <label class="mt-2 block text-[10px] text-muted">{{ dialogs.designCardModel }}</label>
      <ComboboxRoot
        :model-value="modelFor(selectedProviderId)"
        class="relative mt-1"
        :disabled="!selectedProvider"
        @update:model-value="onDesignModelChange"
      >
        <ComboboxAnchor as-child>
          <ComboboxTrigger
            class="flex w-full items-center justify-between gap-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus disabled:opacity-50"
            data-test-id="pi-design-model-trigger"
          >
            <span class="min-w-0 flex-1 truncate text-left">
              <template v-if="modelFor(selectedProviderId)">
                {{
                  designProviderModels.find((m) => m.id === modelFor(selectedProviderId))?.name ??
                  modelFor(selectedProviderId)
                }}
              </template>
              <template v-else>—</template>
            </span>
            <icon-lucide-chevron-down class="size-3 shrink-0 text-muted" />
          </ComboboxTrigger>
        </ComboboxAnchor>
        <ComboboxPortal>
          <ComboboxContent
            position="popper"
            :side-offset="2"
            class="z-[110] min-w-[var(--reka-combobox-trigger-width)] overflow-hidden rounded-md bg-panel p-1 text-[11px] shadow-[0_8px_30px_rgb(0_0_0/0.4)]"
          >
            <ComboboxInput
              v-model="modelSearchDesign"
              class="mb-1 w-full rounded border border-border bg-panel-field px-2 py-1 text-[11px] text-surface outline-none focus:border-panel-focus"
              :placeholder="dialogs.modelSearchPlaceholder"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              :spellcheck="false"
              data-test-id="pi-design-model-search"
            />
            <ComboboxViewport class="scrollbar-thin max-h-48 overflow-y-auto">
              <ComboboxItem
                v-for="model in filterCatalogModels(designProviderModels, designModelFilterTerm)"
                :key="model.id"
                :value="model.id"
                :text-value="`${model.name} ${model.id}`"
                class="relative flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-surface outline-none select-none data-[highlighted]:bg-hover"
                :data-model-id="model.id"
                data-test-id="pi-design-model-item"
              >
                <ComboboxItemIndicator class="flex size-3 shrink-0 items-center justify-center">
                  <icon-lucide-check class="size-3 text-accent" />
                </ComboboxItemIndicator>
                <span class="min-w-0 flex-1 truncate">{{ model.name }}</span>
                <Tip v-if="supportsImageInput(model)" :label="dialogs.modelSupportsImage">
                  <span class="flex shrink-0 items-center text-muted">
                    <icon-lucide-image class="size-3" />
                  </span>
                </Tip>
                <span v-if="model.contextWindow" class="shrink-0 text-[10px] text-muted">
                  {{ contextLabel(model) }}
                </span>
              </ComboboxItem>
              <ComboboxEmpty
                class="px-2 py-1 text-[10px] text-muted"
                data-test-id="pi-design-model-empty"
              >
                {{ dialogs.modelSearchEmpty }}
              </ComboboxEmpty>
            </ComboboxViewport>
          </ComboboxContent>
        </ComboboxPortal>
      </ComboboxRoot>

      <label class="mt-2 block text-[10px] text-muted">{{ dialogs.designCardThinking }}</label>
      <select
        :value="thinkingFor(selectedProviderId)"
        class="mt-1 w-full rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none"
        data-test-id="pi-design-thinking"
        @change="(e) => onDesignThinkingChange((e.target as HTMLSelectElement).value)"
      >
        <option value="off">{{ thinkingLabel('off') }}</option>
        <option value="minimal">{{ thinkingLabel('minimal') }}</option>
        <option value="low">{{ thinkingLabel('low') }}</option>
        <option value="medium">{{ thinkingLabel('medium') }}</option>
        <option value="high">{{ thinkingLabel('high') }}</option>
        <option value="xhigh">{{ thinkingLabel('xhigh') }}</option>
      </select>

      <label class="mt-2 block text-[10px] text-muted">{{ dialogs.designCardApiKey }}</label>
      <div class="mt-1 flex items-center gap-1.5">
        <input
          v-model="currentKeyDraft"
          type="password"
          class="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
          :placeholder="
            selectedProvider?.auth.configured
              ? dialogs.keyPlaceholderConfigured
              : dialogs.keyPlaceholderMissing
          "
          data-test-id="pi-design-key-input"
          @keydown.enter="onDesignSaveKey"
        />
        <button
          type="button"
          class="rounded bg-accent px-2 py-1.5 text-[10px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          data-test-id="pi-design-key-save"
          :disabled="busyProviderId === selectedProviderId || !currentKeyDraft"
          @click="onDesignSaveKey"
        >
          {{ dialogs.keySave }}
        </button>
        <button
          v-if="selectedProvider?.auth.configured"
          type="button"
          class="rounded border border-border px-2 py-1.5 text-[10px] text-muted hover:text-surface disabled:opacity-50"
          data-test-id="pi-design-key-clear"
          :disabled="busyProviderId === selectedProviderId"
          @click="onDesignClearKey"
        >
          {{ dialogs.keyClear }}
        </button>
      </div>
      <!-- 行级错误位（设计卡）—— 复用现有 rowErrors 的 selectedProviderId 行 -->
      <p
        v-if="selectedProviderId && rowErrors[selectedProviderId]"
        class="mt-1 text-[10px] text-red-400"
        data-test-id="pi-design-row-error"
      >
        {{ rowErrors[selectedProviderId] }}
      </p>
      <!-- 验证按钮（已配置 provider）+ 三态结果 + key 状态摘要——让用户一眼看出该 provider 是否有 key -->
      <div
        v-if="selectedProvider?.auth.configured"
        class="mt-1.5 flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          class="rounded border border-border px-2 py-1 text-[10px] text-muted hover:text-surface disabled:opacity-50"
          data-test-id="pi-design-key-verify"
          :disabled="verifyStates[selectedProviderId] === 'busy'"
          @click="onDesignVerifyKey"
        >
          <icon-lucide-shield-check class="mr-0.5 inline size-3" />
          {{ dialogs.providerVerify }}
        </button>
        <span
          v-if="verifyStates[selectedProviderId] === 'busy'"
          class="flex items-center gap-1 text-[10px] text-muted"
          data-test-id="pi-design-verify-state"
          data-verify-state="busy"
        >
          <icon-lucide-loader-2 class="size-3 animate-spin" />
        </span>
        <span
          v-else-if="verifyStates[selectedProviderId] === 'ok'"
          class="text-[10px] text-[var(--color-success)]"
          data-test-id="pi-design-verify-state"
          data-verify-state="ok"
        >
          {{ dialogs.providerVerifyOk }}
        </span>
        <span
          v-else-if="verifyStates[selectedProviderId] === 'failed'"
          class="text-[10px] text-red-400"
          data-test-id="pi-design-verify-state"
          data-verify-state="failed"
        >
          {{ dialogs.providerVerifyFailed }}
        </span>
        <span
          v-else-if="verifyStates[selectedProviderId] === 'unknown-error'"
          class="text-[10px] text-red-400"
          data-test-id="pi-design-verify-state"
          data-verify-state="unknown-error"
        >
          {{ dialogs.providerVerifyUnknownError }}
        </span>
        <!-- 已保存状态摘要：让用户一眼看出该 provider 已有 key -->
        <span
          class="ml-auto flex items-center gap-1 text-[10px] text-[var(--color-success)]"
          data-test-id="pi-design-key-status"
          data-key-state="configured"
        >
          <span class="size-1.5 rounded-full bg-[var(--color-success)]" />
          {{ dialogs.designCardKeyStatusConfigured }}
          <span
            v-if="designKeySourceLabel()"
            class="rounded border border-border px-1 text-[9px] text-muted"
            :data-source="selectedProvider?.auth.source"
            data-test-id="pi-design-key-source"
          >
            {{ designKeySourceLabel() }}
          </span>
        </span>
      </div>
      <div
        v-else-if="selectedProvider"
        class="mt-1.5 flex items-center gap-1 text-[10px] text-muted"
        data-test-id="pi-design-key-status"
        data-key-state="missing"
      >
        <span class="size-1.5 rounded-full bg-muted" />
        {{ dialogs.designCardKeyStatusMissing }}
      </div>
    </div>
  </section>
</template>
