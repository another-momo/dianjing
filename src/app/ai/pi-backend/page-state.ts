/**
 * 2026-09-26 sl-w1-page-state：用户层文档级标量存储层——
 * `docUuid → { modeId, profileId, engagedPageId }`，一文档一文件落
 * `<状态根>/page-state/<docUuid>.json`。
 *
 * 与 design-assignment.ts 同缝同家规（tmp + rename 原子写 / 0o600 /
 * 腐烂即无不抛）；落点 / 规制双层确认门确认即物化，无 intent 中间态。
 *
 * 一文档一文件而非单 map 文件的取舍：dev / 打包版双进程并发读-改-写
 * 同一 map 文件会互丢更新（tmp + rename 只防撕裂不防互丢）；按文档分
 * 文件顺带把腐烂粒度对齐到单文档（坏一文件只丢一文档的规制 + 落点）。
 *
 * patch 语义（writePageState）：写入只覆盖传入的非 undefined 字段，
 * 未传入字段保留旧值——前端只发变了的部分即可，未变字段不传。null =
 * 显式清空（规制清空 = 当前对话无 modeId/profileId 绑定；落点清空 =
 * 下次发消息走首跑初始化）。字段全集缺省 = 删文件（与 design-assignment
 * set(null) 同律）。
 *
 * 缺失 / 坏 JSON / 形状坏 = 腐烂即无 → 返 null（不抛），由上层按
 * `缺省链 general + 视图页落点` 兜底（§2 拍板）。
 *
 * 无进程内缓存、读穿盘：dev / 打包版共享状态根，跨进程交替打开同一
 * 文档时缓存会把陈旧值喂给落点拦截门；单文件 JSON 读成本可忽略。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 文档级标量值——modeId / profileId = 规制；engagedPageId = 落点。
 * 字段全集可空（null = 显式清空）；读不存在文件 / 坏 JSON / 形状坏 = 整对象 = null。 */
export interface PageState {
  modeId: string | null
  profileId: string | null
  engagedPageId: string | null
}

/** patch 入参：未传字段 = 不动；显式 null = 清空该字段。
 * 约定与 design-assignment.ts set(null) 同源：「不传」与「null」语义不同。 */
export type PageStatePatch = {
  modeId?: string | null
  profileId?: string | null
  engagedPageId?: string | null
}

export type PageStateStore = {
  /** 读某文档的标量；缺失 / 坏文件 / 形状坏 → 返 null（不抛）。 */
  read(docUuid: string): PageState | null
  /** 部分字段合并写；未传字段保留旧值；显式 null = 清空该字段。
   *  字段全部未传（patch = {}）= 删文件（与 set(null) 同律）。 */
  write(docUuid: string, patch: PageStatePatch): PageState
  /** 删某文档的标量文件；文件本不存在 → no-op（existsSync 守卫）。 */
  clear(docUuid: string): void
  /** 测试钩子：是否落盘（不存在则 false）。 */
  exists(docUuid: string): boolean
}

/** docUuid 文件名合法性：路径分隔符 / null 字节禁止（防跨目录与文件名注入）。
 * 仅做字符白名单——docUuid 是 uuid 形态（[0-9a-f-]）+ 仓内 mint 的限制外延。 */
const DOC_UUID_RE = /^[A-Za-z0-9-]{1,128}$/

function assertValidDocUuid(docUuid: string): void {
  if (!DOC_UUID_RE.test(docUuid)) {
    throw new TypeError(
      `page-state docUuid 非法：${JSON.stringify(docUuid)}（需 ^[A-Za-z0-9-]{1,128}$）`
    )
  }
}

function isPageState(value: unknown): value is PageState {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  // 三字段都必须存在且为 string|null（undefined = 缺字段 = 形状坏）
  if (!('modeId' in obj) || !('profileId' in obj) || !('engagedPageId' in obj)) {
    return false
  }
  return (
    (obj.modeId === null || typeof obj.modeId === 'string') &&
    (obj.profileId === null || typeof obj.profileId === 'string') &&
    (obj.engagedPageId === null || typeof obj.engagedPageId === 'string')
  )
}

function clone(state: PageState): PageState {
  return {
    modeId: state.modeId,
    profileId: state.profileId,
    engagedPageId: state.engagedPageId
  }
}

export function createPageStateStore({ pageStateDir }: { pageStateDir: string }): PageStateStore {
  function filePath(docUuid: string): string {
    return join(pageStateDir, `${docUuid}.json`)
  }

  function readFromDisk(docUuid: string): PageState | null {
    const path = filePath(docUuid)
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return isPageState(raw) ? clone(raw) : null
    } catch {
      // ENOENT（首跑无规制 / 落点）= 正常静默；坏 JSON / 形状坏 = 腐烂 → null
      // 不抛——缺省链兜底（§2 拍板：规制 general + 落点取视图页）
      return null
    }
  }

  function read(docUuid: string): PageState | null {
    assertValidDocUuid(docUuid)
    return readFromDisk(docUuid)
  }

  function writeToDisk(docUuid: string, state: PageState): void {
    mkdirSync(pageStateDir, { recursive: true })
    const path = filePath(docUuid)
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmpPath, path)
  }

  function write(docUuid: string, patch: PageStatePatch): PageState {
    assertValidDocUuid(docUuid)
    const keys = Object.keys(patch)
    const isEmptyPatch = keys.length === 0
    if (isEmptyPatch) {
      clear(docUuid)
      // clear 后该文档状态 = 全 null（缺省链语义）
      return { modeId: null, profileId: null, engagedPageId: null }
    }
    const current = read(docUuid) ?? { modeId: null, profileId: null, engagedPageId: null }
    const next: PageState = {
      modeId: 'modeId' in patch ? (patch.modeId ?? null) : current.modeId,
      profileId: 'profileId' in patch ? (patch.profileId ?? null) : current.profileId,
      engagedPageId:
        'engagedPageId' in patch ? (patch.engagedPageId ?? null) : current.engagedPageId
    }
    writeToDisk(docUuid, next)
    return clone(next)
  }

  function clear(docUuid: string): void {
    assertValidDocUuid(docUuid)
    const path = filePath(docUuid)
    if (existsSync(path)) unlinkSync(path)
  }

  function exists(docUuid: string): boolean {
    assertValidDocUuid(docUuid)
    return existsSync(filePath(docUuid))
  }

  return { read, write, clear, exists }
}
