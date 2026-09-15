/**
 * ai-panel-ux-consolidation：「打开用户拓展文件夹」端点抽离——
 * opener 注入形态 + 默认实现 + 独立 handler。
 *
 * 拆出本模块而非塞进 server.ts：handler 自身不大，但 spawn/EventEmitter
 * 引用 + 默认 opener 三平台分支 + handler docstring 把 server.ts 顶过
 * max-lines 阈值。独立模块便于测试桩注入 opener（open-studio-folder.test.ts）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { readStudioBuiltinDir } from '@/app/orchestration/env'

import { resolveImageGenOutputDir, resolveStudioDirs } from './paths'

/** opener 注入形态——测试桩掉真 spawn，避免 explorer/open/xdg-open 跨平台
 *  副作用。返回子进程在同步抛错 / error 事件时由 handler 兜底翻译为
 *  ok:false / 异步到达仅记 warn。 */
export type OpenFolderOpener = (dir: string) => ChildProcess

/** 默认 opener：按平台起 explorer.exe / open / xdg-open；参数数组形态
 *  禁 shell 拼接；detached 不挂主进程（unref 返回 void 阻断 ChildProcess
 *  返回类型，故省略——detached 已让子进程独立，父进程退出不影响）。 */
export function defaultOpenFolderOpener(dir: string): ChildProcess {
  const opener = pickOpener(process.platform)
  return spawn(opener, [dir], { detached: true, stdio: 'ignore' })
}

function pickOpener(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'explorer.exe'
  if (platform === 'darwin') return 'open'
  return 'xdg-open'
}

/**
 * POST /api/pi/open-studio-folder——按 OS 唤起资源管理器 / Finder /
 * xdg-open 打开 userDir（与 service.ts seed 同源 resolveStudioDirs）。
 * 目录不存在时兜底 mkdir（seed 本应已建）；同步抛错按 ok:false 中文透传，
 * 异步 error 事件响应已发——handler 仅记 warn，不改响应。
 */
export async function handleOpenStudioFolderRequest(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  sendJSON: (res: ServerResponse, status: number, payload: unknown) => void,
  openFolder: OpenFolderOpener
): Promise<void> {
  // 与 service.ts seed 同源：builtinDir 用 env override；userDir 随 rootDir 走
  const { userDir } = resolveStudioDirs(rootDir, readStudioBuiltinDir())
  await openFolderAndRespond(userDir, req, res, sendJSON, openFolder)
}

/**
 * POST /api/pi/open-image-gen-folder——按 OS 唤起资源管理器 / Finder /
 * xdg-open 打开 image-gen 本地留存目录（rootDir/image-gen-output/）。
 * 目录兜底 mkdir 的另一层用意：用户首次开启留存开关前目录可能不存在，
 * 让开关 OFF 时也能预览目录 / 手动清空旧文件。
 */
export async function handleOpenImageGenFolderRequest(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  sendJSON: (res: ServerResponse, status: number, payload: unknown) => void,
  openFolder: OpenFolderOpener
): Promise<void> {
  await openFolderAndRespond(resolveImageGenOutputDir(rootDir), req, res, sendJSON, openFolder)
}

/** 两端点共享的打开骨架：POST 白名单 → mkdir 兜底 → opener 同步抛错
 *  ok:false 中文透传 / 异步 error 事件响应已发仅记 warn。抽共享除消重
 *  （jscpd threshold 0）外也让两端点行为恒一致。 */
async function openFolderAndRespond(
  dir: string,
  req: IncomingMessage,
  res: ServerResponse,
  sendJSON: (res: ServerResponse, status: number, payload: unknown) => void,
  openFolder: OpenFolderOpener
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }
  mkdirSync(dir, { recursive: true })
  let child: ChildProcess
  try {
    child = openFolder(dir)
  } catch (error) {
    // 同步抛错（opener 不存在 / 权限拒）——响应未发，按 ok:false 中文透传
    sendJSON(res, 200, {
      ok: false,
      error: `打开文件夹失败：${error instanceof Error ? error.message : String(error)}`
    })
    return
  }
  // error 事件异步到达时响应可能已发——仅记 warn，不改响应
  child.once('error', (error) => {
    console.warn(
      `[pi-backend] 打开文件夹失败（忽略，响应已发）：${dir}：` +
        (error instanceof Error ? error.message : String(error))
    )
  })
  sendJSON(res, 200, { ok: true })
}
