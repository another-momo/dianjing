/**
 * 图片放置失败的 toast 分文案判定（2026-09-19「添加图片配套」件 4）——
 * placeFiles 的机器可读原因 → toolbar 文案键。Toolbar 文件选择器与剪贴板
 * 粘贴两入口共用；纯函数，单测锚点。
 */

import type { PlaceFilesResult } from '@open-pencil/core/editor'

import { toast } from '@/app/shell/ui'

/** toolbar 文案域（i18n/fork locales）内的键 */
export type AddImageFeedbackKey =
  | 'addImageFailedEmpty'
  | 'addImageFailedUnsupported'
  | 'addImageFailedCorrupt'
  | 'addImageFailedEngineNotReady'
  | 'addImageFailed'

/** 全败取首条失败原因（error）；部分成功降级 warning；无失败信息返回 null（不提示） */
export function resolveAddImageFeedback(
  result: PlaceFilesResult
): { variant: 'error' | 'warning'; key: AddImageFeedbackKey } | null {
  if (result.failures.length === 0) return null
  const variant = result.placed > 0 ? 'warning' : 'error'
  const reason = result.failures[0]?.reason
  if (reason === 'empty') return { variant, key: 'addImageFailedEmpty' }
  if (reason === 'unsupported') return { variant, key: 'addImageFailedUnsupported' }
  if (reason === 'engine-not-ready') return { variant, key: 'addImageFailedEngineNotReady' }
  if (reason === 'corrupted') return { variant, key: 'addImageFailedCorrupt' }
  return { variant, key: 'addImageFailed' }
}

/** 判定 + toast 一步走（Toolbar 选择器与剪贴板粘贴两入口共用，jscpd 阈值 0 勿复制实现） */
export function notifyAddImageFeedback(
  result: PlaceFilesResult,
  messages: Record<AddImageFeedbackKey, string>
): void {
  const feedback = resolveAddImageFeedback(result)
  if (!feedback) return
  const message = messages[feedback.key]
  if (feedback.variant === 'warning') toast.warning(message)
  else toast.error(message)
}
