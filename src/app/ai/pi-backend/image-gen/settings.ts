/**
 * generate_image 本地留存偏好（owner 拍板）。
 *
 * 存储：.dianjing/pi-agent/image-gen-settings.json（tmp+rename 原子写）。
 * 当前形状 `{ retainLocal: boolean }`——首次配置前不主动写盘，缺文件 =
 * 缺省 `{ retainLocal: false }`（fail-safe：默认不复制，避免悄悄占满磁盘）。
 * 坏 JSON / 字段类型不对 = 回缺省，不抛（与 capabilities.ts 纪律同）。
 *
 * 与 credentials 的差别：无敏感字段、不回显 key 语义——脱敏压力零；写盘
 * 模式（0o600 / tmp+rename）只是对齐 agentDir 内其他 settings 文件的卫生
 * 标准，0o600 在 win 下不可断言，仅在 POSIX 平台生效。
 *
 * dir 字段不进落盘文件（resolveImageGenOutputDir 来自 rootDir，运行时拼；
 * 若用户迁移状态根，dir 自动跟随），由 GET 端点层填进响应 DTO。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILENAME = 'image-gen-settings.json'

interface ImageGenSettingsFile {
  version: 1
  retainLocal: boolean
}

const DEFAULTS: { retainLocal: boolean } = { retainLocal: false }

/**
 * 响应 DTO（路由层组装：retainLocal 来自 store，dir 由 resolveImageGenOutputDir
 * 在 server.ts 装配时注入；前端 type-only import，DTO 单源在 backend，构建期
 * 擦除——同 ImageGenCredentialStatus 先例）。
 */
export interface ImageGenSettingsStatus {
  retainLocal: boolean
  dir: string
}

export interface ImageGenSettingsStore {
  get(): { retainLocal: boolean }
  setRetainLocal(value: boolean): { retainLocal: boolean }
  /** 测试钩子：丢弃内存缓存，下次 get 重读盘 */
  reloadForTests(): void
}

export function createImageGenSettingsStore({
  agentDir
}: {
  agentDir: string
}): ImageGenSettingsStore {
  const filePath = join(agentDir, FILENAME)
  let cache: { retainLocal: boolean } | undefined

  function readFromDisk(): { retainLocal: boolean } {
    if (!existsSync(filePath)) return { ...DEFAULTS }
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ImageGenSettingsFile>
      if (typeof raw.retainLocal === 'boolean') return { retainLocal: raw.retainLocal }
      return { ...DEFAULTS }
    } catch {
      // 坏 JSON / 字段类型不对 → 回缺省，不抛（fail-safe：磁盘坏文件不应阻
      // 断整个生图通路；用户可重新切开关落新盘覆盖）
      return { ...DEFAULTS }
    }
  }

  function get(): { retainLocal: boolean } {
    if (cache === undefined) cache = readFromDisk()
    return cache
  }

  function writeToDisk(next: { retainLocal: boolean }): void {
    mkdirSync(agentDir, { recursive: true })
    const doc: ImageGenSettingsFile = { version: 1, retainLocal: next.retainLocal }
    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(doc, null, 2), { mode: 0o600 })
    renameSync(tmpPath, filePath)
  }

  function setRetainLocal(value: boolean): { retainLocal: boolean } {
    const next = { retainLocal: value }
    writeToDisk(next)
    cache = next
    return next
  }

  function reloadForTests(): void {
    cache = undefined
  }

  return { get, setRetainLocal, reloadForTests }
}
