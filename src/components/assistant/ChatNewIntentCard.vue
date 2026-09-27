<script setup lang="ts">
/**
 * T61（Phase 3 W3/T-B10）：新建意图确认卡——用户手动改 chip + 发消息时，
 * ChatPanel 拦截发送；批 2（2026-09-21 拍板①②⑤）起未决卡由 pending-decision
 * dock 承接（不再注入消息流），决断落地后 ChatPanel 追加归档 data part，
 * 本组件以 resolved 态渲染之。
 *
 * 批 2 形态：
 *  - 卡面 label 化（拍板⑤）：mode/profile 以 piStudioManifest label 投影复述
 *    确认内容（F7 修复——旧卡面只有一句「将按选中的模式/风格」不说内容）；
 *    manifest 未加载回退裸 id，无 profile 显示「无风格档案」。
 *  - 草稿随卡（拍板②）：拦截正文在卡内展示并可编辑，确认发的是卡上内容
 *    （消灭「快照 ≠ 用户预期」）；dock 独占形态不为意图卡破例（输入框摘除）。
 *  - 归档态（resolved 非 null）：徽标 + 参数复述 + 正文快照，只读无按钮。
 *
 * 确认 → emit confirm {text}；取消 → emit cancel {text}（取消后正文
 * 回填输入框——由 ChatPanel 执行）。
 */
import { computed, ref } from 'vue'

import { piStudioManifest } from '@/app/ai/pi-backend/mode-selection'
import { useForkConfirm } from '@/app/i18n/fork'

import type { NewIntentPartData } from './active-design'

const { data, disabled = false } = defineProps<{
  data: NewIntentPartData
  disabled?: boolean
}>()

const emit = defineEmits<{
  confirm: [payload: { text: string }]
  cancel: [payload: { text: string }]
}>()

const confirmText = useForkConfirm()

const isResolved = computed(() => data.resolved !== null)
const isLocked = computed(() => isResolved.value || disabled)

// ── 拍板⑤：mode/profile label 投影（manifest 未加载回退裸 id） ──

const modeLabel = computed(() => {
  if (!data.modeId) return '—'
  return piStudioManifest.value?.modes.find((mode) => mode.id === data.modeId)?.label ?? data.modeId
})
const profileLabel = computed(() => {
  if (!data.profileId) return confirmText.value.intentNoProfile
  return (
    piStudioManifest.value?.profiles.find((profile) => profile.id === data.profileId)?.label ??
    data.profileId
  )
})

// ── 拍板②：草稿随卡（卡内编辑，确认发卡上内容；F9-4：referenceNodeIds 死参删除） ──

const draftText = ref(data.text)
const draftValid = computed(() => draftText.value.trim() !== '')

function handleConfirm() {
  if (isLocked.value || !draftValid.value) return
  emit('confirm', { text: draftText.value })
}

function handleCancel() {
  if (isLocked.value) return
  emit('cancel', { text: draftText.value })
}
</script>

<template>
  <!-- T65：系统视觉（虚线边框无填充）——宿主发起，区别于用户/AI 气泡 -->
  <div
    data-test-id="new-intent-card"
    class="space-y-2 rounded-md border border-dashed border-border px-3 py-2.5"
  >
    <div class="flex items-center gap-2">
      <icon-lucide-sparkles class="size-3.5 shrink-0 text-muted" />
      <span class="text-[12px] font-medium text-surface">{{ confirmText.intentTitle }}</span>
      <span
        v-if="data.resolved !== null"
        data-test-id="new-intent-resolved-badge"
        class="rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted"
      >
        {{
          data.resolved === 'confirmed'
            ? confirmText.intentConfirmedBadge
            : confirmText.intentCancelledBadge
        }}
      </span>
    </div>

    <!-- 拍板⑤：卡面复述将确认的 mode/profile label（替代旧统一行静态文案） -->
    <div class="text-[11px] text-surface" data-test-id="new-intent-summary">
      {{ confirmText.intentSummaryLine({ mode: modeLabel, profile: profileLabel }) }}
    </div>

    <!-- 归档态：实际正文快照（只读） -->
    <template v-if="isResolved">
      <pre
        data-test-id="new-intent-text"
        class="overflow-x-auto rounded bg-input px-2 py-1.5 text-[11px] break-all whitespace-pre-wrap text-muted"
        >{{ data.text }}</pre>
    </template>

    <template v-else>
      <!-- 拍板②：草稿随卡——拦截正文卡内可编辑，确认发的是卡上内容 -->
      <div class="space-y-1">
        <div class="text-[11px] font-medium text-muted">{{ confirmText.intentDraftSection }}</div>
        <textarea
          v-model="draftText"
          rows="3"
          :disabled="disabled"
          data-test-id="new-intent-draft"
          class="block w-full resize-y rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
        />
      </div>

      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          :disabled="isLocked"
          data-test-id="new-intent-cancel"
          class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          @click="handleCancel"
        >
          {{ confirmText.intentCancel }}
        </button>
        <button
          type="button"
          :disabled="isLocked || !draftValid"
          data-test-id="new-intent-confirm"
          class="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
          @click="handleConfirm"
        >
          {{ confirmText.intentConfirm }}
        </button>
      </div>
    </template>
  </div>
</template>
