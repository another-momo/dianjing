<script setup lang="ts">
import { computed } from 'vue'
import IconImage from '~icons/lucide/image'

import {
  ToolbarRoot,
  useEditorCommands,
  useI18n,
  useToolbarState,
  useViewportKind
} from '@open-pencil/vue'

import { useEditorStore } from '@/app/editor/active-store'
import { toolIcons } from '@/app/editor/icons'
import { toolbarItems } from '@/app/editor/toolbar/layout'
import { TOOL_SHORTCUT_LABELS } from '@/app/editor/toolbar/shortcuts'
import { useForkToolbar } from '@/app/i18n/fork'
import { appPreferences } from '@/app/settings/preferences/store'
import { useActionToast } from '@/app/shell/toast/action'
import InsertIconButton from '@/components/icon-picker/InsertIconButton.vue'
import { useToolbarActions } from '@/components/toolbar/actions'
import DesktopToolbar from '@/components/toolbar/DesktopToolbar.vue'
import { useToolLabels } from '@/components/toolbar/labels'
import MobileToolbar from '@/components/toolbar/MobileToolbar.vue'
import type { ToolbarActionItem } from '@/components/toolbar/types'
import { useAddImage } from '@/components/toolbar/useAddImage'
import { useMenuUI } from '@/components/ui/menu/menu'

const store = useEditorStore()
const { isMobile } = useViewportKind()
const { getCommand } = useEditorCommands()
const { showActionToast } = useActionToast()
const { menu } = useI18n()

const toolLabels = useToolLabels()

const items = computed(() =>
  toolbarItems(appPreferences.value.toolbar, toolLabels.value, TOOL_SHORTCUT_LABELS)
)
const tools = computed(() =>
  items.value.flatMap((item) => (item.kind === 'tool' ? [item.tool] : []))
)
const actionItems = computed(() =>
  items.value.flatMap((item) => (item.kind === 'action' ? [item.action] : []))
)

const flyoutMenuCls = useMenuUI({ content: 'min-w-32' })
const toolbarUI = { flyoutContent: flyoutMenuCls.content }
const { openImagePicker } = useAddImage(store)
const toolbarText = useForkToolbar()
const addImageAction = computed<ToolbarActionItem>(() => ({
  icon: IconImage,
  label: toolbarText.value.addImage,
  action: () => openImagePicker()
}))
const { editActions, arrangeActions } = useToolbarActions({
  store,
  getCommand,
  menu,
  addImage: openImagePicker,
  addImageLabel: computed(() => toolbarText.value.addImage)
})

const { mobileCategory, slideDirection, hasPrev, hasNext, goPrev, goNext } = useToolbarState()

function onActionTap(item: ToolbarActionItem) {
  item.action()
  showActionToast(item.label)
}
</script>

<template>
  <ToolbarRoot v-slot="{ activeTool, flyoutSelections, actions }" :tools="tools">
    <DesktopToolbar
      v-if="!isMobile"
      :items="items"
      :active-tool="activeTool"
      :flyout-selections="flyoutSelections"
      :tool-icons="toolIcons"
      :tool-labels="toolLabels"
      :tool-shortcuts="TOOL_SHORTCUT_LABELS"
      :add-image="addImageAction"
      :ui="toolbarUI"
      @set-tool="actions.setTool"
    >
      <template #action="{ action }">
        <InsertIconButton v-if="action === 'insert-icon'" :ui="toolbarUI" />
      </template>
    </DesktopToolbar>

    <MobileToolbar
      v-else
      :tools="tools"
      :active-tool="activeTool"
      :flyout-selections="flyoutSelections"
      :tool-icons="toolIcons"
      :tool-labels="toolLabels"
      :tool-shortcuts="TOOL_SHORTCUT_LABELS"
      :ui="toolbarUI"
      :mobile-category="mobileCategory"
      :slide-direction="slideDirection"
      :has-prev="hasPrev"
      :has-next="hasNext"
      :edit-actions="editActions"
      :arrange-actions="arrangeActions"
      @set-tool="actions.setTool"
      @prev="goPrev"
      @next="goNext"
      @action="onActionTap"
    >
      <template #end>
        <template v-for="action in actionItems" :key="action">
          <InsertIconButton v-if="action === 'insert-icon'" mobile :ui="toolbarUI" />
        </template>
      </template>
    </MobileToolbar>
  </ToolbarRoot>
</template>
