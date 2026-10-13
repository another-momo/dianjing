/**
 * pi-backend 字体库存储层。
 *
 * 落点：
 *  - 全量单文件（'full'）：<rootDir>/fonts/v1/<hash-prefix>/<hash>.<ext>
 *  - 分片集合（'subset-collection'）：<rootDir>/fonts/v1/<族 slug>/<片哈希>.ttf +
 *    <族 slug>/index.json（每 style 一条 piece 清单）
 *  - manifest.json：库元信息
 * 写盘一律 tmp + rename（pi-agent 凭据先例）；清理按 style 粒度删除单文件或整族目录。
 *
 * 设计取舍：
 *  - 哈希用 sha256 hex 前缀 32 字符（layout.ts）——跨进程确定性
 *  - readManifest 容错 = 坏文件按空库返（UI 列空库 + 手动重装）；不抛
 *  - writeManifest 调用方控制刷盘时机（批次安装收口处一次写）
 *  - deleteStyle/deleteFamily 同步删字节 + manifest 项；删空族不残留目录
 *  - 不与 font/variable.ts 共享字节读路径（服务进程跑在 node，opentype.js
 *    parse 同步 await；不阻塞 I/O）
 *  - 分片集合（subset-collection）原子写：每片 + index.json 落盘后调
 *    finalizeSubsetStyle 写 manifest 条目；任一环节失败不写 manifest——已落盘
 *    片由下次 deleteFamily 兜底清理
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
  slugifyFamilyName,
  subsetFamilyRelativeDir,
  subsetPieceRelativePath
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

/** 族内单 style 的分片索引项（与 client-fonts piece 端点契约一致） */
export interface SubsetIndexEntry {
  styleKey: string
  weight: number
  italic: boolean
  hash: ContentHash
  size: number
  ranges: Array<[number, number]>
}

/**
 * 分片集合族目录读出的索引结构——每族一个文件；
 * 端点按此结构服务 GET /api/pi/fonts/pieces?family= 端点。
 */
export interface SubsetIndex {
  family: string
  styles: SubsetIndexEntry[]
}

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
  /**
   * 分片集合落盘（写片 + index.json，不写 manifest）。
   * 调用方负责 validate / transcode / hash 计算；本方法只做原子写盘。
   * 同族重装前应先调 deleteFamily 清旧片——避免旧片 + 新片混杂。
   */
  installSubsetPieces(args: {
    family: string
    /** 各 style 索引（不含 manifest 字段） */
    entries: Array<{
      styleKey: string
      weight: number
      italic: boolean
      pieces: Array<{ bytes: Uint8Array; ranges: Array<[number, number]> }>
    }>
  }): {
    index: SubsetIndex
    /** 派生 manifest.hash 用：index.json 字节的 hex 摘要 */
    indexHash: ContentHash
  }
  /**
   * 读分片索引（pieces 端点用）。族不存在或非 subset-collection → null。
   * 索引文件解析失败按 null 返（坏文件不抛）。
   */
  readSubsetIndex(family: string): SubsetIndex | null
  /**
   * 读单片字节（piece 端点用）。族不存在 / 片不存在 → null。
   * 不做 hash 校验——端点已限定 hash 为 32 字符 hex（路径穿防护）。
   */
  readSubsetPiece(family: string, hash: ContentHash): Uint8Array | null
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
        } catch (err) {
          // 孤儿清理失败不阻断安装——字节泄漏留给下次族删除兜底
          console.warn(`[fonts-store] stale byte cleanup failed: ${stalePath}:`, err)
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
      } catch (err) {
        // 单目录删除失败不阻断——下面 manifest 删除独立
        console.warn(`[fonts-store] family dir cleanup failed: ${familyDir}:`, err)
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
        } catch (err) {
          // 单文件失败不阻断
          console.warn(`[fonts-store] stale style byte cleanup failed: ${absPath}:`, err)
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

  function subsetDirFor(family: string): string {
    return join(fontsRoot, subsetFamilyRelativeDir(family))
  }

  function installSubsetPieces(args: {
    family: string
    entries: Array<{
      styleKey: string
      weight: number
      italic: boolean
      pieces: Array<{ bytes: Uint8Array; ranges: Array<[number, number]> }>
    }>
  }): { index: SubsetIndex; indexHash: ContentHash } {
    ensureRoot()
    const familyDir = subsetDirFor(args.family)
    mkdirSync(familyDir, { recursive: true })
    const writtenHashes = new Set<ContentHash>()
    const indexEntries: SubsetIndexEntry[] = []
    for (const entry of args.entries) {
      for (const piece of entry.pieces) {
        const hash = hashBytesToHex(piece.bytes, sha256Hasher)
        if (!writtenHashes.has(hash)) {
          const relPath = subsetPieceRelativePath(args.family, hash)
          const absPath = join(fontsRoot, ...relPath.split('/'))
          const tmpPath = `${absPath}.tmp`
          writeFileSync(tmpPath, piece.bytes)
          renameSync(tmpPath, absPath)
          writtenHashes.add(hash)
        }
        // 同一 (styleKey, hash, weight, italic) 在 index 内不重复登记
        const alreadyRecorded = indexEntries.some(
          (existing) =>
            existing.styleKey === entry.styleKey &&
            existing.hash === hash &&
            existing.weight === entry.weight &&
            existing.italic === entry.italic
        )
        if (!alreadyRecorded) {
          indexEntries.push({
            styleKey: entry.styleKey,
            weight: entry.weight,
            italic: entry.italic,
            hash,
            size: piece.bytes.byteLength,
            ranges: piece.ranges
          })
        }
      }
    }
    const index: SubsetIndex = { family: args.family, styles: indexEntries }
    const indexJSON = JSON.stringify(index)
    const indexBytes = new Uint8Array(Buffer.from(indexJSON, 'utf8'))
    const indexPath = join(familyDir, 'index.json')
    const tmpIndex = `${indexPath}.tmp`
    writeFileSync(tmpIndex, indexBytes)
    renameSync(tmpIndex, indexPath)
    const indexHash = hashBytesToHex(indexBytes, sha256Hasher)
    return { index, indexHash }
  }

  function readSubsetIndex(family: string): SubsetIndex | null {
    const familyDir = subsetDirFor(family)
    const indexPath = join(familyDir, 'index.json')
    if (!existsSync(indexPath)) return null
    let raw: string
    try {
      raw = readFileSync(indexPath, 'utf8')
    } catch {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      const validated = validateSubsetIndex(parsed)
      if (!validated) return null
      return validated
    } catch {
      return null
    }
  }

  function readSubsetPiece(family: string, hash: ContentHash): Uint8Array | null {
    const relPath = subsetPieceRelativePath(family, hash)
    const absPath = join(fontsRoot, ...relPath.split('/'))
    if (!existsSync(absPath)) return null
    return readFileSync(absPath)
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
    hashBytes,
    installSubsetPieces,
    readSubsetIndex,
    readSubsetPiece
  }
}

