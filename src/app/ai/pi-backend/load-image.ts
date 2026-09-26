/**
 * 2026-09-18 本地图片工具链（仓外 docs/202609151700-load-image-tool-research.md
 * §3/§6）：load_image——读本地图片文件并放上画布。
 * 2026-09-26 增 URL 支持（http/https/data:）——免「bash 先下载再 load」
 * 绕路，取字节后入同套嗅探/桥管线。
 *
 * 流程（§3.1，本地路径）：
 *   1. 路径判定（decidePath read facet，2026-09-19 A线尾单件1 翻正）：
 *      敏感名单（凭据四件 + ~/.ssh/** + ~/.aws/** + .env/.env.* + *.pem）
 *      命中 deny；名单外全 allow——界内界外皆可读（界外静默 allow，
 *      设计稿 §4.1/§4.3 拍板 1）
 *   2. fs 读文件（不存在/是目录/不可读各自明确错误文案）
 *   3. 格式嗅探（magic bytes + 扩展名双证）+ 字节上限（50MB，防 base64 传输放大）
 *   4. base64 桥调 core place_image_from_bytes（真解码闸/像素上限/矢量化/定位
 *      全在桥端点）
 *
 * URL 分支：file_path / url 恰给其一 → fetch-image-url 取字节 → 同套嗅探/桥。
 * 字节进桥之后管线与来源无关——URL 支持 = 把「fs 读文件」换成「HTTP 取字节」，
 * 产出同样的 {bytes, fileName, contentType} 汇入嗅探/桥。嗅探层加 sniff
 * opts.claimExt 模式区分：本地 = 扩展名声称 + magic 验证（无扩展名拒），
 * URL = claimExt（content-type 或 fileName 扩展名）优先、两者皆无走
 * magic-first 扫描。
 *
 * 归一化与名单复用 key-guard 机制（2026-09-18 CI 修红起归一化单一
 * 真源在 ./path-normalize.ts，两侧不再各自重述；2026-09-19 A线尾单起
 * 名单单源收编 ./path-decision.ts，key-guard 读侧共享同一判定原语）。
 *
 * key 卫生：桥 payload 只含文件名/字节 base64/MIME/节点 id，无路径之外的
 * 本地信息；文件绝对路径不进桥 payload（画布侧只需文件名做节点命名）。
 */

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { encodeBase64 } from '@open-pencil/core/bytes'

import { fetchImageFromURL } from './fetch-image-url'
import {
  createBridgeCaller,
  type BridgeCaller,
  type BridgeCallTarget
} from './image-gen/bridge-call'
import { decidePath } from './path-decision'
import { toToolResult } from './tool-result'

/** 字节上限（防 base64 传输放大；像素维度上限在桥端点，64MP） */
export const LOAD_IMAGE_MAX_BYTES = 50 * 1024 * 1024

const LOAD_IMAGE_DESCRIPTION = `Load an image onto the canvas from a local file or a URL. Supported: PNG/JPEG/WEBP/GIF/BMP (raster), SVG (vectorized into shape nodes). AVIF is not supported — convert to PNG/JPEG/WEBP first.

Provide exactly one of \`file_path\` or \`url\`. \`file_path\`: absolute path to a local file — it may live anywhere on disk, inside or outside the workspace; only credential/sensitive paths (API credentials, SSH/AWS config, .env files, PEM key material) are hard-blocked. \`url\`: an http/https image URL or a base64 \`data:\` URL. When the user gives an image link or another tool returns an image URL, call this tool with \`url\` directly — do not download it via shell first. URL fetches are plain GETs without cookies or auth headers, capped at 50MB; loopback, link-local and private-network addresses are blocked.

Set \`replace_id\` to fill an existing node (raster only); omit it to create a new node (auto-placed right of page content unless \`x\`/\`y\` are given). Returns the canvas node id, logical size, and image hash.

返回的节点即工作产物——后续编辑/引用直接操作画布节点，不要再对同一文件反复调用本工具。`

// ── 格式嗅探（magic bytes + 扩展名双证） ──

export type SniffedImage =
  | { ok: true; format: 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'svg'; mime: string }
  | { ok: false; error: string }

type RasterFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp'

const EXT_TO_FORMAT: Record<string, RasterFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp'
}

const FORMAT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

/** MIME → 扩展名（FORMAT_TO_MIME 派生，单一真源不另写映射；jpeg 一律 'jpeg'） */
export const MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze(
  Object.entries(FORMAT_TO_MIME).reduce<Record<string, string>>((acc, [format, mime]) => {
    acc[mime] = format === 'jpeg' ? 'jpeg' : format
    return acc
  }, {})
)

/** magic bytes 表：prefix = 起始魔数；webp 另需 offset 8 处 'WEBP' 四字节 */
const MAGIC_PREFIXES: Record<RasterFormat, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46, 0x38],
  bmp: [0x42, 0x4d],
  webp: [0x52, 0x49, 0x46, 0x46]
}
const WEBP_BRAND_OFFSET = 8
const WEBP_BRAND = [0x57, 0x45, 0x42, 0x50]

function hasBytePrefix(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false
  return prefix.every((byte, i) => bytes[offset + i] === byte)
}

function matchesMagic(format: RasterFormat, bytes: Uint8Array): boolean {
  const prefix = MAGIC_PREFIXES[format]
  if (!hasBytePrefix(bytes, prefix)) return false
  if (format === 'webp' && !hasBytePrefix(bytes, WEBP_BRAND, WEBP_BRAND_OFFSET)) return false
  return true
}

/** SVG 内容嗅探：剥 BOM/空白/`<?xml?>`/`<!DOCTYPE>`/注释后须以 `<svg` 起头 */
function looksLikeSVG(bytes: Uint8Array): boolean {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 8192))
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.trimStart()
  for (;;) {
    const prolog = text.match(/^<\?xml[\s\S]*?\?>/)
    if (prolog) {
      text = text.slice(prolog[0].length).trimStart()
      continue
    }
    const doctype = text.match(/^<!DOCTYPE[\s\S]*?>/)
    if (doctype) {
      text = text.slice(doctype[0].length).trimStart()
      continue
    }
    const comment = text.match(/^<!--[\s\S]*?-->/)
    if (comment) {
      text = text.slice(comment[0].length).trimStart()
      continue
    }
    break
  }
  return text.startsWith('<svg')
}

function unsupportedFormatError(label: string): string {
  return `Unsupported format (${label}). Convert to PNG/JPEG/WEBP first.`
}

/** 从 fileName 末尾取扩展名（小写、无点）；空 → '' */
function extractExtFromName(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName)
  return m?.[1]?.toLowerCase() ?? ''
}

/** magic-first 扫描：遍历已知 raster magic + SVG 内容嗅探；全不中 → unknown */
function magicFirstScan(bytes: Uint8Array): SniffedImage {
  for (const format of Object.keys(MAGIC_PREFIXES) as RasterFormat[]) {
    if (matchesMagic(format, bytes)) {
      return { ok: true, format, mime: FORMAT_TO_MIME[format] }
    }
  }
  if (looksLikeSVG(bytes)) {
    return { ok: true, format: 'svg', mime: FORMAT_TO_MIME.svg }
  }
  return { ok: false, error: unsupportedFormatError('unknown') }
}

/** 单扩展名下嗅探（SVG 走内容、raster 走 magic）；空 ext → 'unknown' */
function sniffByExt(bytes: Uint8Array, ext: string): SniffedImage {
  if (!ext) {
    return { ok: false, error: unsupportedFormatError('unknown') }
  }
  if (ext === 'svg') {
    return looksLikeSVG(bytes)
      ? { ok: true, format: 'svg', mime: FORMAT_TO_MIME.svg }
      : { ok: false, error: 'File is corrupted or not a valid image.' }
  }
  const claimed = EXT_TO_FORMAT[ext]
  if (!claimed) return { ok: false, error: unsupportedFormatError(ext) }
  if (!matchesMagic(claimed, bytes)) {
    return { ok: false, error: 'File is corrupted or not a valid image.' }
  }
  return { ok: true, format: claimed, mime: FORMAT_TO_MIME[claimed] }
}

