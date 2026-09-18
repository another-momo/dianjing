/**
 * 2026-09-18 本地图片工具链（仓外 docs/202609151700-load-image-tool-research.md
 * §3/§6）：load_image——读本地图片文件并放上画布。
 *
 * 流程（§3.1）：
 *   1. 路径三态裁决（broker 未落地前无 ask）：workspace 子树 allow；
 *      deny 名单（key-guard protectedWriteRoots：pi-agent/**、workspace/.pi/**、
 *      workspace/.agents/**）deny；其余路径一律 deny
 *   2. fs 读文件（不存在/是目录/不可读各自明确错误文案）
 *   3. 格式嗅探（magic bytes + 扩展名双证）+ 字节上限（50MB，防 base64 传输放大）
 *   4. base64 桥调 core place_image_from_bytes（真解码闸/像素上限/矢量化/定位
 *      全在桥端点）
 *
 * 归一化与 deny 名单复用 key-guard 机制（normalizePathDual/isWriteHit 同
 * 算法；2026-09-18 CI 修红起归一化单一真源在 ./path-normalize.ts，两侧
 * 不再各自重述）。路径裁决与 export_image_to_file 共享（同文件导出
 * decideWorkspacePath，写侧口径一致）。
 *
 * key 卫生：桥 payload 只含文件名/字节 base64/MIME/节点 id，无路径之外的
 * 本地信息；文件绝对路径不进桥 payload（画布侧只需文件名做节点命名）。
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { encodeBase64 } from '@open-pencil/core/bytes'

import {
  createBridgeCaller,
  type BridgeCaller,
  type BridgeCallTarget
} from './image-gen/bridge-call'
import { protectedWriteRoots } from './key-guard'
import { normalizePathDual } from './path-normalize'
import { resolveWorkspaceDir } from './paths'
import { toToolResult } from './tool-result'

/** 字节上限（防 base64 传输放大；像素维度上限在桥端点，64MP） */
export const LOAD_IMAGE_MAX_BYTES = 50 * 1024 * 1024

const LOAD_IMAGE_DESCRIPTION = `Load a local image file and place it on the canvas. Supported: PNG/JPEG/WEBP/GIF/BMP (raster), SVG (vectorized into shape nodes). AVIF is not supported — convert to PNG/JPEG/WEBP first.

The file must be inside the workspace directory; paths outside it (and the protected agent configuration areas) are denied. Set \`replace_id\` to fill an existing node (raster only); omit it to create a new node (auto-placed right of page content unless \`x\`/\`y\` are given). Returns the canvas node id, logical size, and image hash.

返回的节点即工作产物——后续编辑/引用直接操作画布节点，不要再对同一文件反复调用本工具。`

// ── 路径三态裁决（共享归一化算法 + deny 名单；§6） ──

export interface PathDecisionOptions {
  rootDir: string
  /** 相对路径解析基点（缺省 = workspace 目录，与 session cwd 同点） */
  cwd?: string
  homeDir?: string
}

export type PathDecision =
  | { ok: true; /** 绝对路径（大小写保留，供真实 IO） */ absolutePath: string }
  | { ok: false; error: string; reason: 'denied' }

/** key-guard isWriteHit 同算法：normalized 本身是受保护目录或其后代 */
function hitsProtectedRoot(compare: string, protectedCompare: ReadonlySet<string>): boolean {
  for (const target of protectedCompare) {
    if (compare === target) return true
    if (compare.startsWith(target + '/')) return true
  }
  return false
}

/**
 * 路径三态裁决（broker 落地前：无 ask，出界即 deny）：
 *   allow = workspace 子树；deny = protectedWriteRoots 命中（facet 防自植）；
 *   其余一律 deny（出界）。
 */
export function decideWorkspacePath(input: string, opts: PathDecisionOptions): PathDecision {
  const cwd = opts.cwd ?? resolveWorkspaceDir(opts.rootDir)
  const homeDir = opts.homeDir ?? homedir()
  const { compare, absolute } = normalizePathDual(input, cwd, homeDir)
  const protectedCompare = new Set(
    protectedWriteRoots(opts.rootDir).map((p) => normalizePathDual(p, cwd, homeDir).compare)
  )
  if (hitsProtectedRoot(compare, protectedCompare)) {
    return {
      ok: false,
      reason: 'denied',
      error:
        'Access denied: this path is in the protected agent configuration area and is not accessible to agent tools.'
    }
  }
  const workspaceCompare = normalizePathDual(
    resolveWorkspaceDir(opts.rootDir),
    cwd,
    homeDir
  ).compare
  if (compare === workspaceCompare || compare.startsWith(workspaceCompare + '/')) {
    return { ok: true, absolutePath: absolute }
  }
  return {
    ok: false,
    reason: 'denied',
    error: `Path outside workspace: ${absolute}. Move the file into the workspace directory and retry.`
  }
}

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

/**
 * magic bytes + 扩展名双证：扩展名定声称格式，magic 验证真伪（不一致 =
  伪造/损坏，拒）；SVG 走内容嗅探（无 magic 可言）；AVIF/HEIC 等扩展名
  明确报"暂不支持"。
 */
export function sniffImageFormat(bytes: Uint8Array, fileName: string): SniffedImage {
  const extMatch = /\.([a-z0-9]+)$/i.exec(fileName)
  const ext = extMatch?.[1]?.toLowerCase() ?? ''
  if (ext === 'svg') {
    return looksLikeSVG(bytes)
      ? { ok: true, format: 'svg', mime: FORMAT_TO_MIME.svg }
      : { ok: false, error: 'File is corrupted or not a valid image.' }
  }
  const claimed = ext ? EXT_TO_FORMAT[ext] : undefined
  if (!claimed) return { ok: false, error: unsupportedFormatError(ext || 'unknown') }
  if (!matchesMagic(claimed, bytes)) {
    return { ok: false, error: 'File is corrupted or not a valid image.' }
  }
  return { ok: true, format: claimed, mime: FORMAT_TO_MIME[claimed] }
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

export function createLoadImageTool(deps: LoadImageToolDeps) {
  return defineTool({
    name: 'load_image',
    label: 'Load Image',
    description: LOAD_IMAGE_DESCRIPTION,
    parameters: Type.Object({
      file_path: Type.String({
        description: 'Absolute path to the local image file; must be inside the workspace directory'
      }),
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
      // 1. 路径三态裁决
      const decision = decideWorkspacePath(params.file_path, {
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
      const callBridge = deps.callBridge ?? createBridgeCaller()
      const bridgeArgs: Record<string, unknown> = {
        name: fileName,
        image_data: encodeBase64(bytes),
        mime: sniffed.mime
      }
      if (params.replace_id) bridgeArgs.replace_id = params.replace_id
      if (params.parent_id) bridgeArgs.parent_id = params.parent_id
      if (params.x !== undefined) bridgeArgs.x = params.x
      if (params.y !== undefined) bridgeArgs.y = params.y
      try {
        const result = await callBridge('place_image_from_bytes', bridgeArgs, deps.target)
        if (typeof result.error === 'string' && result.error) {
          return toToolResult({ error: result.error })
        }
        return toToolResult(result)
      } catch (error) {
        // 桥调用层抛错已是分类/清洗后的模型可见文案（bridge-errors.ts）
        return toToolResult({ error: toErrorMessage(error) })
      }
    }
  })
}
