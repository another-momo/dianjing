<script setup lang="ts">
/**
 * T21 P2 pi 模式设置面板：provider 目录、凭据（只进不出）、自定义 provider、
 * design 模型指派——全部走后端 admin API（client.ts），前端不持有任何 key。
 * 旧 ToolLoop 的 profile/connection/assignment 三表在 pi 模式下不展示、不迁移。
 *
 * T80：llm-provider UI 批（owner 决策已窄化范围）——
 * ①展开的 provider 模型列表加实时模糊搜索（name + id 大小写无关子串，不分组）；
 * ②design provider / model 两个 <select> 换成 reka-ui Combobox（自带搜索）；
 * ③模型行能力展示只做 image 输入 + context window，reasoning / cost 不展示。
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
import { computed, onMounted, ref } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { piDesignAssignment, setPiDesignAssignment } from '@/app/ai/pi-backend/assignment'
import type { PiCatalogModel } from '@/app/ai/pi-backend/catalog'
import {
  clearPiCredential,
  piCatalog,
  piCatalogError,
  piCatalogLoading,
  refreshPiCatalog,
  setPiCredential,
  upsertPiProvider
} from '@/app/ai/pi-backend/client'
import type { PiThinkingLevel } from '@/app/ai/pi-backend/client'
// T35：27 条 pi 段 i18n 迁回 fork seam——本面板 pi 段用 useForkPi()，通用段（models/connected/modelNeedsCredential）仍走 useI18n()
import { useForkPi } from '@/app/i18n/fork'
import Tip from '@/components/ui/overlay/Tip.vue'

const dialogs = useForkPi()
const { ai, collaboration: uiCollab } = useI18n()

const expandedProviderId = ref<string | null>(null)
const keyDrafts = ref<Record<string, string>>({})
const busyProviderId = ref<string | null>(null)
const actionError = ref<string | null>(null)

const showAddProvider = ref(false)
const customId = ref('')
const customBaseURL = ref('')
const customAPI = ref('openai-completions')
const customModelIds = ref('')
const CUSTOM_API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages']

const designProviderId = ref(piDesignAssignment.value?.providerId ?? '')
const designModelId = ref(piDesignAssignment.value?.modelId ?? '')
const designThinking = ref<PiThinkingLevel>(piDesignAssignment.value?.thinkingLevel ?? 'off')

/** T80：provider 展开区的模型搜索词（每次切换展开的 provider 时清空） */
const modelSearch = ref('')

/**
 * T80：reka-ui 的 ComboboxItem 禁止 value=""（空串是 root 的「清空选择」保留值，
 * 传空串会在 onMounted 前 throw）。所以「后端默认」项用哨兵值，回调里翻译回空串。
 */
const DESIGN_PROVIDER_DEFAULT = '__pi_backend_default__'

const providers = computed(() => piCatalog.value?.providers ?? [])

const designModels = computed(() => {
  const provider = providers.value.find((entry) => entry.id === designProviderId.value)
  return provider?.models ?? []
})

const designCredentialMissing = computed(() => {
  if (!designProviderId.value) return false
  const provider = providers.value.find((entry) => entry.id === designProviderId.value)
  return provider ? !provider.auth.configured : false
})

/**
 * T80：模型列表搜索——name + id 大小写无关子串匹配。
 * owner 决策「不用分组」，因此保持扁平列表、只过滤。
 */
function filterModels(models: readonly PiCatalogModel[], term: string): PiCatalogModel[] {
  const query = term.trim().toLowerCase()
  if (!query) return [...models]
  return models.filter(
    (model) => model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query)
  )
}

/** T80：能力展示只取 image 输入（catalog.input 含 'image'）——reasoning / cost 明示不展示 */
function supportsImageInput(model: PiCatalogModel): boolean {
  return model.input.includes('image')
}

function contextLabel(model: PiCatalogModel): string {
  return `${Math.round(model.contextWindow / 1024)}k`
}

const designProviderLabel = computed(() => {
  const provider = providers.value.find((entry) => entry.id === designProviderId.value)
  return provider ? `${provider.name} (${provider.id})` : dialogs.value.designModelDefault
})

const designModelLabel = computed(() => {
  const model = designModels.value.find((entry) => entry.id === designModelId.value)
  return model ? `${model.name} (${model.id})` : dialogs.value.designModelField
})

/** 与已持久化值比对——任一字段不同即未保存 */
const designDirty = computed(() => {
  const saved = piDesignAssignment.value
  const savedProvider = saved?.providerId ?? ''
  const savedModel = saved?.modelId ?? ''
  const savedThinking = saved?.thinkingLevel ?? 'off'
  return (
    designProviderId.value !== savedProvider ||
    designModelId.value !== savedModel ||
    designThinking.value !== savedThinking
  )
})

