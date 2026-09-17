/**
 * T54（Phase 3 W2/T-B3）：generate_image 请求纯函数层——自 open-pencil 仓
 * feature/agent-backend @ 5d38aa4e 的 tools/image-gen/requests.ts 移植。
 *
 * 职责：尺寸归一（16px 对齐 + 边长/纵横比/像素数钳制，保宽高比）与
 * requests 参数解析（枚举校验、别名归一、references 形状；T66 起原生
 * 数组直通 + 字符串宽容解析双通道）。
 * 纯函数、零 figma/graph 依赖——后端编排与 core 落图段共用本层。
 *
 * 与源的差异：
 * - ImageGen* 类型从源 providers.ts 上移本文件（双段执行下 provider 在
 *   pi-backend 进程，core 不 import provider 面，类型单源放纯函数层）
 * - parseJSONArrayParam 内联为本文件私有函数（目标仓无 #core/tools/json-array；
 *   语义逐字保留：destr 快路径 + 尾部垃圾打捞，__proto__ 拒绝）
 */

import { safeDestr } from 'destr'

export type ImageGenQuality = 'low' | 'medium' | 'high' | 'auto'
export type ImageGenFormat = 'png' | 'jpeg' | 'webp'
export type ImageGenBackground = 'auto' | 'opaque' | 'transparent'
/**
 * Per-provider transparency capability declaration. `api` = provider exposes
 * OpenAI-style `background` parameter; `local` = provider does not support
 * native transparency, generate.ts must inject prompt + run key-color post
 * processing locally.
 */
export type ImageGenTransparentSupport = 'api' | 'local'

export interface ImageGenReference {
  id: string
  /**
   * Reference the node's RENDERED appearance (children, effects, rounded
   * corners included) instead of its original IMAGE bytes (JSON param
   * `composite`; legacy alias `asImage`). Only meaningful for nodes that
   * already have an IMAGE fill — nodes without one are always rendered.
   */
  composite?: boolean
}

export interface ImageGenRequest {
  /**
   * Output target: the node whose fill the generated image replaces
   * (JSON param `replace_id`; legacy alias `id`). Omit → create a new node.
   */
  replaceId?: string
  prompt: string
  /** Required for new images; for targeted requests it is read from the target node when omitted. */
  width?: number
  height?: number
  quality?: ImageGenQuality
  outputFormat?: ImageGenFormat
  /** JPEG/WebP compression 0-100; only sent when output_format is jpeg/webp. */
  outputCompression?: number
  background?: ImageGenBackground
  /**
   * Agent-facing transparency toggle. true = request a transparent background
   * (api path → wire background='transparent'; local path → prompt key-color
   * injection + post-process). false = request opaque. Omitted = provider default.
   */
  transparent_background?: boolean
  /** The only source of input images; extracted by apply.ts before the call. */
  references?: ImageGenReference[]
}

export interface ImageGenResult {
  bytes: Uint8Array
  width: number
  height: number
}

/**
 * Provider 接口槽（S4 T-B3 路线乙：自写 OpenAI 兼容 provider 为核心——
 * T66 起去 DMX 命名，实现与任何特定中转商无关；pi-ai generateImages 为
 * 扩展位——扩展位契约见 spikes/probes/sp/a1-images-contract.mjs 钉扎，
 * 本任务不实现）。core 仅声明形状，实现在 src/app/ai/pi-backend/image-gen/
 * （凭证不出后端进程）。
 */
export interface ImageGenProvider {
  name: string
  /**
   * Capability declaration for `transparent_background` requests. `api` means
   * the provider exposes a native transparency channel (OpenAI-style `background`
   * parameter); `local` means the provider cannot deliver transparency natively
   * and generate.ts must inject prompt + post-process locally.
   */
  transparentSupport: ImageGenTransparentSupport
  /**
   * @param req the generation/edit request
   * @param images input images extracted from `req.references`. Empty/absent →
   *               generations endpoint (text-to-image); non-empty → edits
   *               endpoint, sent as multipart `image[]` fields
   */
  generate(req: ImageGenRequest, images?: Uint8Array[]): Promise<ImageGenResult>
}

