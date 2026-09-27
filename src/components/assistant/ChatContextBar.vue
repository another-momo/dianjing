<script setup lang="ts">
/**
 * T65（决策 B1/B2）：画布工作状态面板三合一——当前设计显示 + 设计区列表 +
 * 需求单面板合一，挂在 ChatPanel header（会话下拉旁边）。
 *
 *  - trigger 按钮 = 双段式状态文案（T66 决策①）：「正在设计：<设计名> |
 *    需求单：<N>」，空值 text-muted 弱色——状态可见性与入口合一。
 *    2026-09-27 单槽退役：当前设计段回落缺省态（在途意向 / 空）——当前施工
 *    面的权威显示是落点拦截门 + 状态行（确认卡族批次归族时收口）。
 *  - 需求单计数口径 = 当前页（拍板⑩沿用 T65 D4；scanCurrentPageBriefs 即面板
 *    列表同一口径），sceneVersion watcher 保持新鲜（locus 同范式）。
 *  - popover 内分节不分 tab：①设计区列表（点击条目 = 定位）②需求单列表 +
 *    新建入口。2026-09-27 单槽退役：「设为当前」切换与「正在设计」徽标摘除
 *    ——落点写通道 = 落点拦截门，画布点选不再是改址手段。
 *  - 需求单详情编辑迁出 popover（T66 决策②）：点击条目 → ChatBriefDialog
 *    独立大面板（素材四能力在那）；popover 不再内嵌详情视图。
 *  - 「+ 新建需求单」（T79 U1 推翻 T65 D1）：单按钮 → 桥直调
 *    createBriefOnPage('') 落空 brief → 自动打开 ChatBriefDialog；面板不再
 *    内联内容编辑，无取消/创建双按钮，dirty 守卫随之删除。
 *  - 列表条目展示 T79 S1 B：name + 内容预览（截首 40 字符；空 brief 隐藏）。
 *
 * 面板纪律（沿 T61）：零自有事实源——打开/保存后重读画布；编辑写回走 core
 * brief-edit 原语（画布节点单一事实源）。常驻非模态、仅用户打开。
 */
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, ref, watch } from 'vue'

import type { MarketingDesignRef } from '@open-pencil/core/tools/fork/marketing/setup'

import { piInFlightIntent, piStudioManifest } from '@/app/ai/pi-backend/mode-selection'
import { getActiveEditorStoreOrNull, useActiveEditorStoreRef } from '@/app/editor/active-store'
import { useForkPanels } from '@/app/i18n/fork'
import { toast } from '@/app/shell/ui'
import AppTextButton from '@/components/ui/AppTextButton.vue'
import { usePopoverUI } from '@/components/ui/overlay/popover'

import {
  createBriefOnPage,
  openBriefDialog,
  scanCurrentPageBriefs,
  scanCurrentPageDesigns,
  type BriefListEntry
} from './active-design'

const { disabled = false } = defineProps<{ disabled?: boolean }>()

const panelsText = useForkPanels()
const cls = usePopoverUI({ content: 'isolate z-[51] w-80 p-3' })
const open = ref(false)

// ── ① 设计区列表（当前页；点击 = 定位） ─────────────────────────────────────

/** 在途意向（已确认待物化）——trigger 显示当前所选 mode */
const inFlight = computed(() => piInFlightIntent.value)

function modeLabel(modeId: string): string {
  return piStudioManifest.value?.modes.find((mode) => mode.id === modeId)?.label ?? modeId
}

const designs = ref<MarketingDesignRef[]>([])

function rescanDesigns() {
  const store = getActiveEditorStoreOrNull()
  designs.value = store ? scanCurrentPageDesigns(store) : []
}

/** 点击条目 = 打开定位 */
function locateDesign(design: MarketingDesignRef) {
  const store = getActiveEditorStoreOrNull()
  if (!store) return
  store.select([design.rootId])
  store.zoomToSelection()
  open.value = false
}

// ── ② 需求单列表（当前页）+ 新建；详情编辑在 ChatBriefDialog（T66 决策②） ──

const briefs = ref<BriefListEntry[]>([])

function rescanBriefs() {
  const store = getActiveEditorStoreOrNull()
  briefs.value = store ? scanCurrentPageBriefs(store) : []
}

/**
 * trigger 双段式的需求单计数（T66 决策①）：与面板列表同口径（当前页，
 * scanCurrentPageBriefs）；sceneVersion watcher 保新鲜——图变更即重扫。
 */
const briefCount = ref(0)
const activeStoreRef = useActiveEditorStoreRef()
watch(
  activeStoreRef,
  (store, _prev, onCleanup) => {
    briefCount.value = store ? scanCurrentPageBriefs(store).length : 0
    if (!store) return
    const currentStore = store
    const recount = () => {
      briefCount.value = scanCurrentPageBriefs(currentStore).length
    }
    const stopGraphReplaced = currentStore.onEditorEvent('graph:replaced', recount)
    const stopSceneWatch = watch(() => currentStore.state.sceneVersion, recount)
    onCleanup(() => {
      stopGraphReplaced()
      stopSceneWatch()
    })
  },
  { immediate: true }
)

