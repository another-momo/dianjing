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
 *  - 尺寸行（T65 决策 C 保留）：预设 chips + 自定义输入；缺省 = 自动。
 *  - 归档态（resolved 非 null）：徽标 + 参数复述 + 正文快照，只读无按钮。
 *
 * 确认 → emit confirm {canvas, text}；取消 → emit cancel {text}（取消后正文
 * 回填输入框——由 ChatPanel 执行）。
 */
import { computed, ref } from 'vue'

import { piStudioManifest } from '@/app/ai/pi-backend/mode-selection'
import { useForkConfirm } from '@/app/i18n/fork'

import { CANVAS_VALUE_PATTERN, type NewIntentPartData } from './active-design'

const { data, disabled = false } = defineProps<{
  data: NewIntentPartData
  disabled?: boolean
}>()

const emit = defineEmits<{
  confirm: [payload: { canvas: string | null; text: string }]
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

// ── T65：尺寸行（预设 chips + 自定义输入；空 = 自动） ──

const canvasDraft = ref('')

const canvasDraftValid = computed(
  () => canvasDraft.value.trim() === '' || CANVAS_VALUE_PATTERN.test(canvasDraft.value.trim())
)

function pickSize(canvas: string) {
  if (isLocked.value) return
  canvasDraft.value = canvas
}

function pickAutoSize() {
  if (isLocked.value) return
  canvasDraft.value = ''
}

// ── 拍板②：草稿随卡（卡内编辑，确认发卡上内容；F9-4：referenceNodeIds 死参删除） ──

const draftText = ref(data.text)
const draftValid = computed(() => draftText.value.trim() !== '')

function handleConfirm() {
  if (isLocked.value || !draftValid.value || !canvasDraftValid.value) return
  const canvas = canvasDraft.value.trim()
  emit('confirm', {
    canvas: CANVAS_VALUE_PATTERN.test(canvas) ? canvas : null,
    text: draftText.value
  })
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

    <!-- 归档态：确认选定的 canvas + 实际正文快照（只读） -->
    <template v-if="isResolved">
      <div v-if="data.canvas" class="text-[11px] text-surface">
        <span class="text-muted">{{ confirmText.intentSizeSection }}:</span>
        <span data-test-id="new-intent-canvas" class="ml-1">{{ data.canvas }}</span>
      </div>
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

      <!-- T65：尺寸行（预设 chips + 自定义输入；空 = 自动由 AI 决定） -->
      <div class="space-y-1">
        <div class="text-[11px] font-medium text-muted">{{ confirmText.intentSizeSection }}</div>
        <div class="flex flex-wrap items-center gap-1">
          <button
            type="button"
            :disabled="isLocked"
            data-test-id="new-intent-size-auto"
            class="rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            :class="
              canvasDraft === ''
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-muted hover:bg-hover'
            "
            @click="pickAutoSize"
          >
            {{ confirmText.intentSizeAuto }}
          </button>
          <button
            v-for="choice in data.sizeChoices"
            :key="choice.canvas"
            type="button"
            :disabled="isLocked"
            :data-test-id="`new-intent-size-preset`"
            :data-canvas="choice.canvas"
            class="rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            :class="
              canvasDraft === choice.canvas
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-muted hover:bg-hover'
            "
            @click="pickSize(choice.canvas)"
          >
            {{ choice.label }}
            <span class="text-muted">{{ choice.canvas }}</span>
          </button>
        </div>
        <input
          v-model="canvasDraft"
          type="text"
          :disabled="isLocked"
          :placeholder="confirmText.intentSizeCustomPlaceholder"
          data-test-id="new-intent-size-custom"
          class="block w-full rounded-md border border-border bg-input px-2.5 py-1 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
        />
        <div
          v-if="!canvasDraftValid"
          data-test-id="new-intent-size-invalid"
          class="text-[11px] text-red-400"
        >
          {{ confirmText.intentSizeInvalid }}
        </div>
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
          :disabled="isLocked || !draftValid || !canvasDraftValid"
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