/**
 * 两种模式：
 *  - 不传 opts（本地路径现状）：fileName 扩展名声称 + magic 验证；
 *    无扩展名拒绝。
 *  - 传 opts（URL 路径）：opts.claimExt 字符串时优先；否则退回 fileName
 *    扩展名；两者皆无 → magic-first 扫描（全 magic 表遍历 + SVG 内容
 *    嗅探），仍不中 → 「unknown」不支持。
 */
export function sniffImageFormat(
  bytes: Uint8Array,
  fileName: string,
  opts?: { claimExt?: string | null }
): SniffedImage {
  if (opts === undefined) {
    // 本地模式：无扩展名即拒
    return sniffByExt(bytes, extractExtFromName(fileName))
  }
  const claim = opts.claimExt
  if (typeof claim === 'string') {
    // URL 模式：claimExt 显式优先（content-type / fileName 扩展名衍生）
    return sniffByExt(bytes, claim.toLowerCase())
  }
  // URL 模式且 claimExt 缺失：退 fileName 扩展名，缺则 magic-first
  const fileExt = extractExtFromName(fileName)
  if (fileExt) return sniffByExt(bytes, fileExt)
  return magicFirstScan(bytes)
}

// ── 工具本体 ──

export interface LoadImageToolDeps {
  rootDir: string
  /** 桥调用（缺省 createBridgeCaller()）；测试注入 mock */
  callBridge?: BridgeCaller
  /** 当次请求的桥目标袋（service 装配期注入） */
  target?: BridgeCallTarget
  /** 测试注入（禁读真实 env/真实 home） */
  homeDir?: string
  cwd?: string
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 定位类可选参数（TypeBox 参数面的 TS 侧别名，两分支共用） */
type LoadImagePlacement = {
  replace_id?: string
  parent_id?: string
  x?: number
  y?: number
}

function buildBridgeArgs(
  name: string,
  bytes: Uint8Array,
  mime: string,
  placement: LoadImagePlacement
): Record<string, unknown> {
  const bridgeArgs: Record<string, unknown> = { name, image_data: encodeBase64(bytes), mime }
  if (placement.replace_id) bridgeArgs.replace_id = placement.replace_id
  if (placement.parent_id) bridgeArgs.parent_id = placement.parent_id
  if (placement.x !== undefined) bridgeArgs.x = placement.x
  if (placement.y !== undefined) bridgeArgs.y = placement.y
  return bridgeArgs
}

async function placeViaBridge(
  deps: LoadImageToolDeps,
  args: Record<string, unknown>
): Promise<AgentToolResult<Record<string, unknown>>> {
  const callBridge = deps.callBridge ?? createBridgeCaller()
  try {
    const result = await callBridge('place_image_from_bytes', args, deps.target)
    if (typeof result.error === 'string' && result.error) {
      return toToolResult({ error: result.error })
    }
    return toToolResult(result)
  } catch (error) {
    // 桥调用层抛错已是分类/清洗后的模型可见文案（bridge-errors.ts）
    return toToolResult({ error: toErrorMessage(error) })
  }
}

/** URL 分支：fetch 取字节 → 声称格式收敛 → 嗅探 → 桥（与本地分支同管线） */
async function loadFromURL(
  deps: LoadImageToolDeps,
  url: string,
  placement: LoadImagePlacement
): Promise<AgentToolResult<Record<string, unknown>>> {
  const fetched = await fetchImageFromURL(url, { maxBytes: LOAD_IMAGE_MAX_BYTES })
  if (!fetched.ok) return toToolResult({ error: fetched.error })
  // claimExt 优先 content-type（MIME_TO_EXT 反查），退 fileName 扩展名
  // （EXT_TO_FORMAT 认可才算），两者皆无 → null（magic-first 入口）
  const ctMain = fetched.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  let claimExt: string | null = null
  if (ctMain && ctMain in MIME_TO_EXT) {
    claimExt = MIME_TO_EXT[ctMain] ?? null
  } else {
    const fileExt = extractExtFromName(fetched.fileName)
    if (fileExt && fileExt in EXT_TO_FORMAT) {
      claimExt = fileExt
    }
  }
  const sniffed = sniffImageFormat(fetched.bytes, fetched.fileName, { claimExt })
  if (!sniffed.ok) return toToolResult({ error: sniffed.error })
  return placeViaBridge(
    deps,
    buildBridgeArgs(fetched.fileName, fetched.bytes, sniffed.mime, placement)
  )
}

export function createLoadImageTool(deps: LoadImageToolDeps) {
  return defineTool({
    name: 'load_image',
    label: 'Load Image',
    description: LOAD_IMAGE_DESCRIPTION,
    parameters: Type.Object({
      file_path: Type.Optional(
        Type.String({
          description:
            'Absolute path to the local image file; inside or outside the workspace (credential/sensitive paths are blocked)'
        })
      ),
      url: Type.Optional(
        Type.String({
          description:
            'Image URL to fetch (http/https or base64 data: URL). Use this for web images or links returned by other tools'
        })
      ),
      replace_id: Type.Optional(
        Type.String({ description: 'Existing node ID to fill (omit = create new node)' })
      ),
      parent_id: Type.Optional(
        Type.String({ description: 'Parent node ID for new nodes (omit = page level)' })
      ),
      x: Type.Optional(
        Type.Number({ description: 'X position for new nodes (omit = auto-place)' })
      ),
      y: Type.Optional(Type.Number({ description: 'Y position for new nodes (omit = auto-place)' }))
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      // 0. file_path / url 互斥（分段守卫——算术 XOR 不产 TS 并型收窄）
      const filePath = params.file_path
      const url = params.url
      if (url !== undefined && filePath !== undefined) {
        return toToolResult({ error: 'Provide exactly one of `file_path` or `url`.' })
      }

      // URL 分支
      if (url !== undefined) return loadFromURL(deps, url, params)

      // 本地路径分支（双缺在此拒：url 缺席且 filePath 缺席 = 违反恰给其一）
      if (filePath === undefined) {
        return toToolResult({ error: 'Provide exactly one of `file_path` or `url`.' })
      }

      // 1. 路径判定（decidePath read facet——broker P0-1 收编后单一判定服务）
      const decision = decidePath(filePath, {
        facet: 'read',
        rootDir: deps.rootDir,
        cwd: deps.cwd,
        homeDir: deps.homeDir
      })
      if (!decision.ok) return toToolResult({ error: decision.error, reason: decision.reason })
      const absolutePath = decision.absolutePath

      // 2. fs 读（不存在/是目录/不可读各自明确文案）
      let bytes: Uint8Array
      try {
        const stat = statSync(absolutePath)
        if (stat.isDirectory()) {
          return toToolResult({ error: `Path is a directory, not a file: ${absolutePath}` })
        }
        if (stat.size > LOAD_IMAGE_MAX_BYTES) {
          return toToolResult({
            error: `File too large (${Math.ceil(stat.size / 1024 / 1024)}MB). Maximum supported size is 50MB.`
          })
        }
        bytes = readFileSync(absolutePath)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          return toToolResult({ error: `File not found: ${absolutePath}` })
        }
        if (code === 'EACCES' || code === 'EPERM') {
          return toToolResult({ error: `File is not readable: ${absolutePath}` })
        }
        return toToolResult({ error: `Failed to read file: ${toErrorMessage(error)}` })
      }
      if (bytes.byteLength > LOAD_IMAGE_MAX_BYTES) {
        return toToolResult({
          error: `File too large (${Math.ceil(bytes.byteLength / 1024 / 1024)}MB). Maximum supported size is 50MB.`
        })
      }

      // 3. 格式嗅探（magic bytes + 扩展名双证）
      const fileName = basename(absolutePath)
      const sniffed = sniffImageFormat(bytes, fileName)
      if (!sniffed.ok) return toToolResult({ error: sniffed.error })

      // 4. 桥调 place_image_from_bytes（真解码闸/像素上限/矢量化/定位在桥端点）
      return placeViaBridge(deps, buildBridgeArgs(fileName, bytes, sniffed.mime, params))
    }
  })
}