// 新建需求单（T79 U1 推翻 T65 D1）：单「+ 新建」按钮 → createBriefOnPage('') 立
// 即落画布空 brief（ContentExample 占位）→ 自动打开 ChatBriefDialog 让用户在
// dialog 内编辑内容/素材；不再有 popover 内联 textarea + 取消/创建 双按钮。

const creatingBusy = ref(false)

async function startCreate() {
  if (creatingBusy.value) return
  const store = getActiveEditorStoreOrNull()
  if (!store) return
  creatingBusy.value = true
  try {
    const briefId = await createBriefOnPage(store, '')
    rescanBriefs()
    open.value = false
    openBriefDialog(briefId)
  } catch (error) {
    console.error('Brief create error:', error)
    toast.error(panelsText.value.briefCreateFailed)
  } finally {
    creatingBusy.value = false
  }
}

/** 列表条目点击 → 打开需求单大面板（T66：详情迁出 popover；popover 随之关闭） */
function openBriefDetail(briefId: string) {
  open.value = false
  openBriefDialog(briefId)
}

function handleOpen(value: boolean) {
  open.value = value
  if (value) {
    rescanDesigns()
    rescanBriefs()
  }
}
</script>

<template>
  <PopoverRoot :open="open" @update:open="handleOpen">
    <PopoverTrigger as-child>
      <AppTextButton
        data-test-id="chat-context-trigger"
        :disabled="disabled"
        :aria-label="panelsText.contextTriggerLabel"
        :ui="{
          base: 'flex max-w-80 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-hover'
        }"
      >
        <icon-lucide-pin class="size-3 shrink-0" />
        <!-- T66 决策①双段式：「当前设计区：X | 需求单：N」；空值 text-muted 弱色 -->
        <span class="min-w-0 truncate" data-test-id="chat-context-trigger-design">
          <span class="text-muted">{{ panelsText.contextTriggerDesignLabel }}</span>
          <template v-if="inFlight">{{ modeLabel(inFlight.modeId) }}</template>
          <span v-else class="text-muted">{{ panelsText.contextTriggerDesignEmpty }}</span>
        </span>
        <span class="shrink-0 text-muted">|</span>
        <span class="shrink-0" data-test-id="chat-context-trigger-briefs">
          <span class="text-muted">{{ panelsText.contextTriggerBriefsLabel }}</span>
          <template v-if="briefCount > 0">{{ briefCount }}</template>
          <span v-else class="text-muted">{{ panelsText.contextTriggerBriefsEmpty }}</span>
        </span>
        <icon-lucide-chevron-down class="size-2.5 shrink-0" />
      </AppTextButton>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent side="bottom" align="start" :side-offset="6" :class="cls.content">
        <div data-test-id="chat-context-panel" class="max-h-[70vh] space-y-3 overflow-y-auto">
          <!-- ① 设计区列表（当前页；点击 = 定位） -->
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <icon-lucide-layout-grid class="size-3.5 shrink-0 text-accent" />
              <span class="text-[12px] font-medium text-surface">{{
                panelsText.designsSection
              }}</span>
            </div>

            <div v-if="designs.length === 0" class="text-[11px] text-muted">
              {{ panelsText.designsEmpty }}
            </div>

            <div
              v-for="design in designs"
              :key="design.rootId"
              class="rounded-md border border-border bg-canvas px-2 py-1.5 transition-colors"
              :data-test-id="`chat-design-item`"
              :data-design-node-id="design.rootId"
            >
              <button type="button" class="block w-full text-left" @click="locateDesign(design)">
                <span class="min-w-0 truncate text-[11px] text-surface">{{ design.name }}</span>
              </button>
            </div>
          </div>

          <!-- ② 需求单列表（当前页）+ 新建入口；条目点击 → ChatBriefDialog（T66） -->
          <div class="space-y-1 border-t border-border pt-3">
            <div class="flex items-center gap-2">
              <icon-lucide-book-open class="size-3.5 shrink-0 text-accent" />
              <span class="min-w-0 flex-1 text-[12px] font-medium text-surface">{{
                panelsText.briefsSection
              }}</span>
              <button
                type="button"
                :disabled="creatingBusy"
                data-test-id="chat-brief-new"
                class="flex shrink-0 items-center gap-0.5 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-surface hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                @click="startCreate"
              >
                <icon-lucide-plus class="size-3" />
                {{ panelsText.briefNew }}
              </button>
            </div>

            <div v-if="briefs.length === 0" class="text-[11px] text-muted">
              {{ panelsText.briefListEmpty }}
            </div>
            <button
              v-for="entry in briefs"
              :key="entry.briefId"
              type="button"
              class="block w-full rounded-md border border-border bg-canvas px-2 py-1.5 text-left transition-colors hover:bg-hover"
              :data-test-id="`chat-brief-item`"
              :data-brief-id="entry.briefId"
              @click="openBriefDetail(entry.briefId)"
            >
              <div class="flex items-center gap-1.5">
                <span class="min-w-0 flex-1 truncate text-[11px] text-surface">
                  {{ entry.name }}
                </span>
              </div>
              <!-- T79 S1 B：内容预览（截取首 40 字符；空 brief 不显示） -->
              <div
                v-if="entry.contentPreview"
                class="mt-0.5 truncate text-[11px] text-muted"
                :data-test-id="`chat-brief-item-preview`"
              >
                {{ entry.contentPreview }}
              </div>
            </button>
          </div>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
