/**
 * 字体字节深度校验。
 *
 * 形态：纯函数层（无 fs）。input = Uint8Array 字节流；output = 结构化 ok
 * / reject 枚举。不 throw（端点侧统一 try/catch 兜，但本模块绝不抛）。
 *
 * 校验链：
 *  1. 魔数识别：sfnt(0x00010000) / 'OTTO' / 'wOFF' / 'wOF2'——命中任一即容器
 *     形态已知；其它 → 拒（坏文件）
 *  2. .ttc/.otc 合集拒收（sfnt version = 'ttcf' / 'OTTO' 但 numTables 异常且
 *     目录读不出单 head 表 → 集合签名；最稳=409）
 *  3. 大小阈值（默认 60MB，调用方可注入 maxBytes 改阈值）——超限拒
 *  4. opentype.js parse（坏字节抛 → catch → reject 'corrupt'）
 *  5. fvar 嗅探（font/variable.ts sniffVariableFont）——VF 判定 + wght 区间
 *  6. name 表提取族名 + 样式名（Best Effort：英文名优先；缺则 locale-first）
 *
 * 设计取舍：
 *  - VF wght 区间直接复用 sniffVariableFont（已在字体域既有件），不在此处
 *    重复读 fvar 字节——reuse 单源
 *  - 大小阈值 = 入参注入（默认 60MB）；转码后计量口径，调用方在
 *    woff2 → ttf 转码完成后调用本函数
 *  - 'woff2' 通过 woff2 嗅探（'wOF2' 魔数 + 已知标签表 fvar=44）即可；
 *    opentype.js 2.0.0 不解 woff2 故走 sniffVariableFont 路径，不 parse
 */
import * as OpenTypeSync from 'opentype.js'

import { sniffVariableFont } from '#core/text/font/variable'

import type { FontExtension } from './layout'
import type { WghtRange } from './manifest'

/** 默认字节上限（转码后计量） */
export const DEFAULT_MAX_BYTES = 60 * 1024 * 1024

/** 容器格式（魔数判别产物） */
export type ContainerFormat = 'ttf' | 'otf' | 'woff' | 'woff2'

/** 拒绝原因枚举（端点统一映射为本地化文案） */
export type RejectionReason =
  | 'too-small' // 字节数 < 最小合理体积（10B）
  | 'too-large' // 字节数 > maxBytes
  | 'unknown-format' // 魔数不识
  | 'is-collection' // .ttc / .otc 合集
  | 'corrupt' // opentype.js 解析失败
  | 'no-name-table' // name 表缺失（极少见，但缺则族/样式名无法提）

/** 校验成功产物 */
export interface ValidationOk {
  ok: true
  container: ContainerFormat
  family: string
  displayName: string
  style: string
  /** 静态字体：单值 weight；VF：期望字重（渲染期注入点用） */
  weight: number
  italic: boolean
  variable: boolean
  wghtRange: WghtRange | null
}

/** 校验失败产物 */
export interface ValidationFail {
  ok: false
  reason: RejectionReason
  detail: string
  /** 命中魔数仍可推断的容器形态（仅 ok=false 时填）；unknown-format 时为 null */
  container: ContainerFormat | null
}

export type ValidationResult = ValidationOk | ValidationFail

// ── 公开入口 ─────────────────────────────────────────────────────────

export interface ValidateFontOptions {
  /** 字节上限（默认 60MB） */
  maxBytes?: number
}

/**
 * 字体字节深度校验入口。
 * 不 throw——所有失败包为 ValidationFail，由调用方映射文案。
 */
