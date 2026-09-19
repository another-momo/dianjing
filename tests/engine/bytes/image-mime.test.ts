import { describe, expect, test } from 'bun:test'

import {
  IMAGE_FILE_ACCEPT,
  isRasterImageMime,
  isSupportedImageFile,
  isSVGImageFile,
  RASTER_IMAGE_MIME_TYPES,
  repairImageMime,
  SVG_IMAGE_MIME_TYPE
} from '@open-pencil/core/bytes'

// 2026-09-19 件 3/4：五入口 accept 清单的单一真源——光栅面 = canvaskit
// 可解码面（AVIF 无解码器摘除，BMP 补入），SVG 走矢量化管线另列
describe('image MIME allowlist', () => {
  test('raster list matches the canvaskit decodable set (no AVIF, BMP in)', () => {
    expect([...RASTER_IMAGE_MIME_TYPES].sort()).toEqual(
      ['image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'].sort()
    )
  })

  test('accept string covers every raster MIME plus SVG and extension fallbacks', () => {
    for (const mime of RASTER_IMAGE_MIME_TYPES) expect(IMAGE_FILE_ACCEPT).toContain(mime)
    expect(IMAGE_FILE_ACCEPT).toContain(SVG_IMAGE_MIME_TYPE)
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']) {
      expect(IMAGE_FILE_ACCEPT).toContain(ext)
    }
    expect(IMAGE_FILE_ACCEPT).not.toContain('avif')
  })

  test('repairImageMime fills missing MIME from extension and keeps declared types', () => {
    expect(repairImageMime(new File(['<svg/>'], 'icon.svg')).type).toBe('image/svg+xml')
    expect(repairImageMime(new File(['x'], 'photo.BMP')).type).toBe('image/bmp')
    const typed = new File(['x'], 'a.png', { type: 'image/png' })
    expect(repairImageMime(typed)).toBe(typed)
    expect(repairImageMime(new File(['x'], 'data.bin')).type).toBe('')
  })

  test('isSupportedImageFile accepts raster + SVG, rejects AVIF and other types', () => {
    expect(isSupportedImageFile({ name: 'a.png', type: 'image/png' })).toBe(true)
    expect(isSupportedImageFile({ name: 'a.svg', type: 'image/svg+xml' })).toBe(true)
    expect(isSupportedImageFile({ name: 'a.svg', type: '' })).toBe(true)
    expect(isSupportedImageFile({ name: 'a.avif', type: 'image/avif' })).toBe(false)
    expect(isSupportedImageFile({ name: 'a.txt', type: 'text/plain' })).toBe(false)
    expect(isRasterImageMime('image/avif')).toBe(false)
    expect(isSVGImageFile({ name: 'x.png', type: '' })).toBe(false)
  })
})
