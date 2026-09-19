/**
 * SVG → PNG 字节栅格化（浏览器 img + canvas）——图片填充等只能消费光栅字节
 * 的入口收 SVG 时的转换路径（2026-09-19 五入口 accept 清单一致化配套）。
 * 返回 null = 无法解析/无栅格上下文，调用方给失败反馈。
 */
export async function rasterizeSvgToPng(file: File): Promise<Uint8Array | null> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    const loaded = await new Promise<boolean>((resolve) => {
      image.onload = () => resolve(true)
      image.onerror = () => resolve(false)
      image.src = url
    })
    if (!loaded || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  } finally {
    URL.revokeObjectURL(url)
  }
}