export function validateFontBytes(
  bytes: Uint8Array,
  options: ValidateFontOptions = {}
): ValidationResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (bytes.byteLength < 10) {
    return {
      ok: false,
      reason: 'too-small',
      detail: `font bytes too small to be a valid font: ${bytes.byteLength}`,
      container: null
    }
  }
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      reason: 'too-large',
      detail: `font bytes exceed ${maxBytes} (${(maxBytes / 1024 / 1024).toFixed(0)} MB) limit`,
      container: null
    }
  }

  // 合集签名探测：'ttcf'（0x74746366）独立于 ttf/otf/woff/woff2 魔数
  // 必须先于容器未知判别——ttc 字节头不命中已知容器，按 unknown-format 兜底会丢语义
  if (isTtcCollection(bytes)) {
    return {
      ok: false,
      reason: 'is-collection',
      detail: '.ttc collection files are not supported (extract individual fonts first)',
      container: 'ttf'
    }
  }

  const container = detectContainer(bytes)
  if (container === null) {
    return {
      ok: false,
      reason: 'unknown-format',
      detail: 'unsupported font format (magic bytes do not match ttf/otf/woff/woff2)',
      container: null
    }
  }

  // woff / woff2 不解 parse——走 sniffVariableFont 取 VF 区间，name 表无法读
  if (container === 'woff' || container === 'woff2') {
    // sniffVariableFont 内 try/catch 把 `new DataView(Uint8Array)` 吞成 variable=false；
    // 这里显式切片为 ArrayBuffer 确保正确读取字节
    const ab = toArrayBuffer(bytes)
    const info = sniffVariableFont(ab)
    return {
      ok: true,
      container,
      family: '',
      displayName: '',
      style: '',
      weight: 400,
      italic: false,
      variable: info.variable,
      wghtRange: info.wght ?? null
    }
  }

  // sfnt 容器（ttf + otf）走 opentype.js 全量 parse
  return parseWithOpentype(bytes, container)
}

// ── 容器识别 ─────────────────────────────────────────────────────────

/** 魔数检测。命中即返 ContainerFormat；不识 = null */
export function detectContainer(bytes: Uint8Array): ContainerFormat | null {
  if (bytes.byteLength < 4) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0)
  if (magic === 0x00010000) return 'ttf'
  if (magic === 0x4f54544f) return 'otf' // 'OTTO'
  if (magic === 0x774f4646) return 'woff' // 'wOFF'
  if (magic === 0x774f4632) return 'woff2' // 'wOF2'
  return null
}

/** .ttc 合集签名探测（sfnt version = 'ttcf'，ASCII 't','t','c','f' = 0x74746366） */
function isTtcCollection(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(0) === 0x74746366
}

// ── sfnt 容器 parse（opentype.js） ────────────────────────────────────

/** opentype.js parse 产物的最小消费面（包无官方 .d.ts，按消费面建模） */
interface OpentypeParsedFont {
  names?: unknown
  tables: { fvar?: unknown; head?: unknown }
}

/** opentype.js 同步 parse 入口的消费面模型 */
interface OpentypeParseEntry {
  parse(buffer: ArrayBuffer): OpentypeParsedFont
}

/** opentype.js v2 的 name 表平台分组形态（未校验中间形态） */
interface OpentypeNamePlatformGroups {
  unicode?: unknown
  macintosh?: unknown
  windows?: unknown
}

/** 平台组内字段形态（值为本地化字典 { lang: string }——fontFamily 存在性校验后收窄） */
interface OpentypeNameFields {
  fontFamily?: unknown
  fontSubfamily?: unknown
  preferredFamily?: unknown
  preferredSubfamily?: unknown
}

/** 收窄后的 name 表（跨平台组合并产物） */
interface OpentypeNameTables {
  fontFamily?: Record<string, string>
  fontSubfamily?: Record<string, string>
  preferredFamily?: Record<string, string>
  preferredSubfamily?: Record<string, string>
}

