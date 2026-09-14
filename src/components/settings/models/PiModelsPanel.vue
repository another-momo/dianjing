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
 *
 * T97：合并面板形态（讨论稿 §4，owner 拍板）——
 * ①指派语义并入 provider 展开单元（key + 模型 Combobox + thinking 选择 + 设为当前）；
 * ②面板顶部"当前设计模型"摘要条；
 * ③默选机制不落盘（仅表单初值）：openrouter 钉 free，其他 provider 取首项；
 * ④保存 key 同写凭据与指派（无现存指派时——"存 key 即用"对任意 provider 字面成立）；
 * ⑤指派段独立 UI 整体删除（design provider/model Combobox + 哨兵
 *   `__pi_backend_default__` + designDirty + designCredentialMissing）；
 * ⑥深链锚点 anchor：openSettingsDialog(section, { provider }) 深链展开指定行 + 聚焦 key。
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
import { computed, nextTick, onMounted, ref, watch } from 'vue'

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
import {
  OPENROUTER_PROVIDER_ID,
  buildAssignment,
  filterCatalogModels,
  isCurrentAssignment,
  resolveDefaultModelId,
  shouldAutoAssignOnModelChange,
  shouldAutoAssignOnSaveKey
} from '@/app/ai/pi-backend/models-panel-rules'
// T35：27 条 pi 段 i18n 迁回 fork seam——本面板 pi 段用 useForkPi()，通用段（models/connected/modelNeedsCredential）仍走 useI18n()
import { useForkPi } from '@/app/i18n/fork'
import { settingsDialogAnchor, settingsDialogOpen } from '@/app/settings/dialog'
import Tip from '@/components/ui/overlay/Tip.vue'

const dialogs = useForkPi()
const { ai, collaboration: uiCollab } = useI18n()

const expandedProviderId = ref<string | null>(null)
const keyDrafts = ref<Record<string, string>>({})
const busyProviderId = ref<string | null>(null)
const actionError = ref<string | null>(null)

/** T97：合并单元内每个 provider 的表单初值（key 之外——modelId/thinkingLevel）。
 * 展开行时按 resolveDefaultModelId 钉初值；用户保存 key 才落盘成具体指派。 */
const draftModel = ref<Record<string, string>>({})
const draftThinking = ref<Record<string, PiThinkingLevel>>({})

const showAddProvider = ref(false)
const customId = ref('')
const customBaseURL = ref('')
const customAPI = ref('openai-completions')
const customModelIds = ref('')
const CUSTOM_API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** T80：provider 展开区的模型搜索词（每次切换展开的 provider 时清空） */
const modelSearch = ref('')

/** T97：key 输入框 DOM 引用（focus 用，anchor 深链展开后聚焦） */
const providerKeyInputs = ref<Record<string, HTMLInputElement | null>>({})

const providers = computed(() => piCatalog.value?.providers ?? [])

/** T97：当前指派的 provider 目录对象（用于摘要条快速切换的 provider 范围） */
const currentAssignmentProvider = computed(() => {
  const a = piDesignAssignment.value
  if (!a) return null
  return providers.value.find((p) => p.id === a.providerId) ?? null
})

/** T97：摘要条模型切换的候选——仅当前指派 provider 内的模型 */
const summaryModels = computed<PiCatalogModel[]>(
  () => currentAssignmentProvider.value?.models ?? []
)

/** T97：能力展示只取 image 输入（catalog.input 含 'image'）——reasoning / cost 明示不展示 */
function supportsImageInput(model: PiCatalogModel): boolean {
  return model.input.includes('image')
}

function contextLabel(model: PiCatalogModel): string {
  return `${Math.round(model.contextWindow / 1024)}k`
}

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

function thinkingFor(providerId: string): PiThinkingLevel {
  const v = draftThinking.value[providerId]
  if (v) return v
  // 当前指派若是该 provider，用指派的 thinkingLevel 作初值
  if (piDesignAssignment.value?.providerId === providerId) {
    return piDesignAssignment.value.thinkingLevel ?? 'off'
  }
  return 'off'
}

function modelFor(providerId: string): string {
  const v = draftModel.value[providerId]
  if (v) return v
  if (piDesignAssignment.value?.providerId === providerId) {
    return piDesignAssignment.value.modelId
  }
  return ''
}