// ── 内部 helper ──────────────────────────────────────────────────────

/** 单个 unicode range 校验：[number, number] 二元组。 */
function validateRange(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const low = value[0]
  const high = value[1]
  if (typeof low !== 'number' || typeof high !== 'number') return null
  return [low, high]
}

/** SubsetIndex 单条 style 校验。 */
function validateSubsetEntry(value: unknown): SubsetIndexEntry | null {
  if (!value || typeof value !== 'object') return null
  const s = value as {
    styleKey?: unknown
    weight?: unknown
    italic?: unknown
    hash?: unknown
    size?: unknown
    ranges?: unknown
  }
  if (
    typeof s.styleKey !== 'string' ||
    typeof s.weight !== 'number' ||
    typeof s.italic !== 'boolean' ||
    typeof s.hash !== 'string' ||
    typeof s.size !== 'number' ||
    !Array.isArray(s.ranges)
  ) {
    return null
  }
  const ranges: Array<[number, number]> = []
  for (const r of s.ranges) {
    const range = validateRange(r)
    if (!range) return null
    ranges.push(range)
  }
  return {
    styleKey: s.styleKey,
    weight: s.weight,
    italic: s.italic,
    hash: s.hash,
    size: s.size,
    ranges
  }
}

/** SubsetIndex 整体结构校验（family 字符串 + styles 数组，每条 schema 严格）。 */
function validateSubsetIndex(value: unknown): SubsetIndex | null {
  if (!value || typeof value !== 'object') return null
  const root = value as { family?: unknown; styles?: unknown }
  if (typeof root.family !== 'string') return null
  if (!Array.isArray(root.styles)) return null
  const styles: SubsetIndexEntry[] = []
  for (const item of root.styles) {
    const entry = validateSubsetEntry(item)
    if (!entry) return null
    styles.push(entry)
  }
  return { family: root.family, styles }
}

/** style 条目 → 库存扩展名（manifest 记录真实 ext，缺省 ttf） */
function extFromStyleEntry(style: StyleEntry): FontExtension {
  return style.ext ?? 'ttf'
}

// 重新导出以便端点层 import 单点
export type { ContentHash, FamilyEntry, FontExtension, ManifestFile, StyleEntry }
