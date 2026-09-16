<script setup lang="ts">
/**
 * T61（Phase 3 W3/T-B10）：新建意图确认卡——用户手动改 chip + 发消息时，
 * ChatPanel 拦截发送并注入宿主发起的 data part（非工具 part，T56 卡片范式），
 * 本卡片渲染之。
 *
 * T65：
 *  - 尺寸行（决策 C）：预设 chips（data.sizeChoices = 选中 mode 的 manifest.sizes
 *    投影 [{label,canvas}]）+ 自定义输入（`Wx`/`WxH`）；选择随 confirm 上抛，
 *    进信封 canvas 字段；缺省 = 自动（AI 按语义决定，信封省略字段）。
 *  - 视觉从气泡降权为系统样式（决策 D3 衍生：虚线边框 + 无填充，区别用户/AI 气泡）。
 *  - 统一卡面（A3/C1）——勾选股与 Case A/B 分叉已退役，参考意图由 agent 从
 *    会话语言解析（内容在同一画布上，agent 自然能读到用户指认的参考）；
 *    Case A/B 物化判据随之失去消费者。
 *
 * 确认 → emit confirm {referenceNodeIds, canvas}；取消 → emit cancel（chips 回滚
 * 回显、消息留输入框——由 ChatPanel 执行）。决断写回 part data 的 resolved
 * 字段（重载后保持置灰，同 answeredFormIds 的派生纪律）。
 */
import { computed, ref } from 'vue'

import { useForkConfirm } from '@/app/i18n/fork'

import { CANVAS_VALUE_PATTERN, type NewIntentPartData } from './active-design'

const { data, disabled = false } = defineProps<{
  data: NewIntentPartData
  disabled?: boolean
}>()

const emit = defineEmits<{
  confirm: [payload: { referenceNodeIds: string[]; canvas: string | null }]
  cancel: []
}>()

const confirmText = useForkConfirm()

const isLocked = computed(() => data.resolved !== null || disabled)

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

function handleConfirm() {
  if (isLocked.value) return
  const canvas = canvasDraft.value.trim()
  emit('confirm', {
    referenceNodeIds: [],
    canvas: CANVAS_VALUE_PATTERN.test(canvas) ? canvas : null
  })
}

function handleCancel() {
  if (isLocked.value) return
  emit('cancel')
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

    <!-- 统一卡面（A3/C1）：勾选股与 Case A/B 分叉已退役 -->
    <div class="text-[11px] text-surface">
      {{ confirmText.intentUnifiedLine }}
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
        :disabled="isLocked"
        data-test-id="new-intent-confirm"
        class="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleConfirm"
      >
        {{ confirmText.intentConfirm }}
      </button>
    </div>
  </div>
</template>
