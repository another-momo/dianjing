<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { cnCatalogEntry, fontManager, fontRegistryEntry } from '@open-pencil/core/text'
import type { FontFamilyOption } from '@open-pencil/core/text'

import {
  cnFontsEnabled,
  disabledFontFamilies,
  enabledCatalogFamilies,
  listAllFamilies,
  localFontAccessState,
  onlineFontsEnabled,
  requestLocalFontAccess
} from '@/app/editor/fonts'
import { useForkFonts } from '@/app/i18n/fork'
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
  } finally {
    loading.value = false
  }
})

// 来源总开关变更 → 重拉枚举：core 按开关门禁 CDN/在线族（D-a），
// 面板列表口径与 fontsOnlineOffHint / fontsCnOffHint 一致（关停来源的家族从列表消失）
watch([cnFontsEnabled, onlineFontsEnabled], async () => {
  families.value = await listAllFamilies()
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
      <div class="flex items-center justify-between gap-2">
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
          <span class="min-w-0 flex-1 truncate text-xs text-surface">{{ option.family }}</span>
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
