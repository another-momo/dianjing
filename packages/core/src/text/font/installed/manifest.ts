/**
 * 应用字体库清单 schema。
 *
 * 形态：纯逻辑层（无 fs / 无 opentype 调用）。库 = 「装在本机的字体」单一真相，
 * 库存字节与 manifest 落 rootDir/fonts/v1/（layout.ts 推导路径）。
 *
 * 序列化层 —— 两形态：
 *  - manifest.json（disk 落盘）= ManifestFile，扁平结构（每族 → entries[]，
 *    按 family 折叠在消费侧聚合视图聚合）
 *  - ListFamilyOptions（API 返前端）= FamilyView，family 聚合视图
 *
 * Schema 设计要点：
 *  - 每条按 family + style 折叠，独立条目（同族不同字节按 style 粒度可并存）
 *  - VF 用 wght 区间描述（{min, max, default}）；静态字体 weight 字段填单值
 *  - hash = 内容哈希（sha256 前缀，hex 字符串），去重与文件名推导双用
 *  - artifact 标 'full' | 'subset-collection' 双 artifact 模型
 *  - installedAt epoch ms
 *
 * schema 版本：MANIFEST_VERSION=1——单仓内单源，破坏性变更升 v2（manifest.parse
 * 按 version 字段分派；v1 旧版读不到任何字段直接返 ok=false）。
 */
import { hashBytesToHex, type ContentHash } from './layout'

export const MANIFEST_VERSION = 1

/** 字体 artifact 形态 */
export type ArtifactKind = 'full' | 'subset-collection'

/** 内容哈希字符串（layout.hashContent 决定，本域用前缀 hex） */
export type FontHash = ContentHash

/** VF wght 轴区间（min ≤ default ≤ max） */
export interface WghtRange {
  min: number
  default: number
  max: number
}

/**
 * 单条 = 一族内一 style 实体。
 * 静态字体：weight 单值 + variable=false + 无 wghtRange
 * VF：weight = 渲染期期望字重（缺省取 wghtRange.default）；variable=true + wghtRange 必填
 */
export interface StyleEntry {
  /** 族内唯一 style 键（如 'Regular' / 'Bold' / 'Medium Italic'） */
  key: string
  weight: number
  italic: boolean
  variable: boolean
  /** VF 必填；静态字体 omit */
  wghtRange?: WghtRange
  hash: FontHash
  /** 库存文件扩展名（sfnt-only：ttf/otf；缺省 ttf） */
  ext?: 'ttf' | 'otf'
  /** 文件字节数（转码后计量） */
  size: number
  artifact: ArtifactKind
  /** 来源标记：'local-file' = 本地文件安装；'store' = 商店安装；批次后续可扩 */
  source: 'local-file' | 'store'
  installedAt: number
}

/** 一族 = 族名 + 一组 styles + 选填本地化显示名（多语种族名场景） */
export interface FamilyEntry {
  family: string
  /** name table 提取的本地化族名（UI 展示用，非身份键） */
  displayName?: string
  styles: StyleEntry[]
}

/** disk 形态：根 { version, updatedAt, families[] } */
export interface ManifestFile {
  version: typeof MANIFEST_VERSION
  updatedAt: number
  families: FamilyEntry[]
}

/** 家族聚合视图（API 返前端） */
export interface FamilyView {
  family: string
  displayName?: string
  styles: {
    key: string
    weight: number
    italic: boolean
    variable: boolean
    wghtRange?: WghtRange
    /** subset-collection 族免探测直读——read 端点对 subset 返 501，调用方按本字段分流 */
    artifact: ArtifactKind
  }[]
  totalSize: number
  installedAt: number
}

// ── 序列化 ───────────────────────────────────────────────────────────

/**
 * 序列化为 JSON 字符串。updatedAt 由调用方注入（避免非确定性时间入账）。
 * 不做缩进（带宽小、落盘频次低；落地经由 JSON.parse 即可）。
 */
export function serializeManifest(manifest: ManifestFile): string {
  return JSON.stringify(manifest)
}

// ── 解析 / 校验 ──────────────────────────────────────────────────────

/**
 * 解析 JSON 字节串为 ManifestFile。
 * 校验失败返 ok=false + reason；不 throw——全部结构化结果，不抛错给调用方。
 */
export type ParseFailureReason = 'invalid-json' | 'bad-version' | 'bad-shape' | 'bad-entry'

export type ParseResult =
  | { ok: true; manifest: ManifestFile }
  | { ok: false; reason: ParseFailureReason; detail: string }

export function parseManifest(json: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid-json',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  return validateManifest(raw)
}

/**
 * 校验未知对象为 ManifestFile 形状。返回 ok 包裹的 manifest 或 ok=false。
 * 校验深度：
 *  - version === 1（MANIFEST_VERSION）；否则 bad-version
 *  - families: array；每族 family: string；styles: array
 *  - styles 每条：key: string；weight: number ∈ [1, 1000]；hash: string；
 *    size: number ≥ 0；artifact ∈ {'full','subset-collection'}；
 *    source ∈ {'local-file','store'}；installedAt: number
 *  - 越严格 = 坏文件越早暴露为「无法读」而非「字段缺失」
 */