// ── lenient JSON array param parsing（源 tools/json-array.ts 语义逐字） ──

export interface JSONArrayParam {
  items: unknown[]
  warning?: string
}

const INSIGNIFICANT_TAIL = /^[\s"',}]*$/

function tryParse(text: string, strictJSON: boolean): unknown {
  try {
    return strictJSON ? JSON.parse(text) : safeDestr(text)
  } catch {
    return undefined
  }
}

/**
 * Models sometimes emit a valid JSON array with trailing garbage (stray
 * quotes/braces from double-closing the tool-call string). Strict parsing
 * fails and the model retries the identical payload, burning steps. Salvage
 * by trimming to the last ']' when — and only when — the trimmed tail is
 * insignificant (whitespace, quotes, braces, commas), so payloads corrupted
 * in the middle still fail loudly instead of being silently truncated.
 */
function parseJSONArrayParam(raw: unknown, label: string): JSONArrayParam | { error: string } {
  // T66 P4：工具 schema 化后运行时直接交付数组（pi validateToolArguments 已
  // 校验形状）——原生数组直通；字符串输入走旧宽容解析（兼容降级，保留
  // 尾部垃圾打捞语义，供字符串形态的调用方/旧测试路径使用）。
  if (Array.isArray(raw)) {
    return { items: raw }
  }
  const text = String(raw)
  const parsed = tryParse(text, false)
  if (parsed !== undefined) {
    return { items: Array.isArray(parsed) ? parsed : [parsed] }
  }

  const lastBracket = text.lastIndexOf(']')
  if (
    lastBracket > 0 &&
    INSIGNIFICANT_TAIL.test(text.slice(lastBracket + 1)) &&
    !text.includes('__proto__')
  ) {
    const salvaged = tryParse(text.slice(0, lastBracket + 1), true)
    if (Array.isArray(salvaged)) {
      return {
        items: salvaged,
        warning: `Trailing garbage after the JSON array in ${label} was ignored — send exactly one JSON value.`
      }
    }
  }
  return { error: `Invalid JSON in ${label}` }
}

// ── 尺寸归一（源 gpt_image_playground/src/lib/size.ts 移植链，逐字） ──

const SIZE_MULTIPLE = 16
const MAX_EDGE = 3840
const MAX_ASPECT_RATIO = 3
const MIN_PIXELS = 655_360
const MAX_PIXELS = 8_294_400

function roundToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.round(value / multiple) * multiple)
}

function floorToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.floor(value / multiple) * multiple)
}

function ceilToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple)
}

/**
 * Preserves the requested aspect ratio and only clips to platform
 * constraints. The loop converges because constraints can conflict (e.g.
 * ratio clipping can drop below the pixel floor, which then re-triggers
 * the ratio constraint).
 */
export function normalizeDimensions(width: number, height: number) {
  let normalizedWidth = roundToMultiple(width, SIZE_MULTIPLE)
  let normalizedHeight = roundToMultiple(height, SIZE_MULTIPLE)

  const scaleToFit = (scale: number) => {
    normalizedWidth = floorToMultiple(normalizedWidth * scale, SIZE_MULTIPLE)
    normalizedHeight = floorToMultiple(normalizedHeight * scale, SIZE_MULTIPLE)
  }

  const scaleToFill = (scale: number) => {
    normalizedWidth = ceilToMultiple(normalizedWidth * scale, SIZE_MULTIPLE)
    normalizedHeight = ceilToMultiple(normalizedHeight * scale, SIZE_MULTIPLE)
  }

  for (let i = 0; i < 4; i++) {
    const maxEdge = Math.max(normalizedWidth, normalizedHeight)
    if (maxEdge > MAX_EDGE) {
      scaleToFit(MAX_EDGE / maxEdge)
    }

    if (normalizedWidth / normalizedHeight > MAX_ASPECT_RATIO) {
      normalizedWidth = floorToMultiple(normalizedHeight * MAX_ASPECT_RATIO, SIZE_MULTIPLE)
    } else if (normalizedHeight / normalizedWidth > MAX_ASPECT_RATIO) {
      normalizedHeight = floorToMultiple(normalizedWidth * MAX_ASPECT_RATIO, SIZE_MULTIPLE)
    }

    const pixels = normalizedWidth * normalizedHeight
    if (pixels > MAX_PIXELS) {
      scaleToFit(Math.sqrt(MAX_PIXELS / pixels))
    } else if (pixels < MIN_PIXELS) {
      scaleToFill(Math.sqrt(MIN_PIXELS / pixels))
    }
  }

  return { width: normalizedWidth, height: normalizedHeight }
}

