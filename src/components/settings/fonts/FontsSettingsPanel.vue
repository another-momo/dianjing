<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import {
  WEB_FONT_PROVIDER_IDS,
  WEB_FONT_PROVIDER_LABELS,
  cnCatalogEntry,
  fontManager,
  fontRegistryEntry
} from '@open-pencil/core/text'
import type { FontFamilyOption, WebFontProviderId } from '@open-pencil/core/text'

import {
  clearDownloadedFontCache,
  cnFontsEnabled,
  disabledFontFamilies,
  downloadedFontCacheSummary,
  enabledCatalogFamilies,
  fontProviderSettings,
  listAllFamilies,
  localFontAccessState,
  localFontsEnabled,
  onlineFontsEnabled,
  predownloadFallbackFonts,
  requestLocalFontAccess
} from '@/app/editor/fonts'
import { useForkFonts } from '@/app/i18n/fork'
import { isElectron } from '@/app/shell/electron'
import AppButton from '@/components/ui/button/AppButton.vue'
import Tip from '@/components/ui/overlay/Tip.vue'
import AppSwitch from '@/components/ui/toggle/AppSwitch.vue'

/**
 * T41 S5：字体白名单可视化管理面板（SettingsDialog fonts 分区）。
 * 覆盖 bundled/cdn/provider/local 全来源；bundled 兜底族锁定恒开（D-d，core 同样拒关）。
 * 关停语义 = 视为未安装：picker 消失 + 文档走回退链（core 加载门禁）。
 *
 * T42 重构（owner /goal）：
 * - 来源开关区：在线字体库总开关 + 中文网字计划 CDN 独立开关（D-a，两者解耦）；
 * - catalog 组（中文网字计划全量目录 105 族）默认停用 opt-in（D-c）；
 * - 交互优化：状态筛选（全部/已启用/已停用）+ 分组折叠 + 长列表截断/显示更多
 *   + 组级批量启停（锁定族跳过）+ 搜索跨组过滤自动展开。
 *
 * 统一批（owner /goal）：
 * - A. 面板统一管理面——popover 三家独有能力（提供商单独开关、回退包预下载、
 *   缓存管理）迁入；提供商开关按 Electron 能力禁 google 勾选（修显示口径）；
 * - B. 本地源应用级开关（默认开）——开关管「要不要」、权限管「能不能」；
 * - C. google provider 门禁改走 Electron 形态判定（不可达网络靠 6s 兜底）。
 */
const msgs = useForkFonts()

const families = ref<FontFamilyOption[]>([])
const loading = ref(true)
const search = ref('')
const statusFilter = ref<'all' | 'enabled' | 'disabled'>('all')
const requestingLocal = ref(false)
const localAccess = ref(localFontAccessState())

type SourceGroup = 'bundled' | 'cdn' | 'catalog' | 'online' | 'local'
const GROUP_ORDER: SourceGroup[] = ['bundled', 'cdn', 'catalog', 'online', 'local']
/** 长列表组默认折叠；bundled/cdn 族少默认展开 */
const collapsed = reactive<Record<SourceGroup, boolean>>({
  bundled: false,
  cdn: false,
  catalog: true,
  online: true,
  local: false
})
/** 每组渲染上限（截断长列表，搜索时不受限） */
const RENDER_PAGE = 100
const renderLimits = reactive<Record<SourceGroup, number>>({
  bundled: RENDER_PAGE,
  cdn: RENDER_PAGE,
  catalog: RENDER_PAGE,
  online: RENDER_PAGE,
  local: RENDER_PAGE
})

/** 统一批 C：Google Fonts 仅 Electron 形态可用；面板据此禁用 google 勾选 */
const googleAvailable = isElectron()

/** 统一批 A：提供商单独开关（按 Electron 能力屏蔽 google） */
function isProviderRuntimeAvailable(provider: WebFontProviderId): boolean {
  return provider !== 'google' || googleAvailable
}

const providerEnabled = computed<Record<WebFontProviderId, boolean>>(() => {
  const next = { ...fontProviderSettings.value }
  for (const provider of WEB_FONT_PROVIDER_IDS) {
    if (!isProviderRuntimeAvailable(provider)) next[provider] = false
  }
  return next
})

function setProviderEnabled(provider: WebFontProviderId, enabled: boolean) {
  if (!isProviderRuntimeAvailable(provider)) return
  fontProviderSettings.value = { ...fontProviderSettings.value, [provider]: enabled }
}

/** 统一批 A：缓存管理（自 popover 迁入） */
const cacheCount = ref(0)
const cacheByteLength = ref(0)
const cacheBusy = ref(false)
const cacheStatus = ref('')

