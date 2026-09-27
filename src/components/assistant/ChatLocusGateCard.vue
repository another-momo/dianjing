<script setup lang="ts">
/**
 * 2026-09-27 sl-w2-locus-gate：落点拦截门确认卡（§3.1）——
 * 复用现有确认卡族渲染形态（与 ChatNewIntentCard / ChatSetActiveDesignCard
 * 对齐：虚线边框、无填充、系统样式），不新开模态。两变体：
 *
 *  - `switch`：视图页 ≠ 落点页（页仍存在）—— 两按钮「留在原施工页 / 切到当前页」
 *  - `orphan`：落点页缺失（腐烂 / 悬空 / 首跑后 re-init）—— 单按钮「确认切换」
 *
 * 行为统一收口于上层（ChatPanel.handleSubmit）：本组件只承担文案渲染与
 * 事件 emit；按钮按下 → emit 决断 → 上层写 PUT / switchPage 后放行发送。
 *
 * 与 set_active_design 同意卡不同：本卡不写 active-design-decision 归档
 * part——落点是文档级标量（page-state/<docUuid>.json），机制真源在后端
 * 端点直写，不进消息流（§6.3「确认即物化」：确认端点直写唯一存储）。
 */
import { computed } from 'vue'

import { useForkLocus } from '@/app/i18n/fork'

export type LocusGateReason = 'switch' | 'orphan'

export interface LocusGateView {
  /** 当前视图页名（用户发消息时所在的页） */
  viewPageName: string
  /** 现有落点页名；orphan 变体可为空字符串（落点未设置 / 已删） */
  engagedPageName: string
  /** switch：两按钮形态；orphan：单按钮确认 */
  reason: LocusGateReason
}

const { view, disabled = false } = defineProps<{
  view: LocusGateView
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** switch 变体二选一：'go' = 切到当前视图页（PUT engaged=view + 发）/ 'stay' = 留在落点页（switchPage 视图切回 engaged + 发） */
  decide: [decision: 'go' | 'stay']
  /** orphan 变体单按钮确认：即 'go' 语义 */
  confirm: []
}>()

const locusText = useForkLocus()

const isLocked = computed(() => disabled)

const prompt = computed(() => {
  if (view.reason === 'switch') {
    return locusText.value.locusSwitchPrompt({
      engaged: view.engagedPageName,
      view: view.viewPageName
    })
  }
  return locusText.value.locusOrphanPrompt({ view: view.viewPageName })
})

function handleGo() {
  if (isLocked.value) return
  emit('decide', 'go')
}

function handleStay() {
  if (isLocked.value) return
  emit('decide', 'stay')
}

function handleConfirm() {
  if (isLocked.value) return
  emit('confirm')
}
</script>

<template>
  <!-- 系统样式（虚线边框无填充）——与 ChatNewIntentCard / ChatSetActiveDesignCard 对齐 -->
  <div
    data-test-id="locus-gate-card"
    :data-reason="view.reason"
    class="space-y-2 rounded-md border border-dashed border-border px-3 py-2.5"
  >
    <div class="flex items-center gap-2">
      <icon-lucide-pin class="size-3.5 shrink-0 text-muted" />
      <span class="text-[12px] font-medium text-surface">{{ prompt }}</span>
    </div>

    <div v-if="view.reason === 'switch'" class="flex items-center justify-end gap-2">
      <button
        type="button"
        :disabled="isLocked"
        data-test-id="locus-gate-stay"
        class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleStay"
      >
        {{ locusText.locusSwitchStay({ engaged: view.engagedPageName }) }}
      </button>
      <button
        type="button"
        :disabled="isLocked"
        data-test-id="locus-gate-go"
        class="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleGo"
      >
        {{ locusText.locusSwitchGo({ view: view.viewPageName }) }}
      </button>
    </div>

    <div v-else class="flex items-center justify-end gap-2">
      <button
        type="button"
        :disabled="isLocked"
        data-test-id="locus-gate-confirm"
        class="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleConfirm"
      >
        {{ locusText.locusOrphanConfirm }}
      </button>
    </div>
  </div>
</template>
