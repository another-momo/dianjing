<script setup lang="ts">
import type { GateState } from '@/app/ai/pi-backend/provider-gate'
import { useForkPi } from '@/app/i18n/fork'
/**
 * pi-model-explicit-config（讨论稿 §3 落地清单 1）—— 引导卡组件。
 *
 * 两种渲染变体：
 * - needs-setup：图标 + 标题「设置设计模型」+ 说明「打开 AI 设置选 provider 与模型」
 *               + CTA「打开设置」→ openSettingsDialog('ai')
 * - needs-credential：图标 + 标题点名 provider「{providerName} 还没配置 key」
 *                    + 说明 + CTA「打开 {providerName} 设置」
 *                    → openSettingsDialog('ai', { provider: providerId })
 *
 * 文案 i18n 键：useForkPi() 的 providerGate（见 locales/*，由主 agent 统一补）
 *
 * 设计取舍：
 * - 骨架/loading 由 ChatPanel 单独渲（更简单的 placeholder 形态），本组件只承担 needs-* 两态
 * - 不耦合 PiModelsPanel；只通过 openSettingsDialog 入口交互
 * - 不读 useLocalStorage；providerId 由 props 传入（ChatPanel 已经派生好）
 */
import { openSettingsDialog } from '@/app/settings/dialog'

const piDialogs = useForkPi()

const { state } = defineProps<{
  /** 派生好的引导门态；本组件只接受 needs-setup / needs-credential */
  state: Extract<GateState, { kind: 'needs-setup' } | { kind: 'needs-credential' }>
}>()

function handleOpenSettings() {
  if (state.kind === 'needs-credential') {
    openSettingsDialog('ai', { provider: state.providerId })
    return
  }
  openSettingsDialog('ai')
}
</script>

<template>
  <div
    data-test-id="pi-provider-gate"
    :data-gate-kind="state.kind"
    class="flex min-h-0 flex-1 items-center justify-center px-6 py-8"
  >
    <div
      class="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-panel px-6 py-8 text-center"
    >
      <icon-lucide-sparkles class="size-8 text-muted" />
      <h2 class="text-base font-medium text-foreground">
        <template v-if="state.kind === 'needs-setup'">
          {{ piDialogs.providerGateSetupTitle }}
        </template>
        <template v-else>
          {{ piDialogs.providerGateCredentialTitle({ name: state.providerName }) }}
        </template>
      </h2>
      <p class="text-sm text-muted">
        <template v-if="state.kind === 'needs-setup'">
          {{ piDialogs.providerGateSetupDescription }}
        </template>
        <template v-else>
          {{ piDialogs.providerGateCredentialDescription }}
        </template>
      </p>
      <button
        type="button"
        data-test-id="pi-provider-gate-open-settings"
        class="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-surface hover:bg-panel-field"
        @click="handleOpenSettings"
      >
        <icon-lucide-settings class="size-3.5" />
        <template v-if="state.kind === 'needs-setup'">
          {{ piDialogs.providerGateSetupCta }}
        </template>
        <template v-else>
          {{ piDialogs.providerGateCredentialCta({ name: state.providerName }) }}
        </template>
      </button>
      <p class="text-xs text-muted">
        {{ piDialogs.providerGateHint }}
      </p>
    </div>
  </div>
</template>