async function refreshCacheSummary() {
  const summary = await downloadedFontCacheSummary()
  cacheCount.value = summary.count
  cacheByteLength.value = summary.byteLength
}

const cacheSizeLabel = computed(() => {
  if (cacheByteLength.value === 0) return '0 MB'
  return `${(cacheByteLength.value / 1024 / 1024).toFixed(1)} MB`
})

async function clearCache() {
  cacheBusy.value = true
  cacheStatus.value = ''
  try {
    await clearDownloadedFontCache()
    await refreshCacheSummary()
    cacheStatus.value = msgs.value.fontsCacheCleared
  } catch {
    cacheStatus.value = msgs.value.fontsCacheClearFailed
  } finally {
    cacheBusy.value = false
  }
}

/** 统一批 A：回退包预下载（自 popover 迁入） */
const fallbackBusy = ref(false)
const fallbackStatus = ref('')

async function downloadFallbacks() {
  fallbackBusy.value = true
  fallbackStatus.value = ''
  try {
    await predownloadFallbackFonts()
    fallbackStatus.value = msgs.value.fontsFallbackDownloaded
  } catch {
    fallbackStatus.value = msgs.value.fontsFallbackDownloadFailed
  } finally {
    fallbackBusy.value = false
  }
}

function groupOf(option: FontFamilyOption): SourceGroup {
  if (option.source === 'bundled') return 'bundled'
  if (option.source === 'cdn') return option.catalog ? 'catalog' : 'cdn'
  if (option.source === 'local') return 'local'
  return 'online'
}

const groupLabels = computed<Record<SourceGroup, string>>(() => ({
  bundled: msgs.value.fontsSourceBundled,
  cdn: msgs.value.fontsSourceCdn,
  catalog: msgs.value.fontsSourceCatalog,
  online: msgs.value.fontsSourceOnline,
  local: msgs.value.fontsSourceLocal
}))

// 响应式依赖锚点：白名单两集合变更时重算（核心语义判定走 core，单一真源）
const enabledStateVersion = computed(() => [
  disabledFontFamilies.value,
  enabledCatalogFamilies.value
])

function isLocked(family: string): boolean {
  return fontManager.isFontFamilyLocked(family)
}

function isEnabled(family: string): boolean {
  void enabledStateVersion.value
  return fontManager.isFontFamilyEnabled(family)
}

function isVariable(family: string): boolean {
  return fontRegistryEntry(family)?.variable === true || cnCatalogEntry(family)?.variable === true
}

function licenseHint(option: FontFamilyOption): string | undefined {
  if (!option.catalog) return undefined
  const entry = cnCatalogEntry(option.family)
  if (!entry) return undefined
  return msgs.value.fontsUnauditedLicense({ license: entry.license })
}

function displayNameOf(family: string): string | undefined {
  return cnCatalogEntry(family)?.displayName
}

/** 开关经 core 写入（catalog/普通分流在 allowlist 内），再回写持久化 ref */
function syncPersisted(): void {
  disabledFontFamilies.value = fontManager.disabledFontFamilies()
  enabledCatalogFamilies.value = fontManager.enabledCatalogFamilies()
}

function toggle(family: string, enabled: boolean): void {
  if (isLocked(family)) return
  fontManager.setFontFamilyEnabled(family, enabled)
  syncPersisted()
}

function setGroupEnabled(options: FontFamilyOption[], enabled: boolean): void {
  for (const option of options) {
    if (isLocked(option.family)) continue
    fontManager.setFontFamilyEnabled(option.family, enabled)
  }
  syncPersisted()
}

const stateFiltered = computed(() => {
  if (statusFilter.value === 'all') return families.value
  const wantEnabled = statusFilter.value === 'enabled'
  return families.value.filter((option) => isEnabled(option.family) === wantEnabled)
})

const searched = computed(() => {
  const term = search.value.trim().toLowerCase()
  if (!term) return stateFiltered.value
  return stateFiltered.value.filter((option) => option.family.toLowerCase().includes(term))
})

const searching = computed(() => search.value.trim().length > 0)

interface GroupView {
  group: SourceGroup
  options: FontFamilyOption[]
  visible: FontFamilyOption[]
  hiddenCount: number
  enabledCount: number
  isCollapsed: boolean
}