function parseWithOpentype(bytes: Uint8Array, container: ContainerFormat): ValidationResult {
  const slice = toArrayBuffer(bytes)
  let font: OpentypeParsedFont
  try {
    font = (OpenTypeSync as OpentypeParseEntry).parse(slice)
  } catch (error) {
    return {
      ok: false,
      reason: 'corrupt',
      detail: `opentype.js parse failed: ${error instanceof Error ? error.message : String(error)}`,
      container
    }
  }

  const names = extractNames(font.names)
  if (!names) {
    return {
      ok: false,
      reason: 'no-name-table',
      detail: 'font has no name table — family/style cannot be derived',
      container
    }
  }

  const family = readLocalizedName(names.preferredFamily ?? names.fontFamily ?? {})
  const displayName = family // 族名 = displayName（本地化族名一阶，无独立字段）
  const style = readLocalizedName(names.preferredSubfamily ?? names.fontSubfamily ?? {})
  if (family.length === 0) {
    return {
      ok: false,
      reason: 'no-name-table',
      detail: 'font name table is empty — family cannot be derived',
      container
    }
  }

  const info = sniffVariableFont(slice)
  // font/variable.ts wght 字段名（WghtRange 结构与本域 WghtRange 一致：min/default/max 数字字段）
  const wghtRange: WghtRange | null = info.wght
    ? { min: info.wght.min, default: info.wght.default, max: info.wght.max }
    : null

  // 静态 weight + italic：从 name 表提取的 subfamily 推断（粗粒度——只判 italic 关键字）
  const subfamilyLower = style.toLowerCase()
  const italic = /\bitalic\b/.test(subfamilyLower) || /\boblique\b/.test(subfamilyLower)
  const weight = parseWeightFromSubfamily(style) ?? 400

  // VF 族：以变量轴的 default 作为 weight 字段；下游排版期按 fontWeight 注入
  return {
    ok: true,
    container,
    family,
    displayName,
    style,
    weight: info.variable && wghtRange ? wghtRange.default : weight,
    italic: info.variable ? false : italic, // VF 的 italic 由 stat 轴承载，不从 subfamily 推断
    variable: info.variable,
    wghtRange
  }
}

// ── name 表本地化解析 ────────────────────────────────────────────────

/** opentype.js v2 的 name 表形态：按平台分组（unicode/macintosh/windows），
 * 每组内键为字段名（fontFamily 等）、值为 { lang: string } 本地化字典。
 * 多数真实字体只有 windows 组——本函数跨平台组合并取首个含 fontFamily 的组。
 */
function extractNames(names: unknown): OpentypeNameTables | null {
  if (names === null || typeof names !== 'object') return null
  const groups = names as OpentypeNamePlatformGroups
  for (const key of ['unicode', 'macintosh', 'windows'] as const) {
    const group = groups[key]
    if (group === null || typeof group !== 'object') continue
    const g = group as OpentypeNameFields
    if (g.fontFamily !== null && typeof g.fontFamily === 'object') {
      return g as OpentypeNameTables
    }
  }
  return null
}

/**
 * Uint8Array → ArrayBuffer 切片拷贝。
 * `bytes.buffer.slice()` 在 TypeScript 下返回 `ArrayBuffer | SharedArrayBuffer`，
 * 而 sniffVariableFont / opentype.js 签名只收 ArrayBuffer——此 helper 收口。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * 从 LocalizedName 字典（{ lang: string }）取最优先条目。
 * 优先级：en-US > en > 任意 lang 取首非空。空字典 = ''。
 */
function readLocalizedName(localized: Record<string, string> | undefined): string {
  if (!localized) return ''
  if (typeof localized['en-US'] === 'string' && localized['en-US'].length > 0)
    return localized['en-US']
  if (typeof localized.en === 'string' && localized.en.length > 0) return localized.en
  for (const value of Object.values(localized)) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

// ── weight 关键字推断（静态字体） ────────────────────────────────────

/**
 * 从 subfamily 字符串粗略推断 weight 值。
 * 仅覆盖标准命名（Thin/ExtraLight/Light/Regular/Medium/SemiBold/Bold/
 * ExtraBold/Heavy/Black）；未命中 = null（默认 weight 400）。
 */
function parseWeightFromSubfamily(subfamily: string): number | null {
  const lower = subfamily.toLowerCase()
  if (lower.includes('thin')) return 100
  if (lower.includes('extralight') || lower.includes('ultra light')) return 200
  if (lower.includes('light')) return 300
  if (lower.includes('medium')) return 500
  if (lower.includes('semibold') || lower.includes('demibold')) return 600
  if (lower.includes('extrabold') || lower.includes('heavy')) return 800
  if (lower.includes('black')) return 900
  if (lower.includes('bold')) return 700
  if (lower.includes('regular') || lower.includes('normal') || lower.includes('book')) return 400
  return null
}

// ── 内部类型 re-export（端点/测试便于 import 单点） ──────────────────

/** 容许的扩展名白名单（layout.ts 也导此集合；此处仅用于端点校验） */
export const ACCEPTED_EXTENSIONS: readonly FontExtension[] = [
  'ttf',
  'otf',
  'woff',
  'woff2'
] as const