/** T97：provider 行"当前"check 派生（§4.3 约束 1 单指派语义视觉显式） */
function isCurrentProvider(providerId: string): boolean {
  return isCurrentAssignment(providerId, piDesignAssignment.value)
}

/** T97：展开/收起 + 初始化表单初值（resolveDefaultModelId 钉默选） */
function toggleProvider(providerId: string): void {
  expandedProviderId.value = expandedProviderId.value === providerId ? null : providerId
  modelSearch.value = ''
  if (expandedProviderId.value === providerId) {
    const provider = providers.value.find((p) => p.id === providerId)
    if (!provider) return
    if (!draftModel.value[providerId]) {
      const draft = resolveDefaultModelId(provider)
      if (draft) draftModel.value[providerId] = draft
    }
  }
}

/** T97：摘要条在当前 provider 内快速切换模型——自动写回指派（§4.3 约束 3） */
function onSummaryModelChange(value: AcceptableValue): void {
  if (typeof value !== 'string') return
  const a = piDesignAssignment.value
  if (!a) return
  const providerId = a.providerId
  const modelId = value
  if (!modelId) return
  if (
    shouldAutoAssignOnModelChange({
      existingAssignment: a,
      targetProviderId: providerId,
      targetModelId: modelId
    })
  ) {
    setPiDesignAssignment(buildAssignment({ providerId, modelId, thinkingLevel: a.thinkingLevel }))
  }
  // 同步展开行内的 draft（避免脱节）
  draftModel.value[providerId] = modelId
}

/** T97：展开单元内模型 Combobox 变更（草稿态，不直接写指派；除非是当前指派 provider 内换模型） */
function onProviderModelChange(providerId: string, value: AcceptableValue): void {
  if (typeof value !== 'string') return
  const modelId = value
  if (!modelId) return
  draftModel.value[providerId] = modelId
  // §4.3 约束 3：当前指派 provider 内换模型 → 自动写回
  const a = piDesignAssignment.value
  if (
    a &&
    shouldAutoAssignOnModelChange({
      existingAssignment: a,
      targetProviderId: providerId,
      targetModelId: modelId
    })
  ) {
    setPiDesignAssignment(buildAssignment({ providerId, modelId, thinkingLevel: a.thinkingLevel }))
  }
}

function onProviderThinkingChange(providerId: string, value: AcceptableValue): void {
  if (typeof value !== 'string') return
  const level = value as PiThinkingLevel
  draftThinking.value[providerId] = level
  const a = piDesignAssignment.value
  if (a && a.providerId === providerId) {
    // thinking 变更也走自动写回——同 provider 内显式动作
    setPiDesignAssignment(buildAssignment({ providerId, modelId: a.modelId, thinkingLevel: level }))
  }
}

async function saveKey(providerId: string): Promise<void> {
  const key = (keyDrafts.value[providerId] ?? '').trim()
  if (!key) return
  busyProviderId.value = providerId
  actionError.value = null
  try {
    await setPiCredential(providerId, key)
    keyDrafts.value[providerId] = ''
    // §4.2 段 d：无现存指派 → 保存 key 同写指派（用该行 draftModel 的当前值，
    // 即 resolveDefaultModelId 钉的初值或用户改过的值）
    if (
      shouldAutoAssignOnSaveKey({
        existingAssignment: piDesignAssignment.value,
        targetProviderId: providerId
      })
    ) {
      const modelId =
        draftModel.value[providerId] ??
        resolveDefaultModelId(providers.value.find((p) => p.id === providerId) ?? null)
      if (modelId) {
        setPiDesignAssignment(
          buildAssignment({
            providerId,
            modelId,
            thinkingLevel: draftThinking.value[providerId] ?? 'off'
          })
        )
      }
    }
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
    // T97：清除当前指派 provider 的 key 不清指派——指派语义独立；该 provider 行
    // 因 auth.configured=false 显示"未配置"，与"删除指派"是两条路径
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busyProviderId.value = null
  }
}

