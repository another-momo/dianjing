<script setup lang="ts">
/**
 * 2026-09-27 sl-w2-locus-gate：感知三件套之二——状态行（§7.3）。
 *
 * 三态合一常驻行：
 *  - 常态化：显示当前落点页名（状态行常驻，不空时才显示）。
 *  - 进行中且落点页 ≠ 视图页：呼吸徽标 + 「正在第X页施工 · 跳转」链接
 *    （点击 = switchPage(engagedPageId) 把视图同步到落点页）。
 *  - 被动入口：当前页 ≠ 落点页时常驻显示「以当前页为施工页」链接
 *    （点击 = 确认切到当前页，PUT engaged=current）。
 *
 * 渲染位置 = header 行内嵌（ChatPanel session bar），非独立行——根 div 无
 * 外缘 padding（避免双重 padding），被动入口与跳转同款文本链样式，统一
 * header 内嵌件语言。
 *
 * 显式 emit，不直接走 fetch / store — ChatPanel 装订本组件时三 handler
 * 齐备；本组件只在 props 输入下做派生渲染。
 */
import { computed } from 'vue'

import { useForkLocus } from '@/app/i18n/fork'

const { state, disabled = false } = defineProps<{
  /**
   * 状态行三件事实（render 派发）：
   *  - engagedPageName / engagedPageId：当前落点（null = 真首跑未写过落点，状态行不显示「常态化」）。
   *  - viewPageId / viewPageName：当前视图页。
   *  - runActive：chat.status ∈ {submitted, streaming}（run 进行中）。
   */
  state: {
    engagedPageId: string | null
    engagedPageName: string | null
    viewPageId: string
    viewPageName: string
    runActive: boolean
  }
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 状态行「跳转过去」链接：把视图切到落点页（仅用户行为，不改落点） */
  jump: []
  /** 被动入口「以当前页为施工页」按钮：把落点切到当前页（PUT engaged=view） */
  setCurrent: []
}>()

const locusText = useForkLocus()

const locusDiffersFromView = computed(
  () => state.engagedPageId !== null && state.engagedPageId !== state.viewPageId
)

const showRunBuilding = computed(
  () => state.runActive && locusDiffersFromView.value && state.engagedPageName !== null
)

const showSetCurrentButton = computed(
  () => state.engagedPageId !== null && state.engagedPageId !== state.viewPageId
)

const showLocusName = computed(() => state.engagedPageName !== null && state.engagedPageName !== '')

function handleJump() {
  if (disabled) return
  emit('jump')
}

function handleSetCurrent() {
  if (disabled) return
  emit('setCurrent')
}
</script>

<template>
  <div
    v-if="showLocusName || showRunBuilding || showSetCurrentButton"
    data-test-id="locus-status-row"
    class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted"
  >
    <!-- 常态化：当前落点页名（run 不在途 + 视图同步到落点页时显示） -->
    <span
      v-if="showLocusName && !showRunBuilding"
      data-test-id="locus-status-name"
      class="inline-flex items-center gap-1"
    >
      <icon-lucide-pin class="size-3 shrink-0" />
      <span>{{ state.engagedPageName }}</span>
    </span>

    <!-- run 进行中 + 落点 ≠ 视图：呼吸徽标 + 跳转 -->
    <span
      v-if="showRunBuilding"
      data-test-id="locus-status-building"
      class="inline-flex items-center gap-1 text-accent"
    >
      <span class="size-2 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden="true" />
      <span>{{ locusText.locusStatusBuilding({ page: state.engagedPageName ?? '' }) }}</span>
      <button
        type="button"
        :disabled="disabled"
        data-test-id="locus-status-jump"
        class="rounded px-1 text-[11px] text-accent underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
        @click="handleJump"
      >
        {{ locusText.locusStatusJump }}
      </button>
    </span>

    <!-- 被动入口：当前页 ≠ 落点页时常驻显示；与跳转同款文本链样式（header 内嵌件统一语言） -->
    <button
      v-if="showSetCurrentButton"
      type="button"
      :disabled="disabled"
      data-test-id="locus-status-set-current"
      class="rounded px-1 text-[11px] text-accent underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
      @click="handleSetCurrent"
    >
      {{ locusText.locusSetCurrentPage({ page: state.viewPageName }) }}
    </button>
  </div>
</template>
