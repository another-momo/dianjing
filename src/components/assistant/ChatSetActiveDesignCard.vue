<script setup lang="ts">
import type { UIDataTypes, UIMessagePart, UITools } from 'ai'
/**
 * T61（Phase 3 W3/T-B10）：set_active_design 工具同意卡（共享契约 3）。
 *
 * part.output 形状 { proposed: { nodeId, ... } }（mutates:false，不落槽——
 * 切换只在本卡片同意后发生）。目标设计名优先读 proposed 投影，缺省读画布
 * 节点名，再缺省回退 nodeId。
 *
 * 同意 → emit decide(true)（ChatPanel 调 POST /api/pi/active-design，共享契约 2，
 * 与设计列表面板「设为当前」共用端点）；不同意 → emit decide(false)。
 * 两侧均不伪装用户消息——同意后回执走 data-context-switch 分割线（T65 决策 D3，
 * ChatPanel 落地）。
 * 决断记录（data-active-design-decision part）由 ChatPanel 扫描派生 resolved
 * 传入，重载后保持置灰。
 *
 * T65：视觉从气泡降权为系统样式（决策 D3 衍生：虚线边框 + 无填充）。
 */
import { computed } from 'vue'

import { getActiveEditorStoreOrNull } from '@/app/editor/active-store'
import { useForkConfirm } from '@/app/i18n/fork'

import { parseSetActiveDesignProposed } from './active-design'

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { toolCallId: string }>

const {
  part,
  resolved = null,
  disabled = false
} = defineProps<{
  part: ToolPart
  resolved?: 'agreed' | 'declined' | null
  disabled?: boolean
}>()

const emit = defineEmits<{
  decide: [agree: boolean]
}>()

const confirmText = useForkConfirm()

// proposed 在工具结果（part.output），part.input 是工具入参 {node_id}（核验钉死）
const proposed = computed(() =>
  parseSetActiveDesignProposed(part.state === 'output-available' ? part.output : undefined)
)

const proposedNodeId = computed(() => proposed.value.nodeId)

const proposedName = computed(() => proposed.value.name)

/** 目标设计名：proposed 投影 > 画布读穿 > nodeId 回退 */
const targetName = computed(() => {
  if (proposedName.value) return proposedName.value
  if (proposedNodeId.value) {
    const store = getActiveEditorStoreOrNull()
    const name = store?.graph.getNode(proposedNodeId.value)?.name
    if (name) return name
    return proposedNodeId.value
  }
  return '—'
})

const isLocked = computed(() => resolved !== null || disabled)

function handleDecide(agree: boolean) {
  if (isLocked.value) return
  emit('decide', agree)
}
</script>

<template>
  <!-- T65：系统视觉（虚线边框无填充）——宿主决定卡，区别于用户/AI 气泡 -->
  <div
    data-test-id="set-active-design-card"
    class="space-y-2 rounded-md border border-dashed border-border px-3 py-2.5"
  >
    <div class="flex items-center gap-2">
      <icon-lucide-pin class="size-3.5 shrink-0 text-muted" />
      <span class="text-[12px] font-medium text-surface">{{ confirmText.consentTitle }}</span>
      <span
        v-if="resolved !== null"
        data-test-id="set-active-design-resolved-badge"
        class="rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted"
      >
        {{
          resolved === 'agreed' ? confirmText.consentAgreedBadge : confirmText.consentDeclinedBadge
        }}
      </span>
    </div>

    <div class="text-[11px] text-surface">
      {{ confirmText.consentTarget({ name: targetName }) }}
    </div>

    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        :disabled="isLocked"
        data-test-id="set-active-design-decline"
        class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleDecide(false)"
      >
        {{ confirmText.consentDecline }}
      </button>
      <button
        type="button"
        :disabled="isLocked"
        data-test-id="set-active-design-agree"
        class="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleDecide(true)"
      >
        {{ confirmText.consentAgree }}
      </button>
    </div>
  </div>
</template>
