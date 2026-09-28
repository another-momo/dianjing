<script setup lang="ts">
/**
 * T65（决策 B1/B2）：需求单入口。2026-09-28 chat-brief-button-relayout：
 * 从 header 迁入 PiChatInput actions 行（skill / 画布选区 / 需求单 序，
 * 按钮样式与行内兄弟同款）；一页一需求单拍板落地为单按钮两态——
 *
 *  - 当页 0 份：按钮 = 「新建需求单」，点击 → 桥直调 createBriefOnPage('')
 *    落空 brief → 自动打开 ChatBriefDialog（沿 T79 U1 流）。
 *  - 当页 1 份：按钮 = 「编辑需求单」，点击 → 直开该 brief 的 dialog。
 *  - 当页 ≥2 份（异常态：粘贴/桥复制产生）：按钮 = 「编辑需求单」+ chevron，
 *    点击 → popover 列表消歧（面板顶部常驻提示「一页一份，多余请删」），
 *    点条目开对应 dialog；不提供新建入口（一页一单），也不再 toast
 *    （消歧面板取代 09-28 早批的 toast 提示）。
 *  - 计数口径 = 当前页（scanCurrentPageBriefs），sceneVersion watcher 保新鲜。
 *  - 列表条目展示 name + 内容预览（截首 40 字符；空 brief 隐藏）。
 *
 * 纪律（沿 T61）：零自有事实源——打开/保存后重读画布；编辑写回走 core
 * brief-edit 原语（画布节点单一事实源）。
 */
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, ref, watch } from 'vue'

import { getActiveEditorStoreOrNull, useActiveEditorStoreRef } from '@/app/editor/active-store'
import { useForkPanels } from '@/app/i18n/fork'
import { toast } from '@/app/shell/ui'
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

const briefs = ref<BriefListEntry[]>([])

function rescanBriefs() {
  const store = getActiveEditorStoreOrNull()
  briefs.value = store ? scanCurrentPageBriefs(store) : []
}

/** 按钮两态与消歧判定的事实源：当前页 brief 计数（sceneVersion watcher 保新鲜） */
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

const creatingBusy = ref(false)

/** 0 份分支：新建空 brief 并打开 dialog（沿 T79 单按钮流） */
async function createAndOpen() {
  const store = getActiveEditorStoreOrNull()
  if (!store || creatingBusy.value) return
  creatingBusy.value = true
  try {
    const briefId = await createBriefOnPage(store, '')
    rescanBriefs()
    openBriefDialog(briefId)
  } catch (error) {
    console.error('Brief create error:', error)
    toast.error(panelsText.value.briefCreateFailed)
  } finally {
    creatingBusy.value = false
  }
}

/**
 * 点击分流：0 → 新建；1 → 直开编辑；≥2 → 不开分流、由 PopoverTrigger
 * 默认翻转 open（handleOpen 里按计数闸住——0/1 态恒不开面板）。
 */
function handleTriggerClick() {
  if (disabled || creatingBusy.value) return
  rescanBriefs()
  if (briefs.value.length === 0) {
    void createAndOpen()
    return
  }
  if (briefs.value.length === 1) {
    openBriefDialog(briefs.value[0].briefId)
  }
}

function handleOpen(value: boolean) {
  if (value) {
    rescanBriefs()
    if (briefs.value.length < 2) return
  }
  open.value = value
}

/** ≥2 消歧条目点击 → 打开需求单大面板，popover 随之关闭 */
function openBriefDetail(briefId: string) {
  open.value = false
  openBriefDialog(briefId)
}

const triggerLabel = computed(() =>
  briefCount.value === 0 ? panelsText.value.briefNew : panelsText.value.briefEdit
)
</script>

<template>
  <PopoverRoot :open="open" @update:open="handleOpen">
    <PopoverTrigger as-child>
      <button
        type="button"
        data-test-id="chat-context-trigger"
        :disabled="disabled || creatingBusy"
        class="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted hover:border-accent/50 hover:text-surface disabled:cursor-not-allowed disabled:opacity-60 data-[state=open]:border-accent/60 data-[state=open]:text-surface"
        @click="handleTriggerClick"
      >
        <icon-lucide-plus v-if="briefCount === 0" class="size-3 shrink-0" />
        <icon-lucide-book-open v-else class="size-3 shrink-0" />
        <span class="truncate">{{ triggerLabel }}</span>
        <icon-lucide-chevron-down v-if="briefCount >= 2" class="size-3 shrink-0 opacity-60" />
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent side="top" align="start" :side-offset="6" :class="cls.content">
        <!-- ≥2 份消歧列表（一页一单拍板：提示多余请删，不提供新建入口）；
             条目点击 → ChatBriefDialog -->
        <div data-test-id="chat-context-panel" class="max-h-[70vh] space-y-1 overflow-y-auto">
          <div class="px-1 pb-1 text-[11px] text-muted" data-test-id="chat-brief-disambiguate-hint">
            {{ panelsText.briefDisambiguateHint }}
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
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
