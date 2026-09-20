import { tryOnScopeDispose } from '@vueuse/core'

import { isTauri } from '@/app/tauri/env'

export function useNativeMenuEvents(handler: (id: string) => void): void {
  // Tauri-only：@tauri-apps/api 的 listen() 注册时即读
  // window.__TAURI_INTERNALS__.transformCallback，非 Tauri 形态（Electron/浏览器）
  // 该全局不存在，调用即抛 TypeError——门禁必须在调用点之前，不能靠「永不触发」。
  if (!isTauri()) return

  let disposed = false
  let unlisten: (() => void) | undefined

  void import('@tauri-apps/api/event').then(({ listen }) => {
    return listen<string>('menu-event', (event) => {
      handler(event.payload)
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
      return undefined
    })
  })

  tryOnScopeDispose(() => {
    disposed = true
    unlisten?.()
    unlisten = undefined
  })
}
