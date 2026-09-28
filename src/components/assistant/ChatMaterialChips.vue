<script setup lang="ts">
import { computed } from 'vue'

/**
 * 物料排：输入框下方的物料 chip 横向滚动条（紧贴 ChatModeChips 下方一排）。
 *
 * 用户点选物料 → piPendingMaterial 暂存为 armed（toggle：同 id 再点 = 清空）。
 * 消息发送时 ChatPanel buildPiMaterialPrefix 在消息头拼物料提示行，
 * agent 据此按平台规格落图——尺寸无需在工具描述枚举、用户无需手敲 alias。
 *
 * 数据 = core material-specs 物料规格库（与 setup_design 同一份单源）。
 * Tip 悬停 = label + 尺寸（HUG 时显示流高）+ notes（如有）。
 */
import {
  MATERIAL_SPECS,
  type MaterialSpec
} from '@open-pencil/core/tools/fork/marketing/material-specs'

import { piPendingMaterial, setPiPendingMaterial } from '@/app/ai/pi-backend/mode-selection'
import { useForkChips } from '@/app/i18n/fork'
import Tip from '@/components/ui/overlay/Tip.vue'

const { disabled = false } = defineProps<{ disabled?: boolean }>()

const chipsText = useForkChips()

/** 当前 armed id（与逐 chip 比对决定 accent 锚点）；null = 无 armed */
const armedId = computed(() => piPendingMaterial.value?.id ?? null)

/** 用于 Tip：把 MaterialSpec 拍平成 label + 尺寸 + notes（若有）的单行 */
function tipText(spec: MaterialSpec): string {
  const size =
    spec.height === null
      ? `${spec.width}×${chipsText.value.chipsMaterialHeightFlow}`
      : `${spec.width}×${spec.height}`
  return spec.notes ? `${spec.label} · ${size} · ${spec.notes}` : `${spec.label} · ${size}`
}

function pickMaterial(spec: MaterialSpec): void {
  if (disabled) return
  setPiPendingMaterial(spec)
}
</script>

<template>
  <div data-test-id="chat-material-chips" class="flex min-w-0 items-center gap-1 overflow-x-auto">
    <span data-test-id="chat-material-row-label" class="shrink-0 text-[10px] text-muted">
      {{ chipsText.chipsMaterialLabel }}
    </span>
    <Tip v-for="spec in MATERIAL_SPECS" :key="spec.id" :label="tipText(spec)">
      <button
        type="button"
        :data-test-id="`chat-material-chip`"
        :data-material-id="spec.id"
        :aria-pressed="spec.id === armedId"
        :disabled="disabled"
        class="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] outline-none hover:border-accent/50 hover:text-surface disabled:cursor-not-allowed disabled:opacity-60"
        :class="spec.id === armedId ? 'border-accent/60 bg-accent/10 text-accent' : 'text-muted'"
        @click="pickMaterial(spec)"
      >
        {{ spec.label }}
      </button>
    </Tip>
  </div>
</template>
