import { isElectron } from '@/app/shell/electron'
import { prepareForClose } from '@/app/tabs'

/** Shared approval so the window close handler and the Quit item cannot prompt twice. */
export function createExitApproval(confirmDocuments: () => Promise<boolean>) {
  let approved = false
  let confirmation: Promise<boolean> | null = null

  return {
    isApproved: () => approved,
    confirm: async (): Promise<boolean> => {
      if (approved) return true
      confirmation ??= confirmDocuments()
        .then((agreed) => {
          if (agreed) approved = true
          return agreed
        })
        .finally(() => {
          confirmation = null
        })
      return confirmation
    }
  }
}

const approval = createExitApproval(prepareForClose)

/** True once every open document agreed to close, so later requests skip the prompt. */
export function isExitApproved(): boolean {
  return approval.isApproved()
}

export function confirmAppExit(): Promise<boolean> {
  return approval.confirm()
}

/** Shared by the native Quit item and the platform exit request. */
export async function requestAppExit(): Promise<void> {
  if (!(await confirmAppExit())) return
  // A-2 关窗接线补全（2026-09-22）——Electron 分支走 loopback HTTP 端点
  // /__dianjing/quit 由 main 侧调 app.quit()（同时触发我们的 close 网关）。
  // 旧实现统一 import Tauri 专属 @tauri-apps/plugin-process 在 Electron 上
  // 静默抛错（void requestAppExit() 吞掉 rejection）——批准后只埋「意外后门」：
  // approved 已置 true，下一次点 ✕ 反而能关。Electron 与 Tauri 分流：
  if (isElectron()) {
    const { requestElectronQuit } = await import('@/app/shell/electron-file-channel')
    await requestElectronQuit()
    return
  }
  const { exit } = await import('@tauri-apps/plugin-process')
  await exit(0)
}