interface NormalizedSize {
  width: number
  height: number
  adjusted: boolean
}

export function normalizeSize(width: number, height: number): NormalizedSize | { error: string } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { error: `Invalid size ${width}x${height}` }
  }
  const normalized = normalizeDimensions(width, height)
  const adjusted =
    normalized.width !== Math.round(width) || normalized.height !== Math.round(height)
  return { width: normalized.width, height: normalized.height, adjusted }
}

export interface ParsedImageGenRequests {
  requests: ImageGenRequest[]
  sizeNote?: string
  warning?: string
}

// Keep these in sync with the ImageGen* union types above.
const QUALITY_VALUES: readonly ImageGenQuality[] = ['low', 'medium', 'high', 'auto']
const QUALITY_ALIASES: Record<string, ImageGenQuality> = { hd: 'auto' }
const OUTPUT_FORMAT_VALUES: readonly ImageGenFormat[] = ['png', 'jpeg', 'webp']
const BACKGROUND_VALUES: readonly ImageGenBackground[] = ['auto', 'opaque']

/**
 * Validate an enum-like request param locally instead of letting the provider
 * reject it. Values are case-insensitive; aliases are normalized silently.
 * Returns undefined when the param is absent.
 */
function parseEnumParam<T extends string>(
  name: string,
  value: unknown,
  values: readonly T[],
  aliases?: Record<string, T>
): T | undefined | { error: string } {
  if (value === undefined || value === null) return undefined
  const raw = typeof value === 'string' ? value.toLowerCase() : ''
  const normalized = aliases?.[raw] ?? raw
  if ((values as readonly string[]).includes(normalized)) return normalized as T
  const aliasList = Object.entries(aliases ?? {})
    .map(([alias, target]) => `"${alias}" → "${target}"`)
    .join(', ')
  const aliasNote = aliasList ? ` (aliases: ${aliasList})` : ''
  return {
    error: `Invalid ${name} ${JSON.stringify(value)} — expected one of: ${values.join(', ')}${aliasNote}`
  }
}

export function parseReferences(value: unknown): ImageGenReference[] | { error: string } {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return { error: '"references" must be an array of node ids' }
  interface RawReference {
    id?: unknown
    composite?: unknown
    asImage?: unknown
  }
  const out: ImageGenReference[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      out.push({ id: item })
      continue
    }
    if (item && typeof item === 'object') {
      const raw = item as RawReference
      if (typeof raw.id === 'string' && raw.id.trim().length > 0) {
        // `composite` is canonical; `asImage` is accepted as a legacy alias.
        const composite = raw.composite === true || raw.asImage === true
        out.push(composite ? { id: raw.id, composite: true } : { id: raw.id })
        continue
      }
    }
    return {
      error: 'Each reference must be a node id string or { "id": "...", "composite"?: true }'
    }
  }
  return out
}

interface RawRequest {
  replace_id?: unknown
  id?: unknown
  prompt?: unknown
  width?: unknown
  height?: unknown
  quality?: unknown
  output_format?: unknown
  output_compression?: unknown
  background?: unknown
  transparent_background?: unknown
  references?: unknown
}

/** transparent_background：严格 boolean 或 undefined。typebox schema 的
 * additionalProperties:false 拦不到解析层，故在此显式闸（与 schema 同规则）。 */
