<script setup lang="ts">
/**
 * 物料规格选择器：聊天输入框下方的 dropdown（reka-ui DropdownMenu；与
 * ChatModeChips 的 mode/profile 选择器同形态、同 trigger 样式）。
 *
 * 用户在菜单里点选物料 → piPendingMaterial 暂存为 armed（toggle：同 id 再点
 * = 清空），或点「智能」项 → 显式清空（默认行为）。消息发送时 ChatPanel
 * buildPiMaterialPrefix 在消息头拼物料提示行——agent 据此按平台规格落图。
 *
 * 14 条物料来自 core material-specs，与 setup_design 同一份单源（避免
 * 重复维护导致漂移）。DropdownMenuItem 两行（主行 label + 副行尺寸+notes）
 * ——原 chip 排的悬停提示内容改由菜单副行常驻展示，无需悬停。
 */
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from 'reka-ui'
import { computed } from 'vue'

import {
  MATERIAL_SPECS,
  type MaterialSpec
} from '@open-pencil/core/tools/fork/marketing/material-specs'

import {
  clearPiPendingMaterial,
  piPendingMaterial,
  setPiPendingMaterial
} from '@/app/ai/pi-backend/mode-selection'
import { useForkChips } from '@/app/i18n/fork'
import { menuItem, useMenuUI } from '@/components/ui/menu/menu'

const { disabled = false } = defineProps<{ disabled?: boolean }>()

const chipsText = useForkChips()
const menuCls = useMenuUI({ content: 'min-w-44 max-w-64' })
const itemCls = menuItem({ justify: 'start' })

/** 当前 armed id（与逐物料项比对决定 accent 锚点）；null = 智能（未武装） */
const armedId = computed(() => piPendingMaterial.value?.id ?? null)

/** 副行 = 尺寸 + notes；null 时走 HUG 流高文案 */
function rowSubtitle(spec: MaterialSpec): string {
  const size =
    spec.height === null
      ? `${spec.width}×${chipsText.value.chipsMaterialHeightFlow}`
      : `${spec.width}×${spec.height}`
  return spec.notes ? `${size} · ${spec.notes}` : size
}

function pickMaterial(spec: MaterialSpec): void {
  if (disabled) return
  setPiPendingMaterial(spec)
}

function pickSmart(): void {
  if (disabled) return
  clearPiPendingMaterial()
}

/** 与 ChatModeChips trigger 同款；armed 变色整 trigger（图标随 currentColor） */
const triggerCls =
  'flex min-w-0 max-w-28 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] outline-none hover:bg-hover data-[state=open]:bg-hover disabled:cursor-not-allowed disabled:opacity-50'
const materialTriggerCls = computed(() => [
  triggerCls,
  armedId.value !== null ? 'text-accent' : 'text-muted'
])

/** armed 时显示物料 label；未武装时显示「智能」 */
const triggerLabel = computed(() => {
  const armed = piPendingMaterial.value
  return armed ? armed.label : chipsText.value.chipsMaterialSmart
})
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger
      data-test-id="chat-material-select"
      :aria-label="chipsText.chipsMaterialLabel"
      :disabled="disabled"
      :class="materialTriggerCls"
    >
      <icon-lucide-proportions class="size-3 shrink-0" />
      <span class="min-w-0 truncate">{{ triggerLabel }}</span>
      <icon-lucide-chevron-down class="size-2.5 shrink-0" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent side="top" align="start" :side-offset="4" :class="menuCls.content">
        <DropdownMenuItem
          data-test-id="chat-material-select-smart"
          :class="itemCls"
          @select="pickSmart"
        >
          <icon-lucide-check v-if="armedId === null" :class="menuCls.icon" class="shrink-0" />
          <span v-else class="size-3 shrink-0" />
          <span class="flex min-w-0 flex-col">
            <span class="truncate">{{ chipsText.chipsMaterialSmart }}</span>
            <span class="truncate text-[10px] text-muted">{{
              chipsText.chipsMaterialSmartHint
            }}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator :class="menuCls.separator" />
        <DropdownMenuItem
          v-for="spec in MATERIAL_SPECS"
          :key="spec.id"
          :class="itemCls"
          :data-test-id="`chat-material-select-item`"
          :data-material-id="spec.id"
          @select="pickMaterial(spec)"
        >
          <icon-lucide-check v-if="spec.id === armedId" :class="menuCls.icon" class="shrink-0" />
          <span v-else class="size-3 shrink-0" />
          <span class="flex min-w-0 flex-col">
            <span class="truncate">{{ spec.label }}</span>
            <span class="truncate text-[10px] text-muted">{{ rowSubtitle(spec) }}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
