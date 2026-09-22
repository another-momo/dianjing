import type { Image as CKImage } from 'canvaskit-wasm'

import { ResourceCache } from '#core/cache/resource'

// Bounded LRU for CanvasKit decoded image handles (CanvasKit Image).
// Bounds growth at MAX_IMAGE_CACHE_BYTES — overflow evicts the least-recently
// used entry, calling img.delete() on its way out. Normal workloads never
// touch the budget, so this caps a slow leak rather than trading hits for
// churn.
export const MAX_IMAGE_CACHE_BYTES = 512 * 1024 * 1024

const RGBA_BYTES_PER_PIXEL = 4
const MIPMAP_OVERHEAD_NUM = 4
const MIPMAP_OVERHEAD_DEN = 3

function imageWeight(img: CKImage): number {
  // Each entry is the mipmap copy produced by makeCopyWithDefaultMipmaps;
  // mipmap chain adds roughly 1/3 over the base RGBA footprint.
  return Math.ceil(
    (img.width() * img.height() * RGBA_BYTES_PER_PIXEL * MIPMAP_OVERHEAD_NUM) / MIPMAP_OVERHEAD_DEN
  )
}

export class ImageCache extends ResourceCache<string, CKImage> {
  constructor(maxBytes = MAX_IMAGE_CACHE_BYTES) {
    super({
      maxWeight: maxBytes,
      weight: imageWeight,
      dispose: (img) => img.delete()
    })
  }
}
