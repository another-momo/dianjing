<script setup lang="ts">
/**
 * T61（Phase 3 W3/T-B10）：输入条内联 chips——T24 ChatModeSelect /
 * ChatStyleProfileSelect 的 PD-16 翻案重做（S1 §6 选择器层级）。
 *
 *  - 两级数据驱动：mode chip → profile chip。
 *    type 中间级已随 T62 删除（manifest.modes[].types 数据面退役）——本文件
 *    无 type 级专属逻辑。
 *  - 恒回显 active_design（piChipSelection：未确认意向 > active 读穿 >
 *    默认态 general + 无 profile）；指针移动由 mode-selection watcher 自动
 *    同步，系统同步不触发意图。
 *  - 拨 chip = setPiChipSelection 暂存未确认意向（与回显相同则清空）；
 *    发消息时 ChatPanel 拦为新建意图确认卡。只拨 chip 浏览不发消息 = 无意图事件。
 *  - pending 意向呈现：与回显逐项比对（piChipEcho），不同的 chip 变 accent 色
 *    + Tip 悬停全文「将以 … 新建设计，发送时确认」；只拨 mode 仅 mode chip 变色。
 *    撤销 = 拨回原组合（sameSelection 自动清暂存），确认卡是最终闸门。
 *  - manifest 失败（piStudioManifestFailed）→ chips 禁用（错误条 + 重试在
 *    ChatInput 错误条区，08 P0-2）。
 *  - P2-10（2026-09-07）：profile 菜单按当前选中 mode ⊆ profile.modes 过滤——
 *    缺省/空数组 = 所有 mode 可用（无限制），显式填写时仅在指定 mode 下展示
 *    与注入。`「无风格档案」`项恒在（mode 仅决定时不强制选 profile）。
 *    （PD-17「正交不过滤」就此改变——modes 字段成为运行时权威。）
 */
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger
} from 'reka-ui'
import { computed } from 'vue'

import {
  piChipEcho,
  piChipSelection,
  piPendingNewIntent,
  piStudioManifest,
  piStudioManifestFailed,
  setPiChipSelection
} from '@/app/ai/pi-backend/mode-selection'
import { useForkChips } from '@/app/i18n/fork'
import { menuItem, useMenuUI } from '@/components/ui/menu/menu'
import Tip from '@/components/ui/overlay/Tip.vue'

const { disabled = false } = defineProps<{ disabled?: boolean }>()

const chipsText = useForkChips()
const menuCls = useMenuUI({ content: 'min-w-36 max-w-56' })
const itemCls = menuItem({ justify: 'start' })

const modes = computed(() => piStudioManifest.value?.modes ?? [])
const profiles = computed(() => piStudioManifest.value?.profiles ?? [])

// P2-10：profile 菜单按当前选中 mode 过滤——modes 缺省/空 = 全显示；显式填写仅在指定 mode 显示
const profilesForCurrentMode = computed(() => {
  const modeId = selection.value.modeId
  return profiles.value.filter((p) => p.modes.length === 0 || p.modes.includes(modeId))
})

const selection = computed(() => piChipSelection.value)

const selectedMode = computed(
  () => modes.value.find((mode) => mode.id === selection.value.modeId) ?? null
)
const selectedProfile = computed(
  () => profiles.value.find((profile) => profile.id === selection.value.profileId) ?? null
)

const chipsDisabled = computed(
  () => disabled || piStudioManifestFailed.value || piStudioManifest.value === null
)

// pending 意向呈现：与回显逐项比对，不同的 chip 变色 + Tip 挂全文（只拨 mode 仅 mode chip 变色）
const pending = computed(() => piPendingNewIntent.value)
const echo = computed(() => piChipEcho.value)
const modePendingChanged = computed(
  () => pending.value !== null && pending.value.modeId !== echo.value.modeId
)
const profilePendingChanged = computed(
  () => pending.value !== null && pending.value.profileId !== echo.value.profileId
)

const pendingModeLabel = computed(() => {
  const intent = pending.value
  if (!intent) return ''
  return modes.value.find((mode) => mode.id === intent.modeId)?.label ?? intent.modeId
})
const pendingProfileLabel = computed(() => {
  const intent = pending.value
  if (!intent) return ''
  if (intent.profileId === null) return chipsText.value.chipsNoProfile
  return (
    profiles.value.find((profile) => profile.id === intent.profileId)?.label ?? intent.profileId
  )
})

