import { useEventListener } from '@vueuse/core'
import { onMounted, onScopeDispose } from 'vue'

import { confirmAppExit, isExitApproved } from '@/app/document/close/exit'
import { notificationMessages } from '@/app/i18n/notifications'
import { isElectron } from '@/app/shell/electron'
import { toast } from '@/app/shell/ui'
import { allTabs } from '@/app/tabs'
import { IS_TAURI } from '@/constants'

declare global {
  interface Window {
    /** Electron main 侧经 executeJavaScript 调用的关窗确认入口（A-2 接线）。 */
    __dianjingHandleCloseRequest?: () => Promise<boolean>
  }
}

// A-2 关窗接线补全（2026-09-22）——三段可纯函数化的小 helper 暴露给单测。
// 1. handleCloseRequestImpl：审批已设则短路返 true，否则走 confirmDocuments；
// 2. matchesReloadKey：dirty + (F5 | Ctrl/Cmd+R[无 Alt]) 才返回 true，修饰键
//    不区分大小写、Shift 无关（硬刷新也属「重载」语义，需同套 dirty gate）；
// 3. isMacPlatform：抽出来便于测试 stub 平台判定。
// 不抽会让 Vue lifecycle 上下文里的关键分支单测无法触及；抽到这里把分支逻辑
// 与挂载时序解耦，onMounted 仅剩 wiring
export function handleCloseRequestImpl(
  isApproved: () => boolean,
  confirm: () => Promise<boolean>
): Promise<boolean> {
  if (isApproved()) return Promise.resolve(true)
  return confirm()
}

export function matchesReloadKey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>,
  isMac: boolean
): boolean {
  const modifierHeld = isMac ? event.metaKey : event.ctrlKey
  const isF5 = event.key === 'F5'
  const isCtrlR = modifierHeld && !event.altKey && (event.key === 'r' || event.key === 'R')
  return isF5 || isCtrlR
}

export function isMacPlatform(platform: string): boolean {
  return platform.toLowerCase().includes('mac')
}

export function useDocumentCloseProtection() {
  let closing = false
  let disposed = false
  const cleanup: Array<() => void> = []

  useEventListener(window, 'beforeunload', (event) => {
    if (isExitApproved() || !allTabs.value.some((tab) => tab.isDirty)) return
    event.preventDefault()
    event.returnValue = ''
  })

  async function requestClose(close: () => Promise<void>) {
    if (closing) return
    closing = true
    try {
      if (!(await confirmAppExit())) return
      await close()
    } catch (error) {
      toast.error(
        notificationMessages.get().operationFailed({
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      closing = false
    }
  }

  function registerCleanup(unsubscribe: () => void) {
    if (disposed) unsubscribe()
    else cleanup.push(unsubscribe)
  }

  onMounted(async () => {
    if (IS_TAURI) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      if (disposed) return
      const window = getCurrentWindow()
      await window
        .onCloseRequested((event) => {
          // Always intercept: Tauri destroys the window implicitly when a handler returns
          // without preventing, which would bypass the prompt after approval.
          event.preventDefault()
          if (isExitApproved()) return
          void requestClose(() => window.destroy())
        })
        .then(registerCleanup)
      return
    }

    // A-2 关窗接线补全（2026-09-22）：Electron 形态下渲染侧出口——
    //   1. 在 window 上注册 __dianjingHandleCloseRequest 给 main 端通过
    //      webContents.executeJavaScript 调用——main 的 BrowserWindow.close
    //      事件先 preventDefault 再 invoke 该 fn，fn 跑 confirmAppExit——
    //      approval 单例与本文件其它入口（关 tab、菜单 Quit）共享，main 再
    //      调 window.destroy() 完成真正关闭。
    //   2. 监听 keydown 拦截 Ctrl+R / Cmd+R / F5（含 Shift 修饰键的硬刷新）：
    //      dirty 文档先走 confirmAppExit，批准后 isExitApproved() 把渲染侧
    //      beforeunload 闸放空，window.location.reload() 正常 fire 重载。
    // 不读 Electron 端点、直接走 runtime-globals 已烘焙的
    // __DIANJING_ELECTRON__（与 isElectron() 同源）——本函数挂载即生效，菜单
    // Quit 不依赖注册时机。卸载由 onScopeDispose cleanup 拆事件 + 删全局
    if (!isElectron()) return

    const handleCloseRequest = (): Promise<boolean> =>
      handleCloseRequestImpl(isExitApproved, confirmAppExit)

    window.__dianjingHandleCloseRequest = handleCloseRequest
    cleanup.push(() => {
      if (window.__dianjingHandleCloseRequest === handleCloseRequest) {
        delete window.__dianjingHandleCloseRequest
      }
    })

    // re-entrancy 守卫：用户连按 Ctrl+R / F5 时 confirmAppExit 串行化已有
    // （approval 单例 promise 去重），这里再加一道 keydown 拦截——prompt 期间
    // 重复触发 confirmAppExit 只返同一 promise，没有副作用，但避免对未达 dirty
    // gate 的普通刷新再装一发
    let reloading = false
    const isMac = isMacPlatform(navigator.platform)
    const handleReloadKey = (event: KeyboardEvent): void => {
      if (reloading) return
      if (!allTabs.value.some((tab) => tab.isDirty)) return
      // F5（含 Ctrl+F5 硬刷）或 Ctrl+R/Cmd+R（含 Shift+Ctrl+R 硬刷）——
      // 关注 reload 意图本身，不区分软硬刷新；其它修饰键（Alt 等）不拦
      if (!matchesReloadKey(event, isMac)) return
      event.preventDefault()
      reloading = true
      void (async () => {
        try {
          if (await confirmAppExit()) {
            window.location.reload()
          }
        } finally {
          reloading = false
        }
      })()
    }
    window.addEventListener('keydown', handleReloadKey)
    cleanup.push(() => window.removeEventListener('keydown', handleReloadKey))
  })

  onScopeDispose(() => {
    disposed = true
    for (const unsubscribe of cleanup) unsubscribe()
  })
}