export function validateManifest(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'bad-shape', detail: 'manifest must be an object' }
  }
  const r = raw as Record<string, unknown>
  if (r.version !== MANIFEST_VERSION) {
    return {
      ok: false,
      reason: 'bad-version',
      detail: `unsupported manifest version: ${String(r.version)} (expected ${MANIFEST_VERSION})`
    }
  }
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) {
    return { ok: false, reason: 'bad-shape', detail: 'updatedAt must be a finite number' }
  }
  if (!Array.isArray(r.families)) {
    return { ok: false, reason: 'bad-shape', detail: 'families must be an array' }
  }
  const families: FamilyEntry[] = []
  for (let i = 0; i < r.families.length; i++) {
    const familyResult = validateFamilyMember(r.families[i], i)
    if (!familyResult.ok) return familyResult
    families.push(familyResult.family)
  }
  return { ok: true, manifest: { version: MANIFEST_VERSION, updatedAt: r.updatedAt, families } }
}

function validateFamilyMember(
  raw: unknown,
  index: number
): { ok: true; family: FamilyEntry } | { ok: false; reason: 'bad-entry'; detail: string } {
  if (raw === null || typeof raw !== 'object') {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${index}] must be an object`
    }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.family !== 'string' || r.family.length === 0) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${index}].family must be a non-empty string`
    }
  }
  if (!Array.isArray(r.styles)) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${index}].styles must be an array`
    }
  }
  let displayName: string | undefined
  if (r.displayName !== undefined) {
    if (typeof r.displayName !== 'string') {
      return {
        ok: false,
        reason: 'bad-entry',
        detail: `families[${index}].displayName must be a string when present`
      }
    }
    displayName = r.displayName
  }
  const styles: StyleEntry[] = []
  for (let j = 0; j < r.styles.length; j++) {
    const styleResult = validateStyleMember(r.styles[j], index, j)
    if (!styleResult.ok) return styleResult
    styles.push(styleResult.style)
  }
  const family: FamilyEntry = {
    family: r.family,
    styles
  }
  if (displayName !== undefined) family.displayName = displayName
  return { ok: true, family }
}

function validateStyleMember(
  raw: unknown,
  familyIndex: number,
  styleIndex: number
): { ok: true; style: StyleEntry } | { ok: false; reason: 'bad-entry'; detail: string } {
  if (raw === null || typeof raw !== 'object') {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}] must be an object`
    }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.key !== 'string' || r.key.length === 0) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].key must be a non-empty string`
    }
  }
  if (typeof r.weight !== 'number' || !Number.isFinite(r.weight)) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].weight must be a finite number`
    }
  }
  if (r.weight < 1 || r.weight > 1000) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].weight out of range [1,1000]: ${r.weight}`
    }
  }
  if (typeof r.italic !== 'boolean') {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].italic must be a boolean`
    }
  }
  if (typeof r.variable !== 'boolean') {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].variable must be a boolean`
    }
  }
  if (r.variable) {
    if (r.wghtRange === undefined) {
      return {
        ok: false,
        reason: 'bad-entry',
        detail: `families[${familyIndex}].styles[${styleIndex}].wghtRange required for variable font`
      }
    }
    const wght = validateWghtRange(r.wghtRange, familyIndex, styleIndex)
    if (!wght.ok) return wght
  } else if (r.wghtRange !== undefined) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].wghtRange forbidden for static font`
    }
  }
  if (typeof r.hash !== 'string' || r.hash.length === 0) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].hash must be a non-empty string`
    }
  }
  if (typeof r.size !== 'number' || !Number.isFinite(r.size) || r.size < 0) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].size must be a non-negative finite number`
    }
  }
  if (r.artifact !== 'full' && r.artifact !== 'subset-collection') {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].artifact must be 'full' or 'subset-collection'`
    }
  }
  if (r.source !== 'local-file' && r.source !== 'store') {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].source must be 'local-file' or 'store'`
    }
  }
  if (r.ext !== undefined && r.ext !== 'ttf' && r.ext !== 'otf') {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].ext must be 'ttf' or 'otf' when present`
    }
  }
  if (typeof r.installedAt !== 'number' || !Number.isFinite(r.installedAt)) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].installedAt must be a finite number`
    }
  }
  const style: StyleEntry = {
    key: r.key,
    weight: r.weight,
    italic: r.italic,
    variable: r.variable,
    hash: r.hash,
    size: r.size,
    artifact: r.artifact,
    source: r.source,
    installedAt: r.installedAt
  }
  if (r.ext !== undefined) style.ext = r.ext
  if (r.variable && r.wghtRange !== undefined) {
    style.wghtRange = r.wghtRange as WghtRange
  }
  return { ok: true, style }
}