/** T97：摘要条"切换到该 provider"——展开单元+聚焦 key 输入 */
function focusProvider(providerId: string): void {
  expandedProviderId.value = providerId
  const provider = providers.value.find((p) => p.id === providerId)
  if (provider && !draftModel.value[providerId]) {
    const draft = resolveDefaultModelId(provider)
    if (draft) draftModel.value[providerId] = draft
  }
  void nextTick(() => {
    const input = providerKeyInputs.value[providerId]
    input?.focus()
  })
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

/** T97：watch 深链锚点——引导门传 { provider } 时展开该行 + 聚焦 key 输入 */
watch(
  () => settingsDialogAnchor.value?.provider ?? null,
  (providerId) => {
    if (!providerId) return
    focusProvider(providerId)
  },
  { immediate: false }
)

/** T97：关闭时清空锚点（防止下次打开残留旧 provider） */
watch(settingsDialogOpen, (open) => {
  if (!open) settingsDialogAnchor.value = null
})

/** T97 §4.2 段 c：未配置首开——catalog 就绪后 openrouter 行默认展开 + key 聚焦 +
 *  Combobox 显示 free 待确认初值（focusProvider 内经 resolveDefaultModelId 钉）。
 *  已有指派 / anchor 深链 / 用户已自行展开时让位，不争。 */
watch(
  () => providers.value.length,
  (len) => {
    if (len === 0) return
    if (piDesignAssignment.value) return
    if (settingsDialogAnchor.value?.provider) return
    if (expandedProviderId.value) return
    focusProvider(OPENROUTER_PROVIDER_ID)
  },
  { immediate: true }
)

onMounted(() => void refreshPiCatalog())
</script>

<template>
  <!-- T91k：根节点不再自滚——滚动职责上交 SettingsDialog 标签页容器，
       让 AgentSettingsPanel 跟在模型清单下方同流滚动（owner 拍板） -->
  <div class="flex flex-col">
    <!-- T97：摘要条——"当前设计模型"显示 + 当前 provider 内快速换模型。
         等价于旧 design 指派段的高频操作（讨论稿 §4.2 段 b）。 -->
    <section
      v-if="piDesignAssignment && currentAssignmentProvider"
      class="mb-3 rounded border border-border bg-panel-field p-3"
      data-test-id="pi-current-assignment"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <p class="truncate text-[10px] text-muted">{{ dialogs.currentAssignmentLabel }}</p>
          <p
            class="truncate text-[11px] font-medium text-surface"
            data-test-id="pi-current-assignment-provider"
          >
            {{ currentAssignmentProvider.name }} · {{ piDesignAssignment.modelId }}
          </p>
        </div>
        <ComboboxRoot
          :model-value="piDesignAssignment.modelId"
          class="relative w-48 shrink-0"
          @update:model-value="onSummaryModelChange"
        >
          <ComboboxAnchor as-child>
            <ComboboxTrigger
              class="flex w-full items-center justify-between gap-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
              data-test-id="pi-summary-model-trigger"
            >
              <span class="min-w-0 flex-1 truncate text-left">{{
                piDesignAssignment.modelId
              }}</span>
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
                data-test-id="pi-summary-model-search"
              />
              <ComboboxViewport class="scrollbar-thin max-h-48 overflow-y-auto">
                <ComboboxItem
                  v-for="model in filterCatalogModels(summaryModels, '')"
                  :key="model.id"
                  :value="model.id"
                  :text-value="`${model.name} ${model.id}`"
                  class="relative flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-surface outline-none select-none data-[highlighted]:bg-hover"
                  :data-model-id="model.id"
                  data-test-id="pi-summary-model-item"
                >
                  <ComboboxItemIndicator class="flex size-3 shrink-0 items-center justify-center">
                    <icon-lucide-check class="size-3 text-accent" />
                  </ComboboxItemIndicator>
                  <span class="min-w-0 flex-1 truncate">{{ model.name }}</span>
                  <span class="shrink-0 text-[10px] text-muted">{{ model.id }}</span>
                </ComboboxItem>
                <ComboboxEmpty
                  class="px-2 py-1 text-[10px] text-muted"
                  data-test-id="pi-summary-model-empty"
                >
                  {{ dialogs.modelSearchEmpty }}
                </ComboboxEmpty>
              </ComboboxViewport>
            </ComboboxContent>
          </ComboboxPortal>
        </ComboboxRoot>
      </div>
    </section>

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
              v-if="isCurrentProvider(provider.id)"
              class="flex shrink-0 items-center gap-1 text-[10px] font-medium text-accent"
              data-test-id="pi-current-marker"
            >
              <icon-lucide-check class="size-3" />
              {{ dialogs.currentAssignmentCurrent }}
            </span>
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
                :ref="
                  (el) => {
                    providerKeyInputs[provider.id] = el as HTMLInputElement | null
                  }
                "
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

            <!-- T97：合并单元模型 Combobox + thinking 选择（讨论稿 §4.2 段 a）。
                 展开时按 resolveDefaultModelId 钉默选（不落盘）。 -->
            <template v-if="modelFor(provider.id)">
              <label class="mt-2 text-[10px] text-muted">{{ dialogs.designModelField }}</label>
              <ComboboxRoot
                :model-value="modelFor(provider.id)"
                class="relative mt-1"
                @update:model-value="(v) => onProviderModelChange(provider.id, v)"
              >
                <ComboboxAnchor as-child>
                  <ComboboxTrigger
                    class="flex w-full items-center justify-between gap-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
                    data-test-id="pi-provider-model-trigger"
                  >
                    <span class="min-w-0 flex-1 truncate text-left">{{
                      modelFor(provider.id)
                    }}</span>
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
                      data-test-id="pi-provider-model-search"
                    />
                    <ComboboxViewport class="scrollbar-thin max-h-48 overflow-y-auto">
                      <ComboboxItem
                        v-for="model in filterCatalogModels(provider.models, '')"
                        :key="model.id"
                        :value="model.id"
                        :text-value="`${model.name} ${model.id}`"
                        class="relative flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-surface outline-none select-none data-[highlighted]:bg-hover"
                        :data-model-id="model.id"
                        data-test-id="pi-provider-model-item"
                      >
                        <ComboboxItemIndicator
                          class="flex size-3 shrink-0 items-center justify-center"
                        >
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
                        data-test-id="pi-provider-model-empty"
                      >
                        {{ dialogs.modelSearchEmpty }}
                      </ComboboxEmpty>
                    </ComboboxViewport>
                  </ComboboxContent>
                </ComboboxPortal>
              </ComboboxRoot>

              <label class="mt-2 text-[10px] text-muted">{{ dialogs.thinkingLevel }}</label>
              <select
                :value="thinkingFor(provider.id)"
                class="mt-1 w-full rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none"
                data-test-id="pi-provider-thinking-select"
                @change="
                  (e) =>
                    onProviderThinkingChange(provider.id, (e.target as HTMLSelectElement).value)
                "
              >
                <option value="off">{{ thinkingLabel('off') }}</option>
                <option value="minimal">{{ thinkingLabel('minimal') }}</option>
                <option value="low">{{ thinkingLabel('low') }}</option>
                <option value="medium">{{ thinkingLabel('medium') }}</option>
                <option value="high">{{ thinkingLabel('high') }}</option>
                <option value="xhigh">{{ thinkingLabel('xhigh') }}</option>
              </select>
            </template>

            <!-- T97：模型列表搜索 + 视觉行（T80 保留；点行设 Combobox 值） -->
            <input
              v-model="modelSearch"
              type="search"
              class="mt-2 w-full rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
              :placeholder="dialogs.modelSearchPlaceholder"
              data-test-id="pi-model-search"
            />

            <div class="scrollbar-thin mt-1.5 max-h-40 overflow-y-auto rounded bg-panel p-1.5">
              <div
                v-for="model in filterCatalogModels(provider.models, modelSearch)"
                :key="model.id"
                class="flex items-center justify-between gap-2 px-1 py-0.5 text-[10px]"
                :data-model-id="model.id"
                data-test-id="pi-model-row"
              >
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate text-left text-surface hover:text-accent"
                  data-test-id="pi-model-row-button"
                  @click="onProviderModelChange(provider.id, model.id)"
                >
                  {{ model.name }}
                </button>
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
                v-if="filterCatalogModels(provider.models, modelSearch).length === 0"
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
  </div>
</template>
