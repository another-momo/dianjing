import { useFileDialog } from '@vueuse/core'

import { IMAGE_FILE_ACCEPT, repairImageMime } from '@open-pencil/core/bytes'

import type { EditorStore } from '@/app/editor/active-store'
import { notifyAddImageFeedback } from '@/app/editor/clipboard/image-feedback'
import { useForkToolbar } from '@/app/i18n/fork'
import { toast } from '@/app/shell/ui'

/** 「添加图片」：系统文件选择器选图 → 放到当前视口中心；placeFiles 覆盖 raster + SVG，失败按原因分 toast 文案 */
export function useAddImage(store: EditorStore) {
  const toolbarText = useForkToolbar()
  const { open: openImagePicker, onChange } = useFileDialog({
    accept: IMAGE_FILE_ACCEPT,
    multiple: true
  })

  onChange((files) => {
    if (!files?.length) return
    const cx = (-store.state.panX + window.innerWidth / 2) / store.state.zoom
    const cy = (-store.state.panY + window.innerHeight / 2) / store.state.zoom
    void store
      .placeFiles(Array.from(files).map(repairImageMime), cx, cy)
      .then((result) => {
        notifyAddImageFeedback(result, toolbarText.value)
        return result.placed
      })
      .catch((error: unknown) => {
        console.error('Failed to place picked images', error)
        toast.error(toolbarText.value.addImageFailed)
      })
  })

  return { openImagePicker }
}