function parseTransparentBackground(raw: unknown): boolean | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'boolean') {
    return { error: `Invalid transparent_background ${JSON.stringify(raw)} — expected boolean` }
  }
  return raw
}

/** Parse one request entry; pushes size-adjustment notes onto `sizeNotes`. */
function parseSingleRequest(
  raw: RawRequest,
  sizeNotes: string[]
): ImageGenRequest | { error: string } {
  const prompt = raw.prompt
  const width = Number(raw.width)
  const height = Number(raw.height)
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { error: 'Each request needs a non-empty "prompt"' }
  }
  // Requests with a replace target may omit width/height — apply.ts reads
  // them from the target node, and the provider falls back to size "auto".
  // `replace_id` is the canonical param; `id` is accepted as a legacy alias.
  let rawReplaceId: string | undefined
  if (typeof raw.replace_id === 'string') {
    rawReplaceId = raw.replace_id
  } else if (typeof raw.id === 'string') {
    rawReplaceId = raw.id
  }
  const hasTarget = !!rawReplaceId && rawReplaceId.trim().length > 0
  const hasDims = Number.isFinite(width) && Number.isFinite(height)

  let outWidth: number | undefined
  let outHeight: number | undefined
  if (hasDims) {
    const normalized = normalizeSize(width, height)
    if ('error' in normalized) return { error: normalized.error }
    // 请求面保留 agent 原始尺寸——16px 对齐与边长/纵横比/像素钳制是
    // provider/API 约束，只在落图段归一为 API size（apply.ts
    // resolveOutputTarget）；画布节点按请求值创建，归一值不得泄露为
    // 节点尺寸（750x950 的 hero 候选帧曾因此落成 752x944，偏离槽位网格）。
    outWidth = Math.max(1, Math.round(width))
    outHeight = Math.max(1, Math.round(height))
    if (normalized.adjusted) {
      sizeNotes.push(`${width}x${height} → ${normalized.width}x${normalized.height}`)
    }
  } else if (!hasTarget) {
    return { error: 'New images need numeric "width" and "height"' }
  }

  const references = parseReferences(raw.references)
  if ('error' in references) return references

  const quality = parseEnumParam('quality', raw.quality, QUALITY_VALUES, QUALITY_ALIASES)
  if (typeof quality === 'object') return quality
  const outputFormat = parseEnumParam('output_format', raw.output_format, OUTPUT_FORMAT_VALUES)
  if (typeof outputFormat === 'object') return outputFormat
  const background = parseEnumParam('background', raw.background, BACKGROUND_VALUES)
  if (typeof background === 'object') return background

  const transparentBackground = parseTransparentBackground(raw.transparent_background)
  if (typeof transparentBackground === 'object') return transparentBackground

  return {
    replaceId: hasTarget ? rawReplaceId : undefined,
    prompt,
    width: outWidth,
    height: outHeight,
    quality,
    outputFormat,
    outputCompression:
      typeof raw.output_compression === 'number' ? raw.output_compression : undefined,
    background,
    transparent_background: transparentBackground,
    references: references.length > 0 ? references : undefined
  }
}

export function parseImageGenRequests(value: unknown): ParsedImageGenRequests | { error: string } {
  const parsed = parseJSONArrayParam(value, 'requests')
  if ('error' in parsed) return parsed

  const requests = parsed.items as RawRequest[]
  if (requests.length === 0) return { error: 'Empty requests array' }

  const sizeNotes: string[] = []
  const out: ImageGenRequest[] = []
  for (const raw of requests) {
    const request = parseSingleRequest(raw, sizeNotes)
    if ('error' in request) return request
    out.push(request)
  }

  const result: { requests: ImageGenRequest[]; sizeNote?: string; warning?: string } = {
    requests: out
  }
  if (sizeNotes.length > 0) {
    result.sizeNote = `Generation-call size adjusted to API constraints (16px alignment, edge/ratio/pixel limits) — canvas nodes are not resized by this adjustment: ${sizeNotes.join(', ')}`
  }
  if (parsed.warning) result.warning = parsed.warning
  return result
}
