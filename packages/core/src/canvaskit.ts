/// <reference types="vite/client" />
import CanvasKitInit, { type CanvasKit } from 'canvaskit-wasm'

import { hasWindowGlobal } from './constants'
import { memoizeAsync } from './memoize-async'

export interface CanvasKitOptions {
  locateFile?: (file: string) => string
}

const defaultLocate = (file: string) => {
  // bun/node 运行时一律走 fs 读盘——不能用 hasWindowGlobal 判定：bun 测试里
  // window stub 会让活探返真，误走浏览器 fetch 分支挂起（render 批次 30s 超时实证）
  if ('Bun' in globalThis || !hasWindowGlobal()) {
    const ckPath = import.meta.resolve('canvaskit-wasm')
    const pathname = decodeURIComponent(new URL(file, ckPath).pathname)
    // Windows file URL 的 pathname 带前导斜杠（/D:/...），剥掉才能过 fs 读盘
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname
  }
  const base = 'env' in import.meta ? import.meta.env.BASE_URL : '/'
  const prefix = base === '/' ? '' : base.replace(/\/$/, '')
  return `${prefix}/${file}`
}

// in-flight 记忆化（语义见 memoize-async.ts）：EditorCanvas 同 tick 挂载
// scene/overlay 双 surface 并发调本函数，裸单例必开第二个 WASM 实例。
// options 仅首次调用生效（现役调用点均无参）。
export const getCanvasKit = memoizeAsync((options?: CanvasKitOptions) =>
  CanvasKitInit({ locateFile: options?.locateFile ?? defaultLocate })
)
