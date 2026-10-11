import type { EditorStore } from '@/app/editor/active-store'

/**
 * 画布光标坐标跟踪器：写入 store，供「在光标处粘贴」类动作（画布菜单、剪贴板）读取。
 * collab 房间发布面随死域出清摘除，本体保留。
 */
export function useCanvasCollaborationAwareness(store: EditorStore) {
  function updateCursor(cx: number, cy: number) {
    store.state.cursorCanvasX = cx
    store.state.cursorCanvasY = cy
  }

  return { updateCursor }
}
