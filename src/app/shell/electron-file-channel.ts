// electron-desktop P1 文件通道客户端（2026-09-20）。
//
// 渲染层 sandbox + contextIsolation 模式无 preload contextBridge，所有
// tauri invoke 的桌面能力（dialog.showSaveDialog / showOpenDialog / writeFile /
// readFile / app.addRecentDocument）经 loopback HTTP 端点中转。封装五个端点 +
// 通用错误归一（5xx / 网络断开统一 throw，前端 try/catch 处理）。
//
// 端点定义见 desktop-electron/main/main.ts 同名命名空间：
//   POST /__dianjing/file-dialog/save  body { defaultPath?, filters? } → { path: string|null }
//   POST /__dianjing/file-dialog/open  body { multiple?, filters? }    → { paths: string[] }
//   POST /__dianjing/file-write        body { path, data(base64) }     → { ok: true }
//   POST /__dianjing/file-read         body { path }                   → { name, data(base64) }
//   POST /__dianjing/recent-files      body { paths: string[] }        → { ok: true, accepted, skipped }
//
// 鉴权（2026-09-20 续登）：文件家族 5 个端点统一要求 authorization: Bearer
// <token>，token 与注入 index.html 的 __DIANJING_RUNTIME_AUTOMATION_TOKEN__
// 同源（见 main.ts createLoopbackServer 闭包 token 变量）。本模块 postJSON
// 自动从 window[RUNTIME_AUTOMATION_TOKEN_KEY] 读，无值时返 401 fail-fast——
// 浏览器形态走 isElectron() 早返不走端点，不带 token 无副作用
//
// 单一真源：只在本文件 import 这五个端点；上层（save.ts / files.ts /
// export/files.ts / recent-files.ts）只依赖本文件暴露的函数。失败语义：
//  - 用户在 dialog 点 Cancel：saveDialog 返 { path: null }，openDialog 返 { paths: [] }，
//    与 tauri 行为对齐（tauri save() 返 null，open() 返 null 或 []）。
//  - 网络断开 / 5xx / 401：throw new Error(message) 让上层走 try/catch，
//    与 tauri invoke reject 语义对齐。

import { decodeBase64, encodeBase64 } from '@open-pencil/core/bytes'
import { hasWindowGlobal } from '@open-pencil/core/constants'

import { RUNTIME_AUTOMATION_TOKEN_KEY } from '@/app/orchestration/runtime-globals'
import { isElectron } from '@/app/shell/electron'

export interface FileDialogFilter {
  name: string
  extensions: string[]
}

interface SaveDialogResponse {
  path: string | null
}

interface OpenDialogResponse {
  paths: string[]
}

interface WriteFileResponse {
  ok: true
}

interface ReadFileResponse {
  name: string
  data: string
}

interface RecentFilesResponse {
  ok: true
  accepted: number
  skipped: number
}

function getElectronAuthToken(): string | null {
  // 与 bridge/runtime.ts:224 同模式——hasWindowGlobal() 守 SSR / Node 测试，
  // typeof string 守未注入形态。Electron 形态下 main 已把 token 写入
  // window.__DIANJING_RUNTIME_AUTOMATION_TOKEN__，浏览器形态无该属性返 null
  if (!hasWindowGlobal()) return null
  const token = window[RUNTIME_AUTOMATION_TOKEN_KEY]
  return typeof token === 'string' ? token : null
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  // 任何失败一律 throw——上层 save.ts / files.ts 已习惯 try/catch。
  // 不读非 2xx 响应的 body（main 已经把 detail 写进 body 但前端用不到），
  // 读 status + 抛可定位错误足够
  const token = getElectronAuthToken()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // token 缺失 → 直接 throw（与 401 等价处理），避免发出无鉴权请求浪费往返
  if (token === null) {
    throw new Error(`${url} failed: missing runtime auth token`)
  }
  headers.authorization = `Bearer ${token}`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = await response.text()
    } catch {
      // 读 body 也失败——留 detail 空（best-effort，不让读取异常盖过状态码错误）
      detail = ''
    }
    throw new Error(`${url} failed: ${response.status}${detail ? ` ${detail}` : ''}`)
  }
  return (await response.json()) as T
}

/** Electron 形态下弹出原生 Save 对话框；用户取消返 null。 */
export async function chooseElectronSavePath(
  defaultPath: string | undefined,
  filters: FileDialogFilter[]
): Promise<string | null> {
  if (!isElectron()) return null
  const result = await postJSON<SaveDialogResponse>('/__dianjing/file-dialog/save', {
    defaultPath,
    filters
  })
  return result.path
}

/** Electron 形态下弹出原生 Open 对话框；用户取消返 []。 */
export async function chooseElectronOpenPaths(
  multiple: boolean,
  filters: FileDialogFilter[]
): Promise<string[]> {
  if (!isElectron()) return []
  const result = await postJSON<OpenDialogResponse>('/__dianjing/file-dialog/open', {
    multiple,
    filters
  })
  return result.paths
}

/** Electron 形态下经 main 写文件（避免渲染层受 sandbox 限制）。 */
export async function writeElectronFile(path: string, data: Uint8Array): Promise<void> {
  if (!isElectron()) return
  // base64 编解码统一走 core/bytes 单源（js-base64 直转 Uint8Array，不经
  // 字符串中间态——无 String.fromCharCode.apply 大文件 RangeError 风险）
  await postJSON<WriteFileResponse>('/__dianjing/file-write', { path, data: encodeBase64(data) })
}

/** Electron 形态下经 main 读文件回 Uint8Array（用于打开文件闭环）。 */
export async function readElectronFile(
  path: string
): Promise<{ name: string; data: Uint8Array } | null> {
  if (!isElectron()) return null
  // main 已用 statSync 校验存在 + isFile()，落到本函数仍 try/catch 兜 500
  const result = await postJSON<ReadFileResponse>('/__dianjing/file-read', { path })
  return { name: result.name, data: decodeBase64(result.data) }
}

/** Electron 形态下推 OS 级最近文件清单（喂 app.addRecentDocument）。 */
export async function syncElectronRecentFiles(paths: string[]): Promise<void> {
  if (!isElectron()) return
  await postJSON<RecentFilesResponse>('/__dianjing/recent-files', { paths })
}
