/**
 * Electron spike 窗口状态持久化——bounds（width/height/x/y/maximized）落盘到
 * userData/window-state.json。
 *
 * 设计取舍：
 *  - 文件位置：app.getPath('userData')/window-state.json——与 P1.9.1 userData
 *    化一致，卸载/重装行为由 OS 接管；不写进 DIANJING_ROOT_DIR（那是
 *    sidecar 的状态根，不该被窗口 bounds 污染）
 *  - 校验显示器交集：保存时的坐标可能在保存与恢复之间失效（最经典场景：拔
 *    了外接屏，原本在副屏右侧的窗口坐标出屏）。load 时拿当前 screen.
 *    getAllDisplays() 的 workArea 做矩形相交——任意显示器有交集即认为可用；
 *    否则回退默认 1440x900 不带 x/y（BrowserWindow 自动居中）
 *  - 写盘时机：window 'close' 事件（关窗前最后一次机会，destroyed 之前）；
 *    不挂 'closed'（那时窗口已销毁、getBounds() 行为 undefined）。多个
 *    关闭源（用户点叉、quit、second-instance、smoke 探针）都走同一路径
 *  - 容错：读坏 JSON / 写失败 / 缺字段全部降级——窗口状态不该让 app 启动
 *    失败（用户已知的「首启无 bounds」是更可取的失败模式）
 *  - 单窗口假设：本 spike 形态下只有一个 primary window；多窗口 P2 后再扩
 *    （按窗口 id 分键即可，本文件接口已留余地）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname as pathDirname, join } from 'node:path'
import { app, screen, type Rectangle } from 'electron'

const FILE_NAME = 'window-state.json'

export interface WindowState {
  width: number
  height: number
  /** x/y 可省——无值或校验失败时回退默认尺寸且不指定坐标（让 OS 居中） */
  x?: number
  y?: number
  /** 单独恢复（win.maximize()）；持久化时与 isMaximized() 对齐 */
  maximized: boolean
}

const DEFAULT_WIDTH = 1440
const DEFAULT_HEIGHT = 900

function statePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function parseState(raw: string): WindowState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const width = Number(obj.width)
  const height = Number(obj.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const out: WindowState = {
    width: Math.round(width),
    height: Math.round(height),
    maximized: obj.maximized === true
  }
  if (Number.isFinite(obj.x) && Number.isFinite(obj.y)) {
    out.x = Math.round(Number(obj.x))
    out.y = Math.round(Number(obj.y))
  }
  return out
}

/**
 * 与当前显示器集合求交集——任意 display workArea 与目标矩形有正面积相交
 * 即认为「屏幕可见」。零面积接触（边贴边）不算可见，避免 1px 误判
 */
function intersectsAnyDisplay(rect: Rectangle): boolean {
  const displays = screen.getAllDisplays()
  for (const display of displays) {
    const wa = display.workArea
    const overlapX = Math.max(0, Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x))
    const overlapY = Math.max(0, Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y))
    if (overlapX > 0 && overlapY > 0) return true
  }
  return false
}

/**
 * 加载窗口状态——若文件不存在/损坏/字段非法/坐标与当前显示器无交集，全部
 * 回退默认尺寸（不指定 x/y，让 BrowserWindow 居中）
 */
export function loadWindowState(): WindowState {
  const fallback: WindowState = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false }
  const path = statePath()
  if (!existsSync(path)) return fallback
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    console.error(
      `[window-state] 读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}——使用默认尺寸`
    )
    return fallback
  }
  const parsed = parseState(raw)
  if (!parsed) {
    console.error(`[window-state] ${path} 内容损坏或字段非法——使用默认尺寸`)
    return fallback
  }
  // 校验坐标与显示器集合的可见性；坐标缺失/越界都回退默认
  if (parsed.x !== undefined && parsed.y !== undefined) {
    const visible = intersectsAnyDisplay({ x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height })
    if (!visible) {
      console.error(
        `[window-state] 持久化坐标 (${parsed.x}, ${parsed.y}) ${parsed.width}x${parsed.height} ` +
          '与当前显示器集合无交集——使用默认尺寸'
      )
      return { width: parsed.width, height: parsed.height, maximized: parsed.maximized }
    }
  }
  return parsed
}

/**
 * 写窗口状态——tmp + rename 原子替换，避免崩溃时残留半个 JSON 让下次启动
 * 解析报错。失败仅日志，不抛——窗口关闭路径不该因为写盘失败把异常冒到 main
 */
export function saveWindowState(state: WindowState): void {
  const path = statePath()
  try {
    mkdirSync(pathDirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    console.error(
      `[window-state] 写入 ${path} 失败：${error instanceof Error ? error.message : String(error)}——下次启动将使用默认尺寸`
    )
  }
}