<script setup lang="ts">
/**
 * T65（决策 B1/B2）：画布工作状态面板——需求单入口，挂在 ChatPanel header
 * （会话下拉旁边）。
 *
 *  - trigger = 单段式「需求单：N」（T66 决策① 原设计段随单槽退役恒空；
 *    2026-09-28 chat-ui-consolidation 收敛——设计区语义已死，trigger
 *    只承载需求单段，图标换书本与 popover 需求单节一致）。
 *  - 需求单计数口径 = 当前页（拍板⑩沿用 T65 D4；scanCurrentPageBriefs 即面板
 *    列表同一口径），sceneVersion watcher 保持新鲜（locus 同范式）。
 *  - popover 内单节：需求单列表 + 新建入口。详情编辑迁出 popover（T66 决策②）：
 *    点击条目 → ChatBriefDialog 独立大面板（素材四能力在那）；popover 不再
 *    内嵌详情视图。
 *  - 「+ 新建需求单」（T79 U1 推翻 T65 D1）：单按钮 → 桥直调
 *    createBriefOnPage('') 落空 brief → 自动打开 ChatBriefDialog。
 *  - 新建歧义对齐（2026-09-28 chat-ui-consolidation）：当页已多份 brief 时
 *    点击新建 = 提示从列表选择而非新建第 N+1 份（避免歧义）；当页仅一份
 *    时点击 = 直开该 brief 的 dialog（用户意图明显是编辑现有而非新建）。
 *  - 列表条目展示 T79 S1 B：name + 内容预览（截首 40 字符；空 brief 隐藏）。
 *
 * 面板纪律（沿 T61）：零自有事实源——打开/保存后重读画布；编辑写回走 core
 * brief-edit 原语（画布节点单一事实源）。常驻非模态、仅用户打开。
 */
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { ref, watch } from 'vue'

import { getActiveEditorStoreOrNull, useActiveEditorStoreRef } from '@/app/editor/active-store'
import { useForkPanels } from '@/app/i18n/fork'
import { toast } from '@/app/shell/ui'
import AppTextButton from '@/components/ui/AppTextButton.vue'
import { usePopoverUI } from '@/components/ui/overlay/popover'

import {
  createBriefOnPage,
  openBriefDialog,
  scanCurrentPageBriefs,
  type BriefListEntry
} from './active-design'

const { disabled = false } = defineProps<{ disabled?: boolean }>()

const panelsText = useForkPanels()
const cls = usePopoverUI({ content: 'isolate z-[51] w-80 p-3' })
const open = ref(false)

// ── 需求单列表（当前页）+ 新建；详情编辑在 ChatBriefDialog（T66 决策②） ──

const briefs = ref<BriefListEntry[]>([])

function rescanBriefs() {
  const store = getActiveEditorStoreOrNull()
  briefs.value = store ? scanCurrentPageBriefs(store) : []
}

/**
 * trigger 单段式需求单计数（T66 决策①；2026-09-27 设计段收敛）：与面板列表
 * 同口径（当前页，scanCurrentPageBriefs）；sceneVersion watcher 保新鲜——
 * 图变更即重扫。
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
//
// 2026-09-27 chat-ui-consolidation 歧义对齐：
//  - 当页仅一份 brief → 点击新建 = 直开该 brief 的 dialog（用户意图是编辑
//    现有，不再造新 brief）。
//  - 当页 ≥ 2 份 brief → 提示从列表选择，避免歧义与重复创建。
//  - 当页无 brief → 维持原行为（新建 + 开 dialog）。

const creatingBusy = ref(false)

async function startCreate() {
  if (creatingBusy.value) return
  const store = getActiveEditorStoreOrNull()
  if (!store) return
  rescanBriefs()
  const knownBriefs = briefs.value
  if (knownBriefs.length === 1) {
    open.value = false
    openBriefDialog(knownBriefs[0].briefId)
    return
  }
  if (knownBriefs.length > 1) {
    toast.info(panelsText.value.briefAmbiguousHint)
    return
  }
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
  if (value) rescanBriefs()
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
        <icon-lucide-book-open class="size-3 shrink-0" />
        <!-- T66 决策① 单段式「需求单：N」；空值 text-muted 弱色 -->
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
          <!-- 需求单列表（当前页）+ 新建入口；条目点击 → ChatBriefDialog（T66） -->
          <div class="space-y-1">
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
