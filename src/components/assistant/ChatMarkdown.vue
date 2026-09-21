<script setup lang="ts">
import { computed } from 'vue'
import { Markdown } from 'vue-stream-markdown'

import { IS_BROWSER } from '@open-pencil/core/constants'

import { createMarkdownHardenOptions, markdownExtensions } from '@/app/shell/markdown/config'
import { markdownRenderKey, type MarkdownSurface } from '@/app/shell/markdown/state'
import { animationsEnabled } from '@/app/shell/motion'
import { resolvedAppTheme } from '@/app/shell/theme'
import InlineCode from '@/components/assistant/markdown/InlineCode.vue'
import { chatMarkdownTheme } from '@/theme/chat/markdown'

const {
  content,
  mode = 'static',
  surface = 'message'
} = defineProps<{
  content: string
  mode?: 'static' | 'streaming'
  surface?: MarkdownSurface
}>()

const isDark = computed(() => resolvedAppTheme.value === 'dark')
// 动画只放流式期：vue-stream-markdown 的 fade 类在 span 上永久滞留（不随 animationend
// 摘除），static 历史消息累积数万动画 span 会把 Blink 每帧动画服务打爆（楔死根因）
const animateWhileStreaming = computed(() => animationsEnabled.value && mode === 'streaming')
const ui = chatMarkdownTheme()
const markdownComponents = { code: InlineCode }
const hardenOptions = computed(() =>
  createMarkdownHardenOptions(IS_BROWSER ? window.location.origin : 'http://localhost/')
)
const renderKey = computed(() => markdownRenderKey({ mode, surface }))
</script>

<template>
  <div data-slot="chat-markdown" :class="ui.root()">
    <Markdown
      :key="renderKey"
      :components="markdownComponents"
      :content="content"
      :is-dark="isDark"
      :enable-animate="animateWhileStreaming"
      :mode="mode"
      :extensions="markdownExtensions"
      :harden-options="hardenOptions"
      :previewers="false"
      :controls="{ code: { download: false, fullscreen: false } }"
      :data-chat-markdown-mode="mode"
      :class="ui.markdown()"
    />
  </div>
</template>