const grouped = computed<GroupView[]>(() => {
  const groups = new Map<SourceGroup, FontFamilyOption[]>()
  for (const option of searched.value) {
    const group = groupOf(option)
    groups.set(group, [...(groups.get(group) ?? []), option])
  }
  return GROUP_ORDER.flatMap((group) => {
    const options = groups.get(group)
    if (!options) return []
    // 搜索时展开全部命中；否则尊重折叠态并按 renderLimits 截断
    const isCollapsed = !searching.value && collapsed[group]
    const limit = searching.value ? options.length : renderLimits[group]
    const visible = isCollapsed ? [] : options.slice(0, limit)
    return [
      {
        group,
        options,
        visible,
        hiddenCount: Math.max(0, options.length - visible.length),
        enabledCount: options.filter((option) => isEnabled(option.family)).length,
        isCollapsed
      }
    ]
  })
})

const enabledCount = computed(
  () => families.value.filter((option) => isEnabled(option.family)).length
)

function toggleCollapse(group: SourceGroup): void {
  collapsed[group] = !collapsed[group]
}

function showMore(group: SourceGroup): void {
  renderLimits[group] += 500
}

async function allowLocalFonts(): Promise<void> {
  requestingLocal.value = true
  try {
    // 面板必须用不过滤的枚举：listFamilies（requestLocalFontAccess 的返回）
    // 会按白名单过滤，关停行会连同本地族一起从面板消失，无法重开。
    await requestLocalFontAccess()
    families.value = await listAllFamilies()
    localAccess.value = localFontAccessState()
  } finally {
    requestingLocal.value = false
  }
}

onMounted(async () => {
  try {
    families.value = await listAllFamilies()
    await refreshCacheSummary()
  } finally {
    loading.value = false
  }
})

// 来源总开关变更 → 重拉枚举：core 按开关门禁 CDN/在线族（D-a），
// 面板列表口径与 fontsOnlineOffHint / fontsCnOffHint 一致（关停来源的家族从列表消失）
watch([cnFontsEnabled, onlineFontsEnabled, localFontsEnabled], async () => {
  families.value = await listAllFamilies()
  localAccess.value = localFontAccessState()
})
</script>

