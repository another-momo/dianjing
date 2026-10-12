/**
 * pi-backend 字体库存储层。
 *
 * 落点：<rootDir>/fonts/v1/<hash-prefix>/<hash>.<ext>（全量单文件）+ manifest.json。
 * 写盘一律 tmp + rename（pi-agent 凭据先例）；清理按 style 粒度删除单文件或整族目录。
 *
 * 设计取舍：
 *  - 哈希用 sha256 hex 前缀 32 字符（layout.ts）——跨进程确定性
 *  - readManifest 容错 = 坏文件按空库返（UI 列空库 + 手动重装）；不抛
 *  - writeManifest 调用方控制刷盘时机（批次安装收口处一次写）
 *  - deleteStyle/deleteFamily 同步删字节 + manifest 项；删空族不残留目录
 *  - 不与 font/variable.ts 共享字节读路径（服务进程跑在 node，opentype.js
 *    parse 同步 await；不阻塞 I/O）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  type ContentHash,
  type FontExtension,
  fullFontRelativePath,
  hashBytesToHex,
  resolveFontsRoot,
  slugifyFamilyName
} from '@open-pencil/core/text/font/installed/layout'
import {
  type FamilyEntry,
  type ManifestFile,
  type StyleEntry,
  emptyManifest,
  parseManifest,
  removeFamily,
  removeStyle,
  upsertStyle
} from '@open-pencil/core/text/font/installed/manifest'

const MANIFEST_FILENAME = 'manifest.json'

/** node:crypto sha256 hex → 32 字符前缀。layout.ts hasher 接口兑现 */
const sha256Hasher = (bytes: Uint8Array): ContentHash =>
  createHash('sha256').update(bytes).digest('hex')

export interface FontsStore {
  /** manifest 路径绝对路径 */
  manifestPath: string
  /** 库根（<rootDir>/fonts/v1） */
  fontsRoot: string
  readManifest(): ManifestFile
  writeManifest(manifest: ManifestFile): void
  /** 给定字节流 + 形态（full/subset）+ 族名 + style 条目 → 写入并刷 manifest */
  installBytes(args: {
    bytes: Uint8Array
    ext: FontExtension
    style: StyleEntry
    family: string
    artifact: 'full' | 'subset-collection'
  }): { hash: ContentHash; manifestPath: string }
  /** 按 hash + ext 读全量单文件字节（端点 read 端点用） */
  readBytes(hash: ContentHash, ext: FontExtension): Uint8Array | null
  /** 删除单 style（族内 styles 空则族一并删；删空族目录） */
  deleteStyle(family: string, styleKey: string): { removed: boolean; filePath?: string }
  /** 删除整族（族目录 + 字节 + manifest） */
  deleteFamily(family: string): { removed: boolean; removedFiles: number }
  /** 给定字节 → 内容哈希（hashBytesToHex + hasher） */
  hashBytes(bytes: Uint8Array): ContentHash
}

/**
 * 工厂：构造端点侧可用的字体存储实例。
 * rootDir = 状态根；所有路径派生走 layout 纯逻辑。
 */
