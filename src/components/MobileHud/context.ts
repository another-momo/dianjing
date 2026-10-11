import { computed, inject, provide, proxyRefs } from 'vue'
import type { InjectionKey, ShallowUnwrapRef } from 'vue'
import IconFilePlus from '~icons/lucide/file-plus'
import IconFolderOpen from '~icons/lucide/folder-open'
import IconImageDown from '~icons/lucide/image-down'
import IconSave from '~icons/lucide/save'
import IconZoomIn from '~icons/lucide/zoom-in'

import { useEditorCommands } from '@open-pencil/vue'

import { useEditorStore } from '@/app/editor/active-store'
import { toolIcons } from '@/app/editor/icons'
import { openFileDialog } from '@/app/shell/menu/use'
import type { ToolbarActionItem } from '@/components/toolbar/types'

type MenuAction = ToolbarActionItem

function createMobileHudContext() {
  const store = useEditorStore()
  const { getCommand } = useEditorCommands()

  const activeToolIcon = computed(() => toolIcons[store.state.activeTool])
  const actionToast = computed(() => store.state.actionToast)

  const menuItems: MenuAction[] = [
    {
      icon: IconFilePlus,
      label: 'New',
      action: () => void import('@/app/tabs').then((m) => m.createTab())
    },
    { icon: IconFolderOpen, label: 'Open…', action: () => void openFileDialog() },
    { icon: IconSave, label: 'Save', action: () => void store.saveFigFile() },
    { icon: IconImageDown, label: 'Export…', action: () => void store.exportSelection(1, 'png') },
    { icon: IconZoomIn, label: 'Zoom to fit', action: () => getCommand('view.zoomFit').run() }
  ]

  function undo() {
    getCommand('edit.undo').run()
  }

  function redo() {
    getCommand('edit.redo').run()
  }

  return {
    store,
    activeToolIcon,
    actionToast,
    menuItems,
    undo,
    redo
  }
}

export type MobileHudContext = ShallowUnwrapRef<ReturnType<typeof createMobileHudContext>>

const MOBILE_HUD_KEY: InjectionKey<MobileHudContext> = Symbol('MobileHudContext')

export function provideMobileHud() {
  const ctx = proxyRefs(createMobileHudContext())
  provide(MOBILE_HUD_KEY, ctx)
  return ctx
}

export function useMobileHudContext(): MobileHudContext {
  const ctx = inject(MOBILE_HUD_KEY)
  if (!ctx) throw new Error('Mobile HUD controls must be used within MobileHud')
  return ctx
}