function validateWghtRange(
  raw: unknown,
  familyIndex: number,
  styleIndex: number
): { ok: true; range: WghtRange } | { ok: false; reason: 'bad-entry'; detail: string } {
  if (raw === null || typeof raw !== 'object') {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].wghtRange must be an object`
    }
  }
  const r = raw as Record<string, unknown>
  for (const key of ['min', 'default', 'max'] as const) {
    if (typeof r[key] !== 'number' || !Number.isFinite(r[key])) {
      return {
        ok: false,
        reason: 'bad-entry',
        detail: `families[${familyIndex}].styles[${styleIndex}].wghtRange.${key} must be a finite number`
      }
    }
  }
  const min = r.min as number
  const def = r.default as number
  const max = r.max as number
  if (!(min <= def && def <= max)) {
    return {
      ok: false,
      reason: 'bad-entry',
      detail: `families[${familyIndex}].styles[${styleIndex}].wghtRange violates min<=default<=max`
    }
  }
  return { ok: true, range: { min, default: def, max } }
}

// ── 聚合 / 改写工具 ──────────────────────────────────────────────────

/** 磁盘形态 → 家族聚合视图（API 返前端）。空族不进输出。 */
export function toFamilyViews(manifest: ManifestFile): FamilyView[] {
  const views: FamilyView[] = []
  for (const family of manifest.families) {
    if (family.styles.length === 0) continue
    const styles = family.styles.map((s) => {
      const out: FamilyView['styles'][number] = {
        key: s.key,
        weight: s.weight,
        italic: s.italic,
        variable: s.variable,
        artifact: s.artifact
      }
      if (s.wghtRange) out.wghtRange = s.wghtRange
      return out
    })
    let totalSize = 0
    let installedAt = 0
    for (const s of family.styles) {
      totalSize += s.size
      if (s.installedAt > installedAt) installedAt = s.installedAt
    }
    const view: FamilyView = {
      family: family.family,
      styles,
      totalSize,
      installedAt
    }
    if (family.displayName !== undefined) view.displayName = family.displayName
    views.push(view)
  }
  return views
}

/** 在 manifest 内按 family 查找条目索引；不存在返 -1 */
export function findFamilyIndex(manifest: ManifestFile, family: string): number {
  for (let i = 0; i < manifest.families.length; i++) {
    if (manifest.families[i].family === family) return i
  }
  return -1
}

/** 在族内按 style key 查找条目索引；不存在返 -1 */
export function findStyleIndex(family: FamilyEntry, styleKey: string): number {
  for (let i = 0; i < family.styles.length; i++) {
    if (family.styles[i].key === styleKey) return i
  }
  return -1
}

/**
 * 应用一次安装：upsert 条目（同 family + 同 key 抹旧、新版覆盖；新增则追加）。
 * 不动 updatedAt——调用方在收口时统一刷（合并批安装时一次性刷）。
 */
export function upsertStyle(
  manifest: ManifestFile,
  family: string,
  style: StyleEntry,
  displayName?: string
): void {
  const familyIndex = findFamilyIndex(manifest, family)
  if (familyIndex === -1) {
    const entry: FamilyEntry = { family, styles: [style] }
    if (displayName !== undefined) entry.displayName = displayName
    manifest.families.push(entry)
    return
  }
  const existing = manifest.families[familyIndex]
  if (displayName !== undefined) existing.displayName = displayName
  const styleIndex = findStyleIndex(existing, style.key)
  if (styleIndex === -1) {
    existing.styles.push(style)
    return
  }
  existing.styles[styleIndex] = style
}

/**
 * 删除整族。返是否实际删除（false = 族不存在）。
 * 库内可能残留的字节文件由调用方按 layout 推路径清理——本函数不碰 fs。
 */
export function removeFamily(manifest: ManifestFile, family: string): boolean {
  const familyIndex = findFamilyIndex(manifest, family)
  if (familyIndex === -1) return false
  manifest.families.splice(familyIndex, 1)
  return true
}

/**
 * 删除某族内的某 style。返是否实际删除（false = 不存在）。
 * 若删后族内 styles 空——族也一并删除（不留空壳）。
 */
export function removeStyle(manifest: ManifestFile, family: string, styleKey: string): boolean {
  const familyIndex = findFamilyIndex(manifest, family)
  if (familyIndex === -1) return false
  const entry = manifest.families[familyIndex]
  const styleIndex = findStyleIndex(entry, styleKey)
  if (styleIndex === -1) return false
  entry.styles.splice(styleIndex, 1)
  if (entry.styles.length === 0) manifest.families.splice(familyIndex, 1)
  return true
}

// ── 便利工厂 ─────────────────────────────────────────────────────────

/** 空 manifest 工厂 */
export function emptyManifest(now: number): ManifestFile {
  return { version: MANIFEST_VERSION, updatedAt: now, families: [] }
}

// 重新导出以避免消费方再 import 一份 layout.ts
export { hashBytesToHex }