// Tip 全文（仅变色锚点上挂载——label 缺省 = Tip 不开）
const pendingTip = computed(() => {
  if (!pending.value) return undefined
  return chipsText.value.chipsPendingTip({
    mode: pendingModeLabel.value,
    profile: pendingProfileLabel.value
  })
})

function pickMode(modeId: string) {
  setPiChipSelection({ modeId, profileId: selection.value.profileId })
}

function pickProfile(profileId: string | null) {
  setPiChipSelection({ modeId: selection.value.modeId, profileId })
}

const triggerCls =
  'flex min-w-0 max-w-28 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] outline-none hover:bg-hover data-[state=open]:bg-hover disabled:cursor-not-allowed disabled:opacity-50'
// 变色 = 该字段与回显不同（accent）；未变色保持 muted
const modeTriggerCls = computed(() => [
  triggerCls,
  modePendingChanged.value ? 'text-accent' : 'text-muted'
])
const profileTriggerCls = computed(() => [
  triggerCls,
  profilePendingChanged.value ? 'text-accent' : 'text-muted'
])
</script>

<template>
  <div data-test-id="chat-mode-chips" class="flex min-w-0 items-center gap-0.5">
    <!-- mode chip（一级） -->
    <DropdownMenuRoot>
      <Tip :label="modePendingChanged ? pendingTip : undefined">
        <DropdownMenuTrigger
          data-test-id="chat-mode-chip"
          :aria-label="chipsText.chipsMode"
          :disabled="chipsDisabled"
          :class="modeTriggerCls"
        >
          <icon-lucide-palette class="size-3 shrink-0" />
          <span class="min-w-0 truncate">{{ selectedMode?.label ?? selection.modeId }}</span>
          <icon-lucide-chevron-down class="size-2.5 shrink-0" />
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuPortal>
        <DropdownMenuContent side="top" align="start" :side-offset="4" :class="menuCls.content">
          <DropdownMenuItem
            v-for="mode in modes"
            :key="mode.id"
            :class="itemCls"
            :data-test-id="`chat-mode-chip-item`"
            :data-mode-id="mode.id"
            @select="pickMode(mode.id)"
          >
            <icon-lucide-check
              v-if="mode.id === selection.modeId"
              :class="menuCls.icon"
              class="shrink-0"
            />
            <span v-else class="size-3 shrink-0" />
            <span class="min-w-0 truncate">{{ mode.label }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>

    <!-- profile chip（恒在，菜单按当前 mode 过滤） -->
    <DropdownMenuRoot>
      <Tip :label="profilePendingChanged ? pendingTip : undefined">
        <DropdownMenuTrigger
          data-test-id="chat-profile-chip"
          :aria-label="chipsText.chipsProfile"
          :disabled="chipsDisabled"
          :class="profileTriggerCls"
        >
          <icon-lucide-swatch-book class="size-3 shrink-0" />
          <span class="min-w-0 truncate">{{
            selectedProfile?.label ?? chipsText.chipsNoProfile
          }}</span>
          <icon-lucide-chevron-down class="size-2.5 shrink-0" />
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuPortal>
        <DropdownMenuContent side="top" align="start" :side-offset="4" :class="menuCls.content">
          <DropdownMenuItem
            :class="itemCls"
            data-test-id="chat-profile-chip-item"
            @select="pickProfile(null)"
          >
            <icon-lucide-check
              v-if="selection.profileId === null"
              :class="menuCls.icon"
              class="shrink-0"
            />
            <span v-else class="size-3 shrink-0" />
            <span class="min-w-0 truncate">{{ chipsText.chipsNoProfile }}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            v-for="profile in profilesForCurrentMode"
            :key="profile.id"
            :class="itemCls"
            :data-test-id="`chat-profile-chip-item`"
            :data-profile-id="profile.id"
            @select="pickProfile(profile.id)"
          >
            <icon-lucide-check
              v-if="profile.id === selection.profileId"
              :class="menuCls.icon"
              class="shrink-0"
            />
            <span v-else class="size-3 shrink-0" />
            <span class="min-w-0 truncate">{{ profile.label }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>
