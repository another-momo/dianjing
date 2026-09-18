/**
 * 2026-09-18 userdata 目录重排：存量一次性迁移（规格 §5.3，
 * docs/202609181334-userdata-relayout-research.md）。
 *
 * 两个分面（均在启动序列 seed 之前调用，service.ts 接线）：
 *
 *  1. `studio/` → `workspace/.agents/`：旧目录存在且新目录不存在 → 整目录
 *     rename（同卷快路径）；跨卷/占用失败 → copy + 逐项 verify（相对路径 +
 *     尺寸比对）+ delete；新目录已存在 = 半态/已迁过 → 不迁仅 warn（用户
 *     资产优先，幂等）。
 *  2. `image-gen-output/` → `workspace/image-gen-output/`：旧平铺条目按
 *     文件名前 8 位（YYYYMMDD）解析分桶搬入 `YYYY-MM-DD/` 子目录；解析失败
 *     （手动放入的文件/子目录）进 `legacy/` 子目录。目标已存在同名 → 跳过
 *     不覆盖 + warn。全部搬完后旧目录为空则删，非空（有跳过项）则留。
 *
 * 纪律：
 *  - 迁移失败仅 warn 不阻断启动（任何 IO 异常都不得挂起后端）；
 *  - 幂等：迁移完成后旧目录消失，下次启动两分面均 no-op；
 *  - 旧位字面量（'studio' / 'image-gen-output' 顶层平铺）是历史认知，写在
 *    本文件局部常量——永不跟随 paths.ts 现行常量漂移（现行位已由
 *    PI_WORKSPACE_SUBDIR / USER_STUDIO_SUBPATH / IMAGE_GEN_OUTPUT_SUBDIR
 *    表达）；
 *  - 全程 console.warn 可查（warn 通道可注入，测试断言用）。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import { PI_WORKSPACE_SUBDIR } from './paths'

/** 历史位：用户扩展层旧根（2026-09-18 前 = rootDir 顶层平铺） */
const LEGACY_STUDIO_SUBDIR = 'studio'
/** 历史位：生图留存旧根（2026-09-18 前 = rootDir 顶层平铺） */
const LEGACY_IMAGE_GEN_OUTPUT_SUBDIR = 'image-gen-output'
/** 现行位目录名（与 paths.ts USER_STUDIO_SUBPATH 末段一致——局部重复是故意的：
 *  迁移逻辑必须钉死历史↔现行映射，paths.ts 再改也不应牵动本迁移） */
const AGENTS_DIR_NAME = '.agents'
const IMAGE_GEN_OUTPUT_DIR_NAME = 'image-gen-output'
/** 无法按日期解析的旧平铺条目落点（workspace/image-gen-output/legacy/） */
const LEGACY_BUCKET_NAME = 'legacy'

/** 测试注入缝：rename / copyFile / warn 可桩（生产缺省真 fs + console.warn） */
export interface MigrateDeps {
  rename?: (src: string, dst: string) => void
  copyFile?: (src: string, dst: string) => void
  warn?: (message: string) => void
}

type ResolvedDeps = {
  rename: (src: string, dst: string) => void
  copyFile: (src: string, dst: string) => void
  warn: (message: string) => void
}

function resolveDeps(deps: MigrateDeps): ResolvedDeps {
  return {
    rename: deps.rename ?? renameSync,
    copyFile: deps.copyFile ?? copyFileSync,
    warn: deps.warn ?? ((message) => console.warn(message))
  }
}

/**
 * 存量迁移主入口（启动序列 seed 之前）。任一分面抛错都降级为 warn——
 * 迁移是顺路优化，不是启动前置条件。
 */
export function migrateUserdataLayout(rootDir: string, deps: MigrateDeps = {}): void {
  const resolved = resolveDeps(deps)
  for (const facet of [migrateStudioDir, migrateImageGenOutputDir] as const) {
    try {
      facet(rootDir, resolved)
    } catch (error) {
      resolved.warn(
        `[pi-backend] userdata 迁移 ${facet.name} 失败（忽略，不阻断启动）：` +
          (error instanceof Error ? error.message : String(error))
      )
    }
  }
}

/** 分面①：studio/ → workspace/.agents/（整目录） */
function migrateStudioDir(rootDir: string, deps: ResolvedDeps): void {
  const oldDir = join(rootDir, LEGACY_STUDIO_SUBDIR)
  const newDir = join(rootDir, PI_WORKSPACE_SUBDIR, AGENTS_DIR_NAME)
  if (!existsSync(oldDir)) return
  if (existsSync(newDir)) {
    deps.warn(
      `[pi-backend] userdata 迁移：${newDir} 已存在（半态或已迁过），跳过 studio 迁移` +
        `（旧目录保留在 ${oldDir}，请人工核对后删除）`
    )
    return
  }
  moveDirWithFallback(oldDir, newDir, deps)
}

/**
 * 整目录搬迁：rename 快路径（同卷原子）→ 失败走 copy + 逐项 verify + delete。
 * verify 不一致（copy 半态）→ warn 保留旧目录，不删（下次启动按「新目录已存在」
 * 分支再 warn——人工介入前不丢数据）。
 */
