/**
 * 库存布局纯逻辑。
 *
 * 形态：纯函数层（无 fs）。layout = 「已知根目录 + 内容哈希 + 形态」推导
 * 字节文件落点；端点侧写盘、卸载清理、UI 展示共用。
 *
 * 双 artifact 库存布局：
 *  - 全量单文件（'full'）：rootDir/fonts/v1/<哈希前 2 位>/<内容哈希>.<扩展名>
 *  - 分片集合（'subset-collection'）：rootDir/fonts/v1/<族>/<片哈希>.ttf
 *
 * 命名口径（hashContent）：sha256（节点 crypto.subtle / webcrypto），截前缀 32
 * hex 字符（128 bit）足以抗碰撞。命中冲突概率 1/2^128（合法字体库规模远
 * 远不到该数量级）。hash 字段在 manifest 内序列化即用此 hex。
 *
 * 路径拼接：手工 '/' 分隔（避开 node:path 在浏览器形态下的依赖）——
 * 该模块在 core/text 域被端点侧 import，而 core 域是平台无关的纯逻辑。
 * 落盘点盘端（pi-backend 服务端）可经 posix 拼接后 node:fs 处理；端点
 * 侧负责 posix → 平台 native 转换（cross-platform join）。
 */
import type { ArtifactKind } from './manifest'

/** 库存根子目录名 */
export const FONTS_ROOT_SUBDIR = 'fonts'
/** 库存 schema 版本（v1）——未来 v2 加 v2/ 段，原 v1/ 不动 */
export const FONTS_SCHEMA_VERSION = 'v1'

/** 内容哈希类型：32 hex 字符（sha256 前缀） */
export type ContentHash = string

/** 文件扩展名字面量（设计稿接受 + 无形变 → 库存扩展名集合） */
export type FontExtension = 'ttf' | 'otf' | 'woff' | 'woff2'

/**
 * 把 ArrayBuffer / Uint8Array 摘要为 hex。
 * 跨平台：调用方注入实现（node:crypto / webcrypto），本模块不直接依赖
 * node 内置——保持纯逻辑层（端点使用方传入 node 实现即可）。
 */
export type Hasher = (bytes: Uint8Array) => string

/** 落点相对根路径 = posix 形态（前端 read / 后端写均安全） */
export interface LayoutPaths {
  /** 全量单文件相对根 posix 路径（artifact='full' 时填） */
  full: string | null
  /** 分片目录相对根 posix 路径（artifact='subset-collection' 时填） */
  subsetFamilyDir: string | null
}

/**
 * 库根目录解析：rootDir/fonts/v1/。
 * 输入绝对或相对 rootDir，返绝对 posix 字符串——调用方需自行保证 rootDir
 * 已正常化（路径分支语义在 store 层处理）。
 */
export function resolveFontsRoot(rootDir: string): string {
  const trimmed = rootDir.replace(/\/+$/, '')
  return `${trimmed}/${FONTS_ROOT_SUBDIR}/${FONTS_SCHEMA_VERSION}`
}

/**
 * 给定内容哈希与形态，导出全部相关路径。
 * 形态为 'full' 时填 full（subsetFamilyDir=null）；'subset-collection' 时
 * 反之——调用方按需取对应字段。
 */
export function layoutFor(artifact: ArtifactKind, hash: ContentHash, family?: string): LayoutPaths {
  if (artifact === 'full') {
    return {
      full: `${hash.slice(0, 2)}/${hash}.ttf`,
      subsetFamilyDir: null
    }
  }
  if (!family || family.length === 0) {
    throw new Error('subset-collection layout requires non-empty family')
  }
  // 族目录 = 族名 slug；族目录内放片
  const familySlug = slugifyFamilyName(family)
  return {
    full: null,
    subsetFamilyDir: familySlug
  }
}

/** 给定内容哈希与扩展名，导出全量单文件的相对 posix 路径 */
export function fullFontRelativePath(hash: ContentHash, ext: FontExtension): string {
  return `${hash.slice(0, 2)}/${hash}.${ext}`
}

/**
 * 给定族名 + 片哈希，导出分片文件的相对 posix 路径。
 * 扩展名恒 ttf（分片族入库前统一转码 ttf）。
 */
export function subsetPieceRelativePath(family: string, pieceHash: ContentHash): string {
  const familySlug = slugifyFamilyName(family)
  return `${familySlug}/${pieceHash}.ttf`
}

// ── 哈希辅助 ─────────────────────────────────────────────────────────

/**
 * 默认 hasher（node:crypto 注入形态——本模块不内置实现）。
 * 端点侧 import 时包装 node:crypto.createHash('sha256') 即可：
 *   const hasher: Hasher = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 32)
 */
export function hashBytesToHex(bytes: Uint8Array, hasher: Hasher): ContentHash {
  return hasher(bytes).slice(0, 32)
}

// ── 内部：族名归一化（目录安全） ────────────────────────────────────

/**
 * 族名 → 目录安全 slug：
 *  - ASCII 小写字母/数字/连字符/下划线原样保留（大小写折叠）
 *  - 其他字符按 UTF-8 字节流百分号编码（'~xNN' 形态——'~' 不在白名单字符集内，
 *    编码可逆无歧义；用 '~' 而非 '%' 因为 % 在 Windows 部分 API 语义过载）
 *  - 连续连字符折叠单、头尾剥
 *  - 全不可编码字符（如纯符号）兜 'family'
 *
 * 唯一性：不同族名（哪怕全是 CJK）产生不同 slug——'思源黑体' 与 '平方江西黑'
 * 不再坍缩到同一目录。
 */
export function slugifyFamilyName(family: string): string {
  const lowered = family.toLowerCase()
  let out = ''
  for (const char of lowered) {
    if (/[a-z0-9_-]/.test(char)) {
      out += char
      continue
    }
    // 空白与标点归入连字符（与原语义一致：'Noto Sans SC' → 'noto-sans-sc'）
    if (/[\s\p{P}\p{S}]/u.test(char)) {
      out += '-'
      continue
    }
    // 其余（CJK 等文字字符）按 UTF-8 字节流 ~xNN 编码——可逆且唯一，
    // 不同 CJK 族名不再坍缩到同一目录
    const bytes = new TextEncoder().encode(char)
    for (const byte of bytes) {
      out += `~x${byte.toString(16).padStart(2, '0')}`
    }
  }
  const collapsed = out.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return collapsed.length > 0 ? collapsed : 'family'
}
