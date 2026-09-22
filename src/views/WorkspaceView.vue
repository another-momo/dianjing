<script setup lang="ts">
import { useEventListener, useUrlSearchParams } from '@vueuse/core'
import { computed, onMounted, onUnmounted, provide, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { startMCPRuntime, stopMCPRuntime } from '@/app/bridge/runtime'
import { exposeCollaborationActions } from '@/app/browser-bridge'
import { COLLAB_KEY, useCollab } from '@/app/collab/use'
import type { PendingOpenFile } from '@/app/document/io/pending-open'
import { openPendingFiles } from '@/app/document/io/pending-open'
import { openWebLinkFromLocation, withoutWebLinkParams } from '@/app/document/io/web-link'
import { focusNodesByName } from '@/app/editor/selection/focus'
import { notificationMessages } from '@/app/i18n/notifications'
import { getElectronPlatform, isElectron } from '@/app/shell/electron'
import { useKeyboard } from '@/app/shell/keyboard/use'
import { useEditorMenu } from '@/app/shell/menu/use'
import { toast } from '@/app/shell/ui'
import {
  activeTab,
  createDocumentInCurrentTab,
  createHomeTab,
  createTab,
  getActiveStore,
  getTabsSnapshot
} from '@/app/tabs'
import { isTauri } from '@/app/tauri/env'
import ColorSpaceBanner from '@/components/canvas/ColorSpaceBanner.vue'
import RendererDeadBanner from '@/components/canvas/RendererDeadBanner.vue'
import CommandPalette from '@/components/commands/CommandPalette.vue'
import EditorWorkspace from '@/components/editor/EditorWorkspace.vue'
import FileApiBanner from '@/components/FileApiBanner.vue'
import FontStatusBanner from '@/components/font-status/FontStatusBanner.vue'
import HomeWorkspace from '@/components/home/HomeWorkspace.vue'
import RenameSelectionDialog from '@/components/selection/RenameSelectionDialog.vue'
import TabBar from '@/components/TabBar.vue'
import { IS_BROWSER } from '@/constants'

const route = useRoute()
const router = useRouter()
const params = useUrlSearchParams('history')
const shouldCreateHome =
  route.path === '/' && !('test' in params) && (isTauri() || 'recent-files' in params)
let firstTab = activeTab.value
if (!firstTab) firstTab = shouldCreateHome ? createHomeTab() : createTab()

useKeyboard()
useEditorMenu()

const collab = useCollab(getActiveStore)
provide(COLLAB_KEY, collab)
exposeCollaborationActions(collab)

useEventListener(
  document,
  'wheel',
  (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault()
  },
  { passive: false }
)

const fileAssociationCleanup = ref<(() => void) | null>(null)

// shell-polish A1：Electron 形态下 titleBarOverlay（46px × 3 按钮 ≈ 138px）盖
// 在页面顶部，FontStatusBanner + TabBar 两个顶部通栏需要右侧预留等宽——
// 把宽度挂在 editor-root 的内联 style 上，下游组件读 var(--window-controls-width)
// 即自动避开；浏览器形态（isElectron()=false）走空对象，padding-right 回退
// 默认值 0px，行为不变。138px 是设计默认值，L3 验收时按真机校准。
// mac 三键避让（2026-09-20）：macOS titleBarStyle: 'hidden' 模式下 traffic-light
// 三键压在页面左上角首个 tab 位置——额外给左侧留 ~78px（traffic light 标准占
// 位）作为 --traffic-light-width。Windows + Linux 走 0px 不留空，与右侧
// 预留共存不冲突（padding-left/right 方向独立）。平台由 main 注
// __DIANJING_PLATFORM__ 传入，非 Electron 形态 isElectron() 早返走空对象
const MAC_TRAFFIC_LIGHT_WIDTH = '78px'
const electronShellStyle = computed((): Record<string, string> => {
  if (!isElectron()) return {}
  const platform = getElectronPlatform()
  return {
    '--window-controls-width': '138px',
    '--traffic-light-width': platform === 'darwin' ? MAC_TRAFFIC_LIGHT_WIDTH : '0px'
  }
})

/**
 * A drain that fails wholesale — the `take_pending_open` invoke, the event binding —
 * leaves the user staring at an app that ignored their double-click or their link.
 * Per-entry failures are already toasted inside `openPendingFiles`; this is the outer
 * net, and it must be visible, not console-only.
 */
function reportOpenFailure(error: unknown): void {
  console.error('[Open With]', error)
  toast.error(
    notificationMessages.get().openQueuedFilesFailed({
      error: error instanceof Error ? error.message : String(error)
    })
  )
}

function openDocumentPaths(): string[] {
  return getTabsSnapshot()
    .map((tab) => tab.store.getSourceIdentity().path)
    .filter((path): path is string => path !== null)
}

/**
 * Drops the link params through the router, not through `history` directly: the router
 * keeps its own copy of the current URL in `history.state` and re-applies it on the next
 * navigation, which would put `file` and `node` back into the entry. Route and hash are
 * preserved, so the link works on `/`, `/share/:id` and `/demo` alike.
 */
function stripWebLinkParams(): void {
  void router.replace({
    path: route.path,
    query: withoutWebLinkParams(route.query),
    hash: route.hash
  })
}

/** The action both link handlers take; see `focusNodesByName`. */
function selectNodeByName(name: string): boolean {
  return focusNodesByName(getActiveStore(), name)
}

async function openPendingAssociatedFiles(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  const files = await invoke<PendingOpenFile[]>('take_pending_open')
  await openPendingFiles(files, {
    openPaths: openDocumentPaths,
    selectByName: selectNodeByName,
    notify: toast.info
  })
}

// A deep link can block this drain on a modal file picker, so a second event must
// queue behind the first: overlapping drains would prompt twice for the same file.
let pendingOpenDrain: Promise<void> = Promise.resolve()

function drainPendingOpens(): Promise<void> {
  pendingOpenDrain = pendingOpenDrain.then(openPendingAssociatedFiles).catch(reportOpenFailure)
  return pendingOpenDrain
}

async function bindAssociatedFileOpen(): Promise<void> {
  if (!isTauri()) return
  const { listen } = await import('@tauri-apps/api/event')
  fileAssociationCleanup.value = await listen('open-associated-files', () => {
    void drainPendingOpens()
  })
  await drainPendingOpens()
}

onMounted(async () => {
  await startMCPRuntime(getActiveStore)

  try {
    await bindAssociatedFileOpen()
  } catch (error) {
    reportOpenFailure(error)
  }

  // The browser twin of the deep link: the desktop build takes its links through the
  // deep-link plugin above, so only a real browser reads them off the address bar.
  if (IS_BROWSER && !isTauri()) {
    try {
      await openWebLinkFromLocation(window.location.search, stripWebLinkParams, {
        selectByName: selectNodeByName,
        notify: (message, level) => (level === 'error' ? toast.error : toast.info)(message)
      })
    } catch (error) {
      console.error('[Web link]', error)
    }
  }
})

onUnmounted(() => {
  void stopMCPRuntime()
  fileAssociationCleanup.value?.()
})
</script>

<template>
  <div
    data-test-id="editor-root"
    class="flex h-screen w-screen flex-col"
    :style="electronShellStyle"
  >
    <FileApiBanner />
    <ColorSpaceBanner />
    <RendererDeadBanner />
    <FontStatusBanner />
    <RenameSelectionDialog />
    <CommandPalette />
    <TabBar />
    <HomeWorkspace v-show="activeTab?.kind === 'home'" @new-document="createDocumentInCurrentTab" />
    <EditorWorkspace v-if="activeTab?.kind !== 'home'" />
  </div>
</template>
