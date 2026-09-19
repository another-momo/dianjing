import { useEventListener } from '@vueuse/core'

import { extractImageFilesFromClipboard } from '@open-pencil/vue'

import type { EditorStore } from '@/app/editor/active-store'
import { notifyAddImageFeedback } from '@/app/editor/clipboard/image-feedback'
import { getInMemoryClipboardHTML } from '@/app/editor/clipboard/memory'
import { pasteClipboardHTML } from '@/app/editor/clipboard/paste'
import { browserSystemClipboard } from '@/app/editor/clipboard/system/browser'
import { tauriSystemClipboard } from '@/app/editor/clipboard/system/tauri'
import type { SystemClipboard } from '@/app/editor/clipboard/system/types'
import { useForkToolbar } from '@/app/i18n/fork'
import { hasDocumentTextSelection, isEditing } from '@/app/shell/keyboard/focus'
import { toast } from '@/app/shell/ui'
import { isTauri } from '@/app/tauri/env'

function cursorPosition(store: EditorStore) {
  const { cursorCanvasX: ccx, cursorCanvasY: ccy } = store.state
  return ccx != null && ccy != null ? { x: ccx, y: ccy } : undefined
}

export async function copyAndDeleteSelection(
  store: EditorStore,
  clipboard: SystemClipboard = browserSystemClipboard
): Promise<boolean> {
  try {
    const selectedIds = new Set(store.state.selectedIds)
    if (!(await clipboard.copy(store)) || !selectionMatches(store, selectedIds)) return false
    store.deleteSelected()
    return true
  } catch (error) {
    console.warn('Browser clipboard cut failed', error)
    return false
  }
}

function selectionMatches(store: EditorStore, selectedIds: Set<string>): boolean {
  return (
    selectedIds.size === store.state.selectedIds.size &&
    [...selectedIds].every((id) => store.state.selectedIds.has(id))
  )
}

export function bindEditorClipboard(store: EditorStore) {
  const toolbarText = useForkToolbar()

  useEventListener(window, 'copy', (e: ClipboardEvent) => {
    if (isEditing(e) || hasDocumentTextSelection()) return
    e.preventDefault()
    if (isTauri()) {
      void tauriSystemClipboard.copy(store)
      return
    }
    void browserSystemClipboard.copy(store)
  })

  useEventListener(window, 'cut', (e: ClipboardEvent) => {
    if (isEditing(e)) return
    e.preventDefault()
    if (isTauri()) {
      const selectedIds = new Set(store.state.selectedIds)
      void tauriSystemClipboard.copy(store).then((copied) => {
        if (copied && selectionMatches(store, selectedIds)) store.deleteSelected()
        return undefined
      })
      return
    }
    void copyAndDeleteSelection(store)
  })

  useEventListener(window, 'paste', (e: ClipboardEvent) => {
    if (isEditing(e)) return
    e.preventDefault()

    const cursorPos = cursorPosition(store)

    const imageFiles = extractImageFilesFromClipboard(e)
    if (imageFiles.length) {
      const cx = cursorPos?.x ?? (-store.state.panX + window.innerWidth / 2) / store.state.zoom
      const cy = cursorPos?.y ?? (-store.state.panY + window.innerHeight / 2) / store.state.zoom
      void store
        .placeImageFiles(imageFiles, cx, cy)
        .then((result) => {
          notifyAddImageFeedback(result, toolbarText.value)
          return undefined
        })
        .catch((error: unknown) => {
          console.error('Failed to place pasted images', error)
          toast.error(toolbarText.value.addImageFailed)
        })
      return
    }

    const html = e.clipboardData?.getData('text/html') ?? ''
    if (html) {
      void pasteClipboardHTML(store, html, cursorPos)
      return
    }

    if (isTauri()) {
      void tauriSystemClipboard.paste(store, cursorPos)
      return
    }

    const memoryHTML = getInMemoryClipboardHTML()
    if (memoryHTML) {
      void pasteClipboardHTML(store, memoryHTML, cursorPos)
    }
  })
}
