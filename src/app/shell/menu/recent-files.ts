import { watch } from 'vue'

import { recentLocalFilePaths } from '@/app/recent-files'
import { isElectron } from '@/app/shell/electron'
import { syncElectronRecentFiles } from '@/app/shell/electron-file-channel'
import { isTauri } from '@/app/tauri/env'

export const OPEN_RECENT_EVENT_PREFIX = 'open-recent:'

export async function syncRecentFilesMenu(): Promise<void> {
  // electron-desktop P1 文件通道（2026-09-20）：Electron 形态下推
  // recentLocalFilePaths 给 main → app.addRecentDocument（OS 级最近文档）
  // 注意：main 侧不构造 Menu.setApplicationMenu——sandbox + contextIsolation
  // 无 preload 通道，菜单点击无法回传渲染层（无 ipcRenderer.on），搭原生菜单
  // 是单向死代码。OS 级最近文档足够覆盖任务4「让用户从 dock/jump-list 跳转
  // 最近文件」诉求；菜单点击由渲染层既有快捷键 + 命令面板承担。
  if (isElectron()) {
    await syncElectronRecentFiles(recentLocalFilePaths.value)
    return
  }
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_recent_files', { paths: recentLocalFilePaths.value })
}

export function watchRecentFilesMenu(): () => void {
  return watch(
    recentLocalFilePaths,
    () => {
      void syncRecentFilesMenu().catch((error) => {
        console.warn('[Recent files] Failed to update the native menu', error)
      })
    },
    { immediate: true }
  )
}