function thinkingLabel(level: PiThinkingLevel): string {
  // T38：useForkPi() 返回 Ref，script 内访问必须 .value（模板插值不在此列）
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

function toggleProvider(providerId: string): void {
  expandedProviderId.value = expandedProviderId.value === providerId ? null : providerId
  modelSearch.value = ''
}

async function saveKey(providerId: string): Promise<void> {
  const key = (keyDrafts.value[providerId] ?? '').trim()
  if (!key) return
  busyProviderId.value = providerId
  actionError.value = null
  try {
    await setPiCredential(providerId, key)
    keyDrafts.value[providerId] = ''
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busyProviderId.value = null
  }
}

async function clearKey(providerId: string): Promise<void> {
  busyProviderId.value = providerId
  actionError.value = null
  try {
    await clearPiCredential(providerId)
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busyProviderId.value = null
  }
}

async function saveCustomProvider(): Promise<void> {
  const models = customModelIds.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  busyProviderId.value = '__custom__'
  actionError.value = null
  try {
    await upsertPiProvider({
      id: customId.value.trim(),
      baseUrl: customBaseURL.value.trim(),
      api: customAPI.value,
      models
    })
    customId.value = ''
    customBaseURL.value = ''
    customModelIds.value = ''
    showAddProvider.value = false
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busyProviderId.value = null
  }
}

function selectDesignProvider(providerId: string): void {
  designProviderId.value = providerId
  const provider = providers.value.find((entry) => entry.id === providerId)
  const first = provider?.models[0]
  designModelId.value = first?.id ?? ''
}

/** T80：Combobox 单选回调——reka-ui 给出的是 AcceptableValue，非 string 一律忽略 */
function onDesignProviderChange(value: AcceptableValue): void {
  if (typeof value !== 'string') return
  selectDesignProvider(value === DESIGN_PROVIDER_DEFAULT ? '' : value)
}

function onDesignModelChange(value: AcceptableValue): void {
  if (typeof value !== 'string') return
  designModelId.value = value
}

function saveDesignModel(): void {
  if (!designProviderId.value || !designModelId.value) {
    setPiDesignAssignment(null)
    return
  }
  setPiDesignAssignment({
    providerId: designProviderId.value,
    modelId: designModelId.value,
    ...(designThinking.value !== 'off' ? { thinkingLevel: designThinking.value } : {})
  })
}

onMounted(() => void refreshPiCatalog())
</script>

<template>
  <!-- T91k：根节点不再自滚——滚动职责上交 SettingsDialog 标签页容器，
       让 AgentSettingsPanel 跟在模型清单下方同流滚动（owner 拍板） -->
  <div class="flex flex-col">
    <section data-test-id="pi-providers-panel">
      <div class="mb-2 flex items-center justify-between">
        <div>
          <h3 class="text-xs font-semibold text-surface">{{ ai.modelsTitle }}</h3>
          <p class="text-[10px] text-muted">{{ dialogs.modelsDescription }}</p>
        </div>
        <button
          type="button"
          class="flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-[11px] font-medium text-surface hover:bg-panel-field"
          data-test-id="pi-catalog-refresh"
          :disabled="piCatalogLoading"
          @click="refreshPiCatalog"
        >
          <icon-lucide-refresh-cw class="size-3" :class="{ 'animate-spin': piCatalogLoading }" />
          {{ dialogs.catalogRefresh }}
        </button>
      </div>

      <p
        v-if="piCatalogError"
        class="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400"
        data-test-id="pi-catalog-offline"
      >
        {{ dialogs.catalogOffline }} ({{ piCatalogError }})
      </p>
      <p v-if="actionError" class="mt-1 text-[10px] text-red-400" data-test-id="pi-action-error">
        {{ actionError }}
      </p>

      <div class="mt-2 flex flex-col gap-1.5">
        <div
          v-for="provider in providers"
          :key="provider.id"
          class="rounded border border-border bg-panel-field"
          :data-provider-id="provider.id"
          data-test-id="pi-provider-row"
        >
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-panel-field-hover"
            @click="toggleProvider(provider.id)"
          >
            <div
              class="flex size-8 shrink-0 items-center justify-center rounded bg-panel text-muted"
            >
              <icon-lucide-bot class="size-4" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[11px] font-medium text-surface">{{ provider.name }}</p>
              <p class="truncate text-[10px] text-muted">
                {{ provider.id }} ·
                {{ dialogs.providerModels({ count: provider.models.length }) }}
              </p>
            </div>
            <span
              class="mr-1 flex shrink-0 items-center gap-1 text-[9px] text-muted"
              :data-state="provider.auth.configured ? 'configured' : 'missing'"
            >
              <span
                class="size-1.5 rounded-full bg-muted data-[state=configured]:bg-[var(--color-success)]"
                :data-state="provider.auth.configured ? 'configured' : 'missing'"
              />
              {{ provider.auth.configured ? uiCollab.connected : ai.modelNeedsCredential }}
            </span>
            <icon-lucide-chevron-right
              class="size-3.5 shrink-0 text-muted transition-transform"
              :class="{ 'rotate-90': expandedProviderId === provider.id }"
            />
          </button>

          <div v-if="expandedProviderId === provider.id" class="border-t border-border px-3 py-2">
            <div class="flex items-center gap-1.5">
              <input
                v-model="keyDrafts[provider.id]"
                type="password"
                class="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
                :placeholder="
                  provider.auth.configured
                    ? dialogs.keyPlaceholderConfigured
                    : dialogs.keyPlaceholderMissing
                "
                data-test-id="pi-key-input"
                @keydown.enter="saveKey(provider.id)"
              />
              <button
                type="button"
                class="rounded bg-accent px-2 py-1.5 text-[10px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                data-test-id="pi-key-save"
                :disabled="busyProviderId === provider.id"
                @click="saveKey(provider.id)"
              >
                {{ dialogs.keySave }}
              </button>
              <button
                v-if="provider.auth.configured"
                type="button"
                class="rounded border border-border px-2 py-1.5 text-[10px] text-muted hover:text-surface disabled:opacity-50"
                data-test-id="pi-key-clear"
                :disabled="busyProviderId === provider.id"
                @click="clearKey(provider.id)"
              >
                {{ dialogs.keyClear }}
              </button>
            </div>

            <input
              v-model="modelSearch"
              type="search"
              class="mt-2 w-full rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
              :placeholder="dialogs.modelSearchPlaceholder"
              data-test-id="pi-model-search"
            />

            <div class="scrollbar-thin mt-1.5 max-h-40 overflow-y-auto rounded bg-panel p-1.5">
              <div
                v-for="model in filterModels(provider.models, modelSearch)"
                :key="model.id"
                class="flex items-center justify-between gap-2 px-1 py-0.5 text-[10px]"
                :data-model-id="model.id"
                data-test-id="pi-model-row"
              >
                <span class="truncate text-surface">{{ model.name }}</span>
                <span class="flex shrink-0 items-center gap-1.5 text-muted">
                  <Tip v-if="supportsImageInput(model)" :label="dialogs.modelSupportsImage">
                    <span
                      class="flex items-center gap-0.5 text-muted"
                      data-test-id="pi-model-image-input"
                    >
                      <icon-lucide-image class="size-3" />
                    </span>
                  </Tip>
                  <span v-if="model.contextWindow" data-test-id="pi-model-context">
                    {{ contextLabel(model) }}
                  </span>
                  <span class="truncate">{{ model.id }}</span>
                </span>
              </div>
              <p
                v-if="filterModels(provider.models, modelSearch).length === 0"
                class="px-1 py-1 text-[10px] text-muted"
                data-test-id="pi-model-search-empty"
              >
                {{ dialogs.modelSearchEmpty }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        class="mt-2 flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-[11px] font-medium text-surface hover:bg-panel-field"
        data-test-id="pi-add-provider"
        @click="showAddProvider = !showAddProvider"
      >
        <icon-lucide-plus class="size-3" />
        {{ dialogs.addProvider }}
      </button>

      <div
        v-if="showAddProvider"
        class="mt-2 flex flex-col gap-1.5 rounded border border-border bg-panel-field px-3 py-2"
        data-test-id="pi-provider-form"
      >
        <input
          v-model="customId"
          type="text"
          class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
          :placeholder="dialogs.providerId"
          data-test-id="pi-provider-id-input"
        />
        <input
          v-model="customBaseURL"
          type="text"
          class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
          :placeholder="dialogs.providerBaseUrl"
          data-test-id="pi-provider-baseurl-input"
        />
        <select
          v-model="customAPI"
          class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none"
          data-test-id="pi-provider-api-select"
        >
          <option v-for="api in CUSTOM_API_TYPES" :key="api" :value="api">{{ api }}</option>
        </select>
        <textarea
          v-model="customModelIds"
          rows="3"
          class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
          :placeholder="dialogs.providerModelIds"
          data-test-id="pi-provider-models-input"
        />
        <button
          type="button"
          class="self-start rounded bg-accent px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          data-test-id="pi-provider-save"
          :disabled="busyProviderId === '__custom__'"
          @click="saveCustomProvider"
        >
          {{ dialogs.providerSave }}
        </button>
      </div>
    </section>

    <section class="mt-5 border-t border-border pt-4">
      <div class="mb-3">
        <h3 class="text-xs font-semibold text-surface">{{ dialogs.designModel }}</h3>
        <p class="text-[10px] text-muted">{{ dialogs.designModelDescription }}</p>
      </div>

      <div class="flex flex-col gap-1.5" data-test-id="pi-design-model">
        <label class="text-[10px] text-muted">{{ dialogs.designProvider }}</label>
        <ComboboxRoot
          :model-value="designProviderId || DESIGN_PROVIDER_DEFAULT"
          class="relative"
          @update:model-value="onDesignProviderChange"
        >
          <ComboboxAnchor as-child>
            <ComboboxTrigger
              class="flex w-full items-center justify-between gap-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
              data-test-id="pi-design-provider-trigger"
            >
              <span class="min-w-0 flex-1 truncate text-left">{{ designProviderLabel }}</span>
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
                class="mb-1 w-full rounded border border-border bg-panel-field px-2 py-1 text-[11px] text-surface outline-none focus:border-panel-focus"
                :placeholder="dialogs.providerSearchPlaceholder"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                :spellcheck="false"
                data-test-id="pi-design-provider-search"
              />
              <ComboboxViewport class="scrollbar-thin max-h-48 overflow-y-auto">
                <ComboboxItem
                  :value="DESIGN_PROVIDER_DEFAULT"
                  :text-value="dialogs.designModelDefault"
                  class="relative flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-surface outline-none select-none data-[highlighted]:bg-hover"
                  data-test-id="pi-design-provider-item"
                >
                  <ComboboxItemIndicator class="flex size-3 shrink-0 items-center justify-center">
                    <icon-lucide-check class="size-3 text-accent" />
                  </ComboboxItemIndicator>
                  <span class="min-w-0 flex-1 truncate">{{ dialogs.designModelDefault }}</span>
                </ComboboxItem>
                <ComboboxItem
                  v-for="provider in providers"
                  :key="provider.id"
                  :value="provider.id"
                  :text-value="`${provider.name} ${provider.id}`"
                  class="relative flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-surface outline-none select-none data-[highlighted]:bg-hover"
                  :data-provider-id="provider.id"
                  data-test-id="pi-design-provider-item"
                >
                  <ComboboxItemIndicator class="flex size-3 shrink-0 items-center justify-center">
                    <icon-lucide-check class="size-3 text-accent" />
                  </ComboboxItemIndicator>
                  <span class="min-w-0 flex-1 truncate">{{ provider.name }}</span>
                  <span class="shrink-0 text-[10px] text-muted">{{ provider.id }}</span>
                </ComboboxItem>
                <ComboboxEmpty
                  class="px-2 py-1 text-[10px] text-muted"
                  data-test-id="pi-design-provider-empty"
                >
                  {{ dialogs.designPickerEmpty }}
                </ComboboxEmpty>
              </ComboboxViewport>
            </ComboboxContent>
          </ComboboxPortal>
        </ComboboxRoot>

        <template v-if="designProviderId">
          <label class="mt-1 text-[10px] text-muted">{{ dialogs.designModelField }}</label>
          <ComboboxRoot
            :model-value="designModelId"
            class="relative"
            @update:model-value="onDesignModelChange"
          >
            <ComboboxAnchor as-child>
              <ComboboxTrigger
                class="flex w-full items-center justify-between gap-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
                data-test-id="pi-design-model-trigger"
              >
                <span class="min-w-0 flex-1 truncate text-left">{{ designModelLabel }}</span>
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
                    v-for="model in designModels"
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

          <label class="mt-1 text-[10px] text-muted">{{ dialogs.thinkingLevel }}</label>
          <select
            v-model="designThinking"
            class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none"
            data-test-id="pi-design-thinking-select"
          >
            <option value="off">{{ thinkingLabel('off') }}</option>
            <option value="minimal">{{ thinkingLabel('minimal') }}</option>
            <option value="low">{{ thinkingLabel('low') }}</option>
            <option value="medium">{{ thinkingLabel('medium') }}</option>
            <option value="high">{{ thinkingLabel('high') }}</option>
            <option value="xhigh">{{ thinkingLabel('xhigh') }}</option>
          </select>

          <p
            v-if="designCredentialMissing"
            class="text-[10px] text-amber-400"
            data-test-id="pi-design-credential-missing"
          >
            {{ ai.modelNeedsCredential }}
          </p>
        </template>

        <div class="mt-1 flex items-center gap-2">
          <button
            type="button"
            class="self-start rounded bg-accent px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-accent/90"
            data-test-id="pi-design-save"
            @click="saveDesignModel"
          >
            {{ dialogs.designModelSave }}
          </button>
          <span
            v-if="designDirty"
            class="text-[10px] text-amber-400"
            data-test-id="pi-design-dirty"
          >
            {{ dialogs.designModelDirty }}
          </span>
          <span
            v-else-if="piDesignAssignment"
            class="text-[10px] text-muted"
            data-test-id="pi-design-saved"
          >
            {{ dialogs.designModelSaved }}
          </span>
        </div>
      </div>
    </section>
  </div>
</template>
