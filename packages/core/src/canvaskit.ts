/// <reference types="vite/client" />
import CanvasKitInit, { type CanvasKit } from 'canvaskit-wasm'

import { hasWindowGlobal } from './constants'

let instance: CanvasKit | null = null

export interface CanvasKitOptions {
  locateFile?: (file: string) => string
}

export async function getCanvasKit(options?: CanvasKitOptions): Promise<CanvasKit> {
  if (instance) return instance

  const defaultLocate = (file: string) => {
    if (!hasWindowGlobal()) {
      const ckPath = import.meta.resolve('canvaskit-wasm')
      const pathname = decodeURIComponent(new URL(file, ckPath).pathname)
      // Windows file URL 的 pathname 带前导斜杠（/D:/...），剥掉才能过 fs 读盘
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname
    }
    const base = 'env' in import.meta ? import.meta.env.BASE_URL : '/'
    const prefix = base === '/' ? '' : base.replace(/\/$/, '')
    return `${prefix}/${file}`
  }

  instance = await CanvasKitInit({
    locateFile: options?.locateFile ?? defaultLocate
  })

  return instance
}