export function createFontsStore({ rootDir }: { rootDir: string }): FontsStore {
  const fontsRoot = resolveFontsRoot(rootDir)
  const manifestPath = join(fontsRoot, MANIFEST_FILENAME)
  let cache: ManifestFile | undefined

  function ensureRoot(): void {
    if (!existsSync(fontsRoot)) mkdirSync(fontsRoot, { recursive: true })
  }

  function readManifest(): ManifestFile {
    if (cache) return cache
    ensureRoot()
    if (!existsSync(manifestPath)) {
      cache = emptyManifest(Date.now())
      return cache
    }
    let raw: string
    try {
      raw = readFileSync(manifestPath, 'utf8')
    } catch {
      cache = emptyManifest(Date.now())
      return cache
    }
    const result = parseManifest(raw)
    if (!result.ok) {
      // 坏 manifest = 按空库兜（不抛）。日志留给调用方读 details
      console.warn(
        `[fonts-store] manifest corrupt, falling back to empty: reason=${result.reason} detail=${result.detail}`
      )
      cache = emptyManifest(Date.now())
      return cache
    }
    cache = result.manifest
    return cache
  }

  function writeManifest(manifest: ManifestFile): void {
    ensureRoot()
    cache = manifest
    const doc = JSON.stringify(manifest)
    const tmpPath = `${manifestPath}.tmp`
    writeFileSync(tmpPath, doc, { mode: 0o600 })
    renameSync(tmpPath, manifestPath)
  }

  function installBytes(args: {
    bytes: Uint8Array
    ext: FontExtension
    style: StyleEntry
    family: string
    artifact: 'full' | 'subset-collection'
  }): { hash: ContentHash; manifestPath: string } {
    const hash = hashBytesToHex(args.bytes, sha256Hasher)
    const relPath = fullFontRelativePath(hash, args.ext)
    const absPath = join(fontsRoot, ...relPath.split('/'))
    ensureRoot()
    mkdirSync(dirname(absPath), { recursive: true })
    const tmpPath = `${absPath}.tmp`
    writeFileSync(tmpPath, args.bytes)
    renameSync(tmpPath, absPath)
    const manifest = readManifest()
    // 同 (family, key) 重装但字节已变：先摘出旧条目 hash，manifest 落盘后再删旧字节
    // ——不能先删字节再写 manifest（中途崩溃会 manifest 指着不存在的文件）
    const familyEntry = manifest.families.find((f) => f.family === args.family)
    const previous = familyEntry?.styles.find((st) => st.key === args.style.key)
    const staleHash =
      previous && previous.hash !== hash && previous.artifact === 'full' ? previous.hash : null
    const staleExt = previous?.ext ?? 'ttf'
    upsertStyle(manifest, args.family, args.style)
    manifest.updatedAt = Date.now()
    writeManifest(manifest)
    if (staleHash) {
      const stalePath = join(fontsRoot, ...fullFontRelativePath(staleHash, staleExt).split('/'))
      if (existsSync(stalePath)) {
        try {
          rmSync(stalePath, { force: true })
        } catch {
          // 孤儿清理失败不阻断安装——字节泄漏留给下次族删除兜底
        }
      }
    }
    return { hash, manifestPath }
  }

  function readBytes(hash: ContentHash, ext: FontExtension): Uint8Array | null {
    const relPath = fullFontRelativePath(hash, ext)
    const absPath = join(fontsRoot, ...relPath.split('/'))
    if (!existsSync(absPath)) return null
    return readFileSync(absPath)
  }

  function deleteStyle(family: string, styleKey: string): { removed: boolean; filePath?: string } {
    const manifest = readManifest()
    const familyEntry = manifest.families.find((f) => f.family === family)
    if (!familyEntry) return { removed: false }
    const styleEntry = familyEntry.styles.find((s) => s.key === styleKey)
    if (!styleEntry) return { removed: false }
    // 仅删字节文件（仅 artifact=full 有路径定位；subset-collection 走族目录删除）
    let filePath: string | undefined
    if (styleEntry.artifact === 'full') {
      const relPath = fullFontRelativePath(styleEntry.hash, extFromStyleEntry(styleEntry))
      const absPath = join(fontsRoot, ...relPath.split('/'))
      if (existsSync(absPath)) {
        rmSync(absPath, { force: true })
        filePath = absPath
      }
    }
    removeStyle(manifest, family, styleKey)
    manifest.updatedAt = Date.now()
    writeManifest(manifest)
    return { removed: true, ...(filePath ? { filePath } : {}) }
  }

  function deleteFamily(family: string): { removed: boolean; removedFiles: number } {
    const manifest = readManifest()
    const familyEntry = manifest.families.find((f) => f.family === family)
    if (!familyEntry) return { removed: false, removedFiles: 0 }
    let removedFiles = 0
    const familySlug = slugifyFamilyName(family)
    const familyDir = join(fontsRoot, familySlug)
    if (existsSync(familyDir)) {
      // rmSync recursive（subset-collection 族目录可能含多片）
      try {
        rmSync(familyDir, { recursive: true, force: true })
        removedFiles += 1
      } catch {
        // 单目录删除失败不阻断——下面 manifest 删除独立
      }
    }
    // full artifact 也按 hash 单文件删（族内可能含 full 条目）
    for (const style of familyEntry.styles) {
      if (style.artifact !== 'full') continue
      const relPath = fullFontRelativePath(style.hash, extFromStyleEntry(style))
      const absPath = join(fontsRoot, ...relPath.split('/'))
      if (existsSync(absPath)) {
        try {
          rmSync(absPath, { force: true })
          removedFiles += 1
        } catch {
          // 单文件失败不阻断
        }
      }
    }
    removeFamily(manifest, family)
    manifest.updatedAt = Date.now()
    writeManifest(manifest)
    return { removed: true, removedFiles }
  }

  function hashBytes(bytes: Uint8Array): ContentHash {
    return hashBytesToHex(bytes, sha256Hasher)
  }

  return {
    manifestPath,
    fontsRoot,
    readManifest,
    writeManifest,
    installBytes,
    readBytes,
    deleteStyle,
    deleteFamily,
    hashBytes
  }
}

// ── 内部 helper ──────────────────────────────────────────────────────

/** style 条目 → 库存扩展名（manifest 记录真实 ext，缺省 ttf） */
function extFromStyleEntry(style: StyleEntry): FontExtension {
  return style.ext ?? 'ttf'
}

// 重新导出以便端点层 import 单点
export type { ContentHash, FamilyEntry, FontExtension, ManifestFile, StyleEntry }