<template>
  <section class="flex flex-col gap-3" data-test-id="settings-fonts-panel">
    <div>
      <h3 class="text-xs font-semibold text-surface">{{ msgs.fontsPanelTitle }}</h3>
      <p class="mt-0.5 text-[10px] leading-relaxed text-muted">
        {{ msgs.fontsPanelDescription }}
      </p>
    </div>

    <!-- T42：来源开关区（CDN 独立开关可见落点，与在线库总开关解耦） -->
    <div class="flex flex-col gap-2 rounded border border-border p-2" data-test-id="fonts-sources">
      <!-- 统一批 B：本地源应用级开关（默认开）；关停时本地族从枚举与回退链消失 -->
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <span class="text-[10px] font-medium text-surface">{{ msgs.fontsLocalMaster }}</span>
          <p class="text-[9px] leading-relaxed text-muted">{{ msgs.fontsLocalMasterHint }}</p>
          <p
            v-if="!localFontsEnabled"
            class="text-[9px] leading-relaxed text-muted"
            data-test-id="fonts-local-off-hint"
          >
            {{ msgs.fontsLocalOffHint }}
          </p>
        </div>
        <AppSwitch
          v-model="localFontsEnabled"
          :label="msgs.fontsLocalMaster"
          data-test-id="fonts-local-master"
        />
      </div>
      <div class="flex items-center justify-between gap-2 border-t border-border pt-2">
        <div class="min-w-0">
          <span class="text-[10px] font-medium text-surface">{{ msgs.fontsOnlineMaster }}</span>
          <p class="text-[9px] leading-relaxed text-muted">{{ msgs.fontsOnlineMasterHint }}</p>
          <p
            v-if="!onlineFontsEnabled"
            class="text-[9px] leading-relaxed text-muted"
            data-test-id="fonts-online-off-hint"
          >
            {{ msgs.fontsOnlineOffHint }}
          </p>
        </div>
        <AppSwitch
          v-model="onlineFontsEnabled"
          :label="msgs.fontsOnlineMaster"
          data-test-id="fonts-online-master"
        />
      </div>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <span class="text-[10px] font-medium text-surface">{{ msgs.fontsCnMaster }}</span>
          <p class="text-[9px] leading-relaxed text-muted">{{ msgs.fontsCnMasterHint }}</p>
          <p
            v-if="!cnFontsEnabled"
            class="text-[9px] leading-relaxed text-muted"
            data-test-id="fonts-cn-off-hint"
          >
            {{ msgs.fontsCnOffHint }}
          </p>
        </div>
        <AppSwitch
          v-model="cnFontsEnabled"
          :label="msgs.fontsCnMaster"
          data-test-id="fonts-cn-master"
        />
      </div>
      <div
        v-if="localAccess !== 'granted' && localAccess !== 'unsupported'"
        class="flex items-center justify-between gap-2 border-t border-border pt-2"
        data-test-id="fonts-local-access"
      >
        <p class="text-[10px] text-muted">{{ msgs.fontsLocalAccessPrompt }}</p>
        <AppButton
          type="button"
          color="neutral"
          variant="soft"
          size="xs"
          :disabled="requestingLocal"
          data-test-id="fonts-local-allow"
          @click="allowLocalFonts"
        >
          {{ msgs.fontsLocalAllow }}
        </AppButton>
      </div>
    </div>

    <!-- 统一批 A：提供商单独开关（自 popover 迁入） -->
    <div
      class="flex flex-col gap-2 rounded border border-border p-2"
      data-test-id="fonts-providers"
    >
      <div class="min-w-0">
        <span class="text-[10px] font-medium text-surface">{{ msgs.fontsProvidersTitle }}</span>
        <p class="text-[9px] leading-relaxed text-muted">{{ msgs.fontsProvidersHint }}</p>
        <p class="text-[9px] leading-relaxed text-muted">{{ msgs.fontsProvidersOptInHint }}</p>
      </div>
      <label
        v-for="provider in WEB_FONT_PROVIDER_IDS"
        :key="provider"
        class="flex items-center justify-between gap-2 text-[10px]"
      >
        <span class="text-muted">{{ WEB_FONT_PROVIDER_LABELS[provider] }}</span>
        <input
          type="checkbox"
          class="size-3 accent-accent disabled:opacity-50"
          :checked="providerEnabled[provider]"
          :disabled="!onlineFontsEnabled || !isProviderRuntimeAvailable(provider)"
          :data-test-id="`fonts-provider-${provider}`"
          @change="setProviderEnabled(provider, ($event.target as HTMLInputElement).checked)"
        />
      </label>
      <p
        v-if="!googleAvailable"
        class="text-[9px] leading-relaxed text-muted"
        data-test-id="fonts-google-unavailable-hint"
      >
        {{ msgs.fontsProviderGoogleUnavailable }}
      </p>
    </div>

    <!-- 统一批 A：回退包预下载（自 popover 迁入） -->
    <div
      class="flex items-center justify-between gap-2 rounded border border-border p-2"
      data-test-id="fonts-fallback"
    >
      <div class="min-w-0">
        <span class="text-[10px] font-medium text-surface">{{ msgs.fontsFallbackTitle }}</span>
        <p class="text-[9px] leading-relaxed text-muted">{{ msgs.fontsFallbackHint }}</p>
        <p
          v-if="fallbackStatus"
          class="text-[9px] leading-relaxed text-muted"
          data-test-id="fonts-fallback-status"
        >
          {{ fallbackStatus }}
        </p>
      </div>
      <AppButton
        type="button"
        color="primary"
        variant="solid"
        size="xs"
        :disabled="fallbackBusy"
        data-test-id="fonts-fallback-download"
        @click="downloadFallbacks"
      >
        {{ fallbackBusy ? msgs.fontsFallbackDownloading : msgs.fontsFallbackDownload }}
      </AppButton>
    </div>

    <!-- 统一批 A：缓存管理（自 popover 迁入） -->
    <div
      class="flex items-center justify-between gap-2 rounded border border-border p-2"
      data-test-id="fonts-cache"
    >
      <div class="min-w-0">
        <span class="text-[10px] font-medium text-surface">{{ msgs.fontsCacheTitle }}</span>
        <p class="text-[9px] leading-relaxed text-muted">
          {{ msgs.fontsCacheSummary({ count: cacheCount, size: cacheSizeLabel }) }}
        </p>
        <p
          v-if="cacheStatus"
          class="text-[9px] leading-relaxed text-muted"
          data-test-id="fonts-cache-status"
        >
          {{ cacheStatus }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <AppButton
          type="button"
          color="neutral"
          variant="soft"
          size="xs"
          :disabled="cacheBusy"
          data-test-id="fonts-cache-clear"
          @click="clearCache"
        >
          {{ msgs.fontsCacheClear }}
        </AppButton>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <input
        v-model="search"
        type="text"
        data-test-id="fonts-allowlist-search"
        :placeholder="msgs.fontsSearchPlaceholder"
        class="w-full rounded border border-border bg-input px-2 py-1 text-xs text-surface outline-none placeholder:text-muted"
      />
      <span class="shrink-0 text-[10px] text-muted" data-test-id="fonts-allowlist-summary">
        {{ msgs.fontsEnabledSummary({ enabled: enabledCount, total: families.length }) }}
      </span>
    </div>

    <!-- 状态筛选 -->
    <div class="flex gap-1" data-test-id="fonts-status-filter">
      <button
        v-for="filter in ['all', 'enabled', 'disabled'] as const"
        :key="filter"
        type="button"
        class="rounded px-2 py-0.5 text-[10px]"
        :class="statusFilter === filter ? 'bg-input text-surface' : 'text-muted hover:bg-hover'"
        :data-test-id="`fonts-filter-${filter}`"
        @click="statusFilter = filter"
      >
        {{
          filter === 'all'
            ? msgs.fontsFilterAll
            : filter === 'enabled'
              ? msgs.fontsFilterEnabled
              : msgs.fontsFilterDisabled
        }}
      </button>
    </div>

    <p v-if="loading" class="text-[10px] text-muted">{{ msgs.fontsLoading }}</p>
    <p v-else-if="grouped.length === 0" class="text-[10px] text-muted">{{ msgs.fontsEmpty }}</p>

    <template v-else>
      <div
        v-for="view in grouped"
        :key="view.group"
        class="flex flex-col gap-1"
        :data-test-id="`fonts-group-${view.group}`"
      >
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1 text-left"
            :data-test-id="`fonts-group-toggle-${view.group}`"
            @click="toggleCollapse(view.group)"
          >
            <span class="text-[9px] text-muted">{{ view.isCollapsed ? '▸' : '▾' }}</span>
            <span class="truncate text-[10px] font-medium uppercase tracking-wide text-muted">
              {{ groupLabels[view.group] }}
            </span>
            <span class="shrink-0 text-[9px] text-muted">
              {{ view.enabledCount }}/{{ view.options.length }}
            </span>
          </button>
          <AppButton
            v-if="view.group !== 'bundled'"
            type="button"
            color="neutral"
            variant="soft"
            size="xs"
            :data-test-id="`fonts-group-enable-${view.group}`"
            @click="setGroupEnabled(view.options, true)"
          >
            {{ msgs.fontsEnableAll }}
          </AppButton>
          <AppButton
            v-if="view.group !== 'bundled'"
            type="button"
            color="neutral"
            variant="soft"
            size="xs"
            :data-test-id="`fonts-group-disable-${view.group}`"
            @click="setGroupEnabled(view.options, false)"
          >
            {{ msgs.fontsDisableAll }}
          </AppButton>
        </div>
        <p
          v-if="view.group === 'catalog' && !view.isCollapsed"
          class="text-[9px] leading-relaxed text-muted"
        >
          {{ msgs.fontsCatalogHint }}
        </p>
        <div
          v-for="option in view.visible"
          :key="option.family"
          class="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-hover"
          data-test-id="font-allowlist-row"
          :data-family="option.family"
        >
          <span class="min-w-0 flex-1 truncate text-xs text-surface">{{
            displayNameOf(option.family) ?? option.family
          }}</span>
          <span
            v-if="displayNameOf(option.family) && option.catalog"
            class="shrink-0 truncate text-[9px] text-muted"
          >
            {{ option.family }}
          </span>
          <span
            v-if="isVariable(option.family)"
            class="shrink-0 rounded bg-input px-1 py-0.5 text-[9px] uppercase text-muted"
          >
            {{ msgs.fontsVariableBadge }}
          </span>
          <Tip v-if="licenseHint(option)" :label="licenseHint(option)">
            <span class="shrink-0 text-[9px] text-muted">ⓘ</span>
          </Tip>
          <Tip v-if="isLocked(option.family)" :label="msgs.fontsLockedHint">
            <span class="shrink-0 text-[9px] text-muted">🔒</span>
          </Tip>
          <AppSwitch
            :model-value="isEnabled(option.family)"
            :label="option.family"
            :disabled="isLocked(option.family)"
            :data-test-id="`font-allowlist-toggle`"
            :data-family="option.family"
            @update:model-value="toggle(option.family, $event)"
          />
        </div>
        <AppButton
          v-if="!view.isCollapsed && view.hiddenCount > 0"
          type="button"
          color="neutral"
          variant="soft"
          size="xs"
          class="self-start"
          :data-test-id="`fonts-show-more-${view.group}`"
          @click="showMore(view.group)"
        >
          {{ msgs.fontsShowMore({ count: view.hiddenCount }) }}
        </AppButton>
      </div>
    </template>

    <p class="text-[10px] leading-relaxed text-muted">{{ msgs.fontsLockedHint }}</p>
  </section>
</template>
