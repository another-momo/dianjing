<script setup lang="ts">
/**
 * T91b：setup_design awaiting_new_intent_confirmation 信封卡片。
 *
 * 触发：AI 调 setup_design 但 args + pluginData 皆未确认 → core 返 awaiting 信封
 * （非错误）；前端检测到该信封 → 未决态由 pending-decision dock 承接交互，
 * 已决/失效归档在消息流内以本卡渲染（替换通用工具卡）。
 *
 * 批 2（2026-09-21 拍板①⑤⑥ + D6）：
 *  - 卡面 label 化：mode/profile 以 piStudioManifest label 投影（回退信封 catalog
 *    快照的 mode label，再回退裸 id）；briefId 换需求单名（解析不到回退 id）；
 *    canvas 显示 AI 提议值（工具 input.canvas，缺省 = 自动）；信封 message 不再
 *    直渲（那是模型向协议指令，F1-L2），换用户向 i18n 键。
 *  - 三态合一：pending = 未决可交互（dock，仅 idle 可点——disabled 由 ChatPanel
 *    透传）；resolved = 已决归档（徽标）；expired = 未作答即失效（徽标 + 说明行）。
 *  - 确认成功后由 ChatPanel 自动重发末条用户消息续跑（用户零重打）。
 */
import { computed } from 'vue'

import { piStudioManifest } from '@/app/ai/pi-backend/mode-selection'
import { useForkConfirm } from '@/app/i18n/fork'

import type { AwaitingIntentCardView } from './active-design'

const { view, disabled = false } = defineProps<{
  view: AwaitingIntentCardView
  disabled?: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const confirmText = useForkConfirm()

const isLocked = computed(() => view.mode !== 'pending' || disabled)

// ── 拍板⑤：label 投影（manifest 活数据优先 → 信封 catalog 快照 → 裸 id） ──

const modeLabel = computed(
  () =>
    piStudioManifest.value?.modes.find((mode) => mode.id === view.modeId)?.label ??
    view.catalogModes.find((mode) => mode.id === view.modeId)?.label ??
    view.modeId
)
const profileLabel = computed(() => {
  if (view.profileId === '') return confirmText.value.intentNoProfile
  return (
    piStudioManifest.value?.profiles.find((profile) => profile.id === view.profileId)?.label ??
    view.profileId
  )
})
const briefLabel = computed(() => view.briefName ?? view.briefId)
const canvasLabel = computed(() => view.canvas ?? confirmText.value.intentSizeAuto)

function handleConfirm() {
  if (isLocked.value) return
  emit('confirm')
}

function handleCancel() {
  if (isLocked.value) return
  emit('cancel')
}
</script>

<template>
  <!-- 系统样式（虚线边框无填充）——区别于用户/AI 气泡，与 ChatNewIntentCard 对齐 -->
  <div
    data-test-id="awaiting-intent-card"
    class="space-y-2 rounded-md border border-dashed border-border px-3 py-2.5"
  >
    <div class="flex items-center gap-2">
      <icon-lucide-sparkles class="size-3.5 shrink-0 text-muted" />
      <span class="text-[12px] font-medium text-surface">{{
        confirmText.awaitingIntentTitle
      }}</span>
      <span
        v-if="view.mode === 'resolved'"
        data-test-id="awaiting-intent-resolved-badge"
        class="rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted"
      >
        {{
          view.decision === 'confirmed'
            ? confirmText.intentConfirmedBadge
            : confirmText.intentCancelledBadge
        }}
      </span>
      <span
        v-else-if="view.mode === 'expired'"
        data-test-id="awaiting-intent-expired-badge"
        class="rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted"
      >
        {{ confirmText.awaitingIntentExpiredBadge }}
      </span>
    </div>

    <div class="space-y-0.5 text-[11px] text-surface">
      <div>
        <span class="text-muted">{{ confirmText.awaitingIntentMode }}:</span>
        <span data-test-id="awaiting-intent-mode" class="ml-1">{{ modeLabel }}</span>
      </div>
      <div>
        <span class="text-muted">{{ confirmText.awaitingIntentProfile }}:</span>
        <span data-test-id="awaiting-intent-profile" class="ml-1">{{ profileLabel }}</span>
      </div>
      <div v-if="view.briefId">
        <span class="text-muted">{{ confirmText.awaitingIntentBrief }}:</span>
        <span data-test-id="awaiting-intent-brief" class="ml-1">{{ briefLabel }}</span>
      </div>
      <div>
        <span class="text-muted">{{ confirmText.awaitingIntentCanvas }}:</span>
        <span data-test-id="awaiting-intent-canvas" class="ml-1">{{ canvasLabel }}</span>
      </div>
    </div>

    <p
      v-if="view.mode === 'pending'"
      data-test-id="awaiting-intent-prompt"
      class="text-[11px] text-muted"
    >
      {{ confirmText.awaitingIntentPrompt }}
    </p>
    <p
      v-else-if="view.mode === 'expired'"
      data-test-id="awaiting-intent-expired-line"
      class="text-[11px] text-muted"
    >
      {{ confirmText.awaitingIntentExpiredLine }}
    </p>

    <div v-if="view.mode === 'pending'" class="flex items-center justify-end gap-2">
      <button
        type="button"
        :disabled="isLocked"
        data-test-id="awaiting-intent-cancel"
        class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleCancel"
      >
        {{ confirmText.awaitingIntentCancel }}
      </button>
      <button
        type="button"
        :disabled="isLocked"
        data-test-id="awaiting-intent-confirm"
        class="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleConfirm"
      >
        {{ confirmText.awaitingIntentConfirm }}
      </button>
    </div>
  </div>
</template>
