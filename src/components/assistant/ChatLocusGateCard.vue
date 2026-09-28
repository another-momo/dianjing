<script setup lang="ts">
/**
 * 2026-09-27 sl-w2-locus-gate：落点拦截门确认卡（§3.1）——
 * 复用现有确认卡族渲染形态（与 ChatNewIntentCard
 * 对齐：虚线边框、无填充、系统样式），不新开模态。单变体：
 * 视图页 ≠ 落点页（落点页仍在）——「取消 / 留在落点页 / 切到当前页」三按钮。
 * （落点未设置 / 悬空不弹卡——判定层静默重锚后直接放行。）
 *
 * 行为统一收口于上层（ChatPanel.handleSubmit）：本组件只承担文案渲染与
 * 事件 emit；decide → 上层写 PUT / switchPage 后放行发送；cancel → 上层收卡
 * 并把草稿回填输入框（零网络动作）。
 *
 * 本卡不写归档 part——落点是文档级标量（page-state/<docUuid>.json），机制真源
 * 在后端端点直写，不进消息流（§6.3「确认即物化」：确认端点直写唯一存储）。
 */
import { computed } from 'vue'

import { useForkLocus } from '@/app/i18n/fork'

import type { LocusGateView } from './locus'

const { view, disabled = false } = defineProps<{
  view: LocusGateView
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 二选一：'go' = 切到当前视图页（PUT engaged=view + 发）/ 'stay' = 留在落点页（switchPage 视图切回 engaged + 发） */
  decide: [decision: 'go' | 'stay']
  /** 取消：收卡 + 草稿回填输入框，零网络动作 */
  cancel: []
}>()

const locusText = useForkLocus()

const isLocked = computed(() => disabled)

const prompt = computed(() =>
  locusText.value.locusSwitchPrompt({
    engaged: view.engagedPageName,
    view: view.viewPageName
  })
)

function handleGo() {
  if (isLocked.value) return
  emit('decide', 'go')
}

function handleStay() {
  if (isLocked.value) return
  emit('decide', 'stay')
}

function handleCancel() {
  if (isLocked.value) return
  emit('cancel')
}
</script>

<template>
  <!-- 系统样式（虚线边框无填充）——与 ChatNewIntentCard 对齐 -->
  <div
    data-test-id="locus-gate-card"
    class="space-y-2 rounded-md border border-dashed border-border px-3 py-2.5"
  >
    <div class="flex items-center gap-2">
      <icon-lucide-pin class="size-3.5 shrink-0 text-muted" />
      <span class="text-[12px] font-medium text-surface">{{ prompt }}</span>
    </div>

    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        :disabled="isLocked"
        data-test-id="locus-gate-cancel"
        class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleCancel"
      >
        {{ locusText.locusGateCancel }}
      </button>
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
  </div>
</template>
