<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { onMounted } from 'vue'

import { useI18n, useRetainedPopup } from '@open-pencil/vue'

import { onlineFontsEnabled } from '@/app/editor/fonts'
import { openSettingsDialog } from '@/app/settings/dialog'
import AppButton from '@/components/ui/button/AppButton.vue'
import { usePopoverUI } from '@/components/ui/overlay/popover'
import Tip from '@/components/ui/overlay/Tip.vue'

import { useFontSettings } from './use'

/**
 * 字体设置 popover（统一批 A 后降级）：
 * - 只读状态摘要（本地字体访问状态、当前字体选择与可用性指示）；
 * - 本地「允许访问」按钮这一场景化动作（picker 旁即触即用，不绕远）；
 * - 「打开字体设置」深链调用 openSettingsDialog('fonts') 迁入白名单面板
 *   管理提供商、回退包、缓存。
 *
 * 排版区字体选择器旁的入口；详细管理在 SettingsDialog → 字体。
 */
const { fonts, common } = useI18n()
const cls = usePopoverUI({ content: 'isolate z-[51] w-80 p-3' })
const trigger = 'shrink-0'
const secondaryButton = {
  color: 'neutral' as const,
  variant: 'soft' as const,
  size: 'xs' as const
}
const primaryButton = {
  color: 'primary' as const,
  variant: 'solid' as const,
  size: 'xs' as const
}
const { open: popoverOpen, portalActive } = useRetainedPopup()

const {
  accessState,
  accessStateLabel,
  busyAction,
  canRequestLocalFonts,
  status,
  refreshSummary,
  requestAccess
} = useFontSettings()

function setPopoverOpen(value: boolean) {
  popoverOpen.value = value
  if (value) void refreshSummary()
}

function openFullSettings() {
  popoverOpen.value = false
  openSettingsDialog('fonts')
}

onMounted(() => {
  void refreshSummary()
})
</script>

<template>
  <PopoverRoot v-model:open="popoverOpen" @update:open="setPopoverOpen">
    <Tip :label="fonts.settingsTitle" :disabled="popoverOpen">
      <PopoverTrigger
        data-test-id="font-settings-trigger"
        :aria-label="fonts.settingsTitle"
        :class="trigger"
      >
        <icon-lucide-settings class="size-3.5" />
      </PopoverTrigger>
    </Tip>

    <PopoverPortal v-if="portalActive">
      <PopoverContent
        data-test-id="font-settings-panel"
        side="left"
        :side-offset="8"
        align="start"
        :collision-padding="16"
        :avoid-collisions="true"
        :class="cls.content"
      >
        <div class="flex flex-col gap-3">
          <div class="flex items-start gap-2">
            <div
              class="flex size-8 shrink-0 items-center justify-center rounded bg-input text-muted"
            >
              <icon-lucide-type class="size-4" />
            </div>
            <div>
              <h3 class="text-[11px] font-semibold text-surface">
                {{ fonts.popoverSummaryTitle }}
              </h3>
              <p class="mt-0.5 text-[10px] leading-relaxed text-muted">
                {{ fonts.popoverSummaryHint }}
              </p>
            </div>
          </div>

          <div class="grid gap-1.5 rounded border border-border bg-input/40 p-2 text-[10px]">
            <div class="flex justify-between gap-3 text-muted">
              <span>{{ fonts.localFonts }}</span>
              <span class="text-surface">{{ accessStateLabel }}</span>
            </div>
            <div class="flex justify-between gap-3 text-muted">
              <span>{{ fonts.onlineFonts }}</span>
              <span class="text-surface">{{
                onlineFontsEnabled ? common.enabled : common.disabled
              }}</span>
            </div>
          </div>

          <div class="space-y-1.5">
            <div class="grid grid-cols-[1fr_auto] gap-2 rounded border border-border p-2">
              <div>
                <p class="text-[10px] font-medium text-surface">{{ fonts.systemFontAccess }}</p>
                <p class="mt-0.5 text-[10px] leading-relaxed text-muted">
                  {{
                    accessState === 'granted'
                      ? fonts.systemFontsAvailable
                      : fonts.allowBrowserFontAccess
                  }}
                </p>
              </div>
              <AppButton
                type="button"
                data-test-id="font-settings-request-access"
                :color="secondaryButton.color"
                :variant="secondaryButton.variant"
                :size="secondaryButton.size"
                :disabled="busyAction !== null || !canRequestLocalFonts"
                @click="requestAccess"
              >
                {{ busyAction === 'access' ? common.requesting : common.allow }}
              </AppButton>
            </div>

            <AppButton
              type="button"
              data-test-id="font-settings-open-settings"
              :color="primaryButton.color"
              :variant="primaryButton.variant"
              :size="primaryButton.size"
              @click="openFullSettings"
            >
              {{ fonts.openSettings }}
            </AppButton>
          </div>

          <p
            v-if="status"
            class="rounded bg-input px-2 py-1.5 text-[10px] leading-relaxed text-muted"
          >
            {{ status }}
          </p>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