function moveDirWithFallback(src: string, dst: string, deps: ResolvedDeps): void {
  // rename 的 dst 父链必须先存在（ENOENT 不算「跨卷/占用」，不应白走兜底）
  mkdirSync(dirname(dst), { recursive: true })
  try {
    deps.rename(src, dst)
    return
  } catch (error) {
    deps.warn(
      `[pi-backend] userdata 迁移：rename ${src} → ${dst} 失败（${formatErr(error)}），` +
        '降级 copy + verify + delete'
    )
  }
  copyTree(src, dst, deps)
  const mismatches = verifyTree(src, dst)
  if (mismatches.length > 0) {
    deps.warn(
      `[pi-backend] userdata 迁移：copy 校验不一致（${mismatches.length} 项，首个 ` +
        `${mismatches[0]}）——旧目录 ${src} 保留不删，请人工核对`
    )
    return
  }
  rmSync(src, { recursive: true, force: true })
}

/** 递归复制目录树（文件 → copyFile；目录 → mkdir + 递归；symlink 跳过——
 *  避免循环引用 + 跨设备边界，与 studio/seed.ts copyTree 同纪律）。 */
function copyTree(src: string, dst: string, deps: ResolvedDeps): void {
  const stat = statSync(src)
  if (stat.isFile()) {
    mkdirSync(dirname(dst), { recursive: true })
    deps.copyFile(src, dst)
    return
  }
  if (!stat.isDirectory()) return
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    copyTree(join(src, entry.name), join(dst, entry.name), deps)
  }
}

/** 逐项校验：src 侧全部文件在 dst 侧存在且尺寸一致；返回差异相对路径清单 */
function verifyTree(src: string, dst: string): string[] {
  const mismatches: string[] = []
  const walk = (srcDir: string, relPrefix: string): void => {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      const srcPath = join(srcDir, entry.name)
      if (entry.isDirectory()) {
        walk(srcPath, rel)
        continue
      }
      if (!entry.isFile()) continue
      const dstPath = join(dst, rel)
      if (!existsSync(dstPath) || statSync(dstPath).size !== statSync(srcPath).size) {
        mismatches.push(rel)
      }
    }
  }
  walk(src, '')
  return mismatches
}

/** 分面②：image-gen-output/ 平铺 → workspace/image-gen-output/<YYYY-MM-DD>/ */
function migrateImageGenOutputDir(rootDir: string, deps: ResolvedDeps): void {
  const oldDir = join(rootDir, LEGACY_IMAGE_GEN_OUTPUT_SUBDIR)
  const newRoot = join(rootDir, PI_WORKSPACE_SUBDIR, IMAGE_GEN_OUTPUT_DIR_NAME)
  if (!existsSync(oldDir)) return
  for (const entry of readdirSync(oldDir, { withFileTypes: true })) {
    const bucket = parseDateBucket(entry.name) ?? LEGACY_BUCKET_NAME
    const targetDir = join(newRoot, bucket)
    const targetPath = join(targetDir, entry.name)
    if (existsSync(targetPath)) {
      deps.warn(
        `[pi-backend] userdata 迁移：${targetPath} 已存在，跳过不覆盖` +
          `（旧条目保留在 ${join(oldDir, entry.name)}）`
      )
      continue
    }
    mkdirSync(targetDir, { recursive: true })
    moveEntryWithFallback(join(oldDir, entry.name), targetPath, deps)
  }
  // 全部搬走后旧目录为空 → 删；有跳过项（非空 ENOTEMPTY）或系统占用 → 保留并出声。
  // rmdirSync 只删空目录（rmSync 无 recursive 对目录抛 ERR_FS_EISDIR）。
  try {
    rmdirSync(oldDir)
    // oxlint-disable-next-line open-pencil/no-silent-catch -- 删除失败仅 warn 留痕，旧目录保留不丢数据
  } catch (error) {
    deps.warn(
      `[pi-backend] userdata 迁移：旧目录 ${oldDir} 未能删除（非空有跳过项或系统占用，` +
        `${formatErr(error)}），保留待人工处理`
    )
  }
}

/** 单条目搬迁：rename 快路径 → 失败走 copy + size 校验 + 删原件 */
function moveEntryWithFallback(src: string, dst: string, deps: ResolvedDeps): void {
  try {
    deps.rename(src, dst)
    return
    // oxlint-disable-next-line open-pencil/no-silent-catch -- rename 失败即走下方 copy 兜底，非吞错
  } catch {
    // fallthrough 到 copy 兜底
  }
  const stat = statSync(src)
  if (stat.isDirectory()) {
    copyTree(src, dst, deps)
    const mismatches = verifyTree(src, dst)
    if (mismatches.length > 0) {
      deps.warn(
        `[pi-backend] userdata 迁移：copy 校验不一致（${mismatches.length} 项）——` +
          `旧条目 ${src} 保留不删，请人工核对`
      )
      return
    }
    rmSync(src, { recursive: true, force: true })
    return
  }
  deps.copyFile(src, dst)
  if (statSync(dst).size !== stat.size) {
    deps.warn(`[pi-backend] userdata 迁移：copy 尺寸不一致——旧条目 ${src} 保留不删，请人工核对`)
    return
  }
  rmSync(src)
}

/** 文件名前 8 位 `YYYYMMDD` → 桶名 `YYYY-MM-DD`；非法日期（月/日越界）→ null */
function parseDateBucket(filename: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(filename)
  if (!match) return null
  const [, yyyy, mm, dd] = match
  const month = Number(mm)
  const day = Number(dd)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${yyyy}-${mm}-${dd}`
}

function formatErr(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
