import type { EditorState } from '@open-pencil/core/editor'
import { filesMessages } from '@open-pencil/vue'

import { downloadBlob } from '@/app/document/io/browser'
import { documentNameFromFigPath } from '@/app/document/io/names'
import { chooseBrowserFigSaveHandle, chooseTauriFigSavePath } from '@/app/document/io/save-targets'
import type { DocumentSourceAccess } from '@/app/document/io/types'
import { createDocumentWriter } from '@/app/document/io/write'
import { isElectron } from '@/app/shell/electron'
import { chooseElectronSavePath } from '@/app/shell/electron-file-channel'
import { IS_TAURI } from '@/constants'

type SaveDocumentState = EditorState & { documentName: string }

type SaveActionsOptions = Omit<DocumentSourceAccess, 'getSavedVersion'> & {
  state: SaveDocumentState
  buildFigFile: () => Uint8Array | Promise<Uint8Array>
  startWatchingFile: () => void
  onWriteSuccess?: (version: number) => void | Promise<void>
  onDownloadSuccess?: (version: number) => void | Promise<void>
}

export function createSaveActions({
  state,
  buildFigFile,
  getFilePath,
  setFilePath,
  getFileHandle,
  setFileHandle,
  getDownloadName,
  setDownloadName,
  getStorageBinding,
  setStorageBinding,
  setSourceIdentity,
  setSavedVersion,
  setLastWriteTime,
  startWatchingFile,
  onWriteSuccess,
  onDownloadSuccess
}: SaveActionsOptions) {
  const writeFile = createDocumentWriter({
    state,
    getFilePath,
    getFileHandle,
    getStorageBinding,
    setSavedVersion,
    setLastWriteTime,
    onWriteSuccess
  })

  async function buildVersionedFigFile() {
    const version = state.sceneVersion
    return { data: await buildFigFile(), version }
  }

  async function saveFigFile() {
    const filePath = getFilePath()
    const fileHandle = getFileHandle()
    const storageBinding = getStorageBinding()
    const downloadName = getDownloadName()
    if (storageBinding || filePath || fileHandle) {
      const { data, version } = await buildVersionedFigFile()
      const wrote = await writeFile(data, version)
      if (wrote && !storageBinding) setSourceIdentity({ handle: fileHandle, path: filePath })
      return wrote
    }
    if (downloadName) {
      const { data, version } = await buildVersionedFigFile()
      downloadBlob(new Uint8Array(data), downloadName, 'application/octet-stream')
      await onDownloadSuccess?.(version)
      return true
    }
    return saveFigFileAs()
  }

  async function saveFigFileAs() {
    const { data, version } = await buildVersionedFigFile()

    // 「按绝对路径保存」的共享收尾——Tauri 与 Electron 分支同形（jscpd 克隆门禁
    // 要求抽 helper）：绑定路径 → 写盘 → 成功则记 source identity + 起外部改动监听
    async function saveToPath(path: string): Promise<boolean> {
      setStorageBinding(null)
      setFilePath(path)
      setFileHandle(null)
      state.documentName = documentNameFromFigPath(path)
      const wrote = await writeFile(data, version)
      if (wrote) setSourceIdentity({ handle: null, path })
      startWatchingFile()
      return wrote
    }

    if (IS_TAURI) {
      const path = await chooseTauriFigSavePath()
      if (!path) return false
      return saveToPath(path)
    }

    // electron-desktop P1 文件通道（2026-09-20）：Electron 形态下 prompt()
    // 不支持抛错被静默吞——改走原生 Save dialog（dialog.showSaveDialog）拿到
    // 绝对路径后经 /__dianjing/file-write 端点写盘。语义与 IS_TAURI 分支对齐：
    // 取消（path=null）返回 false；写入成功 setSourceIdentity + startWatchingFile
    if (isElectron()) {
      const path = await chooseElectronSavePath('Untitled.fig', [
        { name: 'Figma file', extensions: ['fig'] }
      ])
      if (!path) return false
      return saveToPath(path)
    }

    // The picker helper returns null when the browser has no File System Access API.
    const handle = await chooseBrowserFigSaveHandle()
    if (handle) {
      setStorageBinding(null)
      setFileHandle(handle)
      setFilePath(null)
      state.documentName = documentNameFromFigPath(handle.name)
      const wrote = await writeFile(data, version)
      if (wrote) setSourceIdentity({ handle, path: null })
      startWatchingFile()
      return wrote
    }

    const filename = prompt(filesMessages.get().saveAsPrompt, getDownloadName() ?? 'Untitled.fig')
    if (!filename) return false
    setStorageBinding(null)
    setDownloadName(filename)
    state.documentName = documentNameFromFigPath(filename)
    downloadBlob(new Uint8Array(data), filename, 'application/octet-stream')
    await onDownloadSuccess?.(version)
    return true
  }

  return { saveFigFile, saveFigFileAs, writeFile }
}
