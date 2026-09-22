<script setup lang="ts">
import { onScopeDispose, ref } from 'vue'

import { getRendererDeadState, subscribeRendererDeadState } from '@open-pencil/core/canvas'

import AppBanner from '@/components/ui/feedback/AppBanner.vue'

// 直读 core 模块级闸而非画布上下文：本组件挂在 WorkspaceView 顶栏行，
// 位于任何 provide 链之外；闸本身是 framework-free 的，订阅即镜像。
const rendererDead = ref(getRendererDeadState().dead)
const unsubscribe = subscribeRendererDeadState((snapshot) => {
  rendererDead.value = snapshot.dead
})
onScopeDispose(unsubscribe)
</script>

<template>
  <AppBanner v-if="rendererDead">
    <span class="font-medium">{{ $t('rendering.rendererCrashed') }}</span>
    <span class="ml-2 opacity-80">{{ $t('rendering.rendererCrashedHint') }}</span>
  </AppBanner>
</template>
