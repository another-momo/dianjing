/**
 * Sniff the mime type of encoded image bytes from their magic bytes.
 * Defaults to PNG when the signature is unrecognized.
 */
export function detectImageMime(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp'
  return 'image/png'
}

/**
 * 图片入口统一清单的单一真源（2026-09-19「添加图片配套」）：文件选择器
 * accept、拖拽/粘贴过滤、core 放置白名单全部从这里分发——改动只动本文件。
 *
 * 口径：canvaskit 0.41.1 wasm 解码面 = PNG/JPEG/WebP/GIF/BMP——AVIF 无解码器
 * 必失败（假支持，已摘）；SVG 走矢量化管线不收进光栅清单。accept 同时列
 * MIME 与扩展名：Windows 文件对话框按扩展名匹配更稳，macOS 按 UTI/MIME。
 */
export const RASTER_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp'
] as const

export const SVG_IMAGE_MIME_TYPE = 'image/svg+xml'

/** 文件选择器 accept 串（五入口统一） */
export const IMAGE_FILE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg'

/** 仅光栅的 accept 串（图片填充等 SVG 需先栅格化的入口用） */
export const RASTER_IMAGE_FILE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.bmp'

const EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: SVG_IMAGE_MIME_TYPE
}

export function isRasterImageMime(type: string): boolean {
  return (RASTER_IMAGE_MIME_TYPES as readonly string[]).includes(type)
}

/** SVG 判定：MIME 为准；系统给不出 MIME 时（Windows 常见）按扩展名兜底 */
export function isSVGImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  return (
    file.type === SVG_IMAGE_MIME_TYPE ||
    (file.type === '' && file.name.toLowerCase().endsWith('.svg'))
  )
}

export function isSupportedImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  return isRasterImageMime(file.type) || isSVGImageFile(file)
}

/** 部分系统给不出 MIME（Windows 上 .avif/.svg 常见）——按扩展名补齐，否则 core 按类型过滤时静默丢弃 */
export function repairImageMime(file: File): File {
  if (file.type) return file
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const mime = EXTENSION_TO_MIME[ext]
  return mime ? new File([file], file.name, { type: mime }) : file
}
