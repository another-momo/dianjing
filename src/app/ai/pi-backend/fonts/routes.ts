/**
 * pi-backend 字体库 HTTP 路由。
 *
 * 端点组（鉴权由 server.ts 前置，本模块只关心入参/出参语义）：
 *  - GET    /api/pi/fonts/list                  → FamilyView[]（manifest 聚合视图）
 *  - POST   /api/pi/fonts/install (path 形态)    body { path: string, ext: string } → 读磁盘
 *  - POST   /api/pi/fonts/install (bytes 形态)   body = raw bytes（per-route 上限 60MB）
 *  - GET    /api/pi/fonts/read?family=&style=    → bytes（按 content-type 推 mime）
 *  - POST   /api/pi/fonts/delete                body { family, style? } → 删字节 + manifest
 *
 * 入参形态：raw bytes body（Content-Type application/octet-stream）。Electron
 * 形态也走 bytes——renderer 侧经文件对话框通道读字节后上传，服务端不直读
 * 任意路径（最小权限：端点不收磁盘路径参数）。
 *
 * 校验口径：完整校验链走 core/text/font/installed/validate（魔数 + 大小 +
 * opentype parse + VF 嗅探 + name 表）。坏字节按拒绝原因映射本地化文案。
 *
 * 错误响应（统一 JSON 信封）：
 *  - 4xx → { error, code? }（code 是稳定错误码）
 *  - 5xx → { error }（不外泄细节）
 *  - 字节流响应不走 JSON 信封（read 端点直接 file bytes）
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { StyleEntry } from '@open-pencil/core/text/font/installed/manifest'
import { toFamilyViews } from '@open-pencil/core/text/font/installed/manifest'
import {
  DEFAULT_MAX_BYTES,
  validateFontBytes,
  type RejectionReason
} from '@open-pencil/core/text/font/installed/validate'

import { type FontsStore } from './store'

const LIST_PATHNAME = '/api/pi/fonts/list'
const INSTALL_PATHNAME = '/api/pi/fonts/install'
const READ_PATHNAME = '/api/pi/fonts/read'
const DELETE_PATHNAME = '/api/pi/fonts/delete'

/** per-route 字节上限——install 收字节形态时单独计数（http-utils.ts 全局 32MB 单值不动） */
const INSTALL_BODY_LIMIT = DEFAULT_MAX_BYTES

/** MIME 推导（font 注册表 mime） */
const FONT_MIME: Record<'ttf' | 'otf', string> = {
  ttf: 'font/ttf',
  otf: 'font/otf'
}

// ── 公开端点调度 ─────────────────────────────────────────────────────

export interface FontsRouteDeps {
  store: FontsStore
}

export async function handleFontsRequest(
  deps: FontsRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (
    pathname !== LIST_PATHNAME &&
    pathname !== INSTALL_PATHNAME &&
    pathname !== READ_PATHNAME &&
    pathname !== DELETE_PATHNAME
  ) {
    return false
  }
  try {
    if (pathname === LIST_PATHNAME) return await handleList(deps, req, res)
    if (pathname === INSTALL_PATHNAME) return await handleInstall(deps, req, res)
    if (pathname === READ_PATHNAME) return await handleRead(deps, req, res)
    return await handleDelete(deps, req, res)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJSON(res, 500, { error: message })
    return true
  }
}

// ── GET /api/pi/fonts/list ───────────────────────────────────────────

async function handleList(
  deps: FontsRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (req.method !== 'GET') {
    sendJSON(res, 405, { error: 'method not allowed' })
    return true
  }
  const manifest = deps.store.readManifest()
  sendJSON(res, 200, { families: toFamilyViews(manifest), manifestPath: deps.store.manifestPath })
  return true
}

// ── POST /api/pi/fonts/install ───────────────────────────────────────

async function handleInstall(
  deps: FontsRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (req.method !== 'POST') {
    sendJSON(res, 405, { error: 'method not allowed' })
    return true
  }

  // bytes 形态：raw body = font bytes；per-route 上限 60MB（独立于全局 32MB）
  const read = await readRawBytesWithLimit(req, INSTALL_BODY_LIMIT)
  if (!read.ok) {
    if (read.code === 'too-large') {
      sendJSON(res, 413, {
        error: `font body exceeds ${INSTALL_BODY_LIMIT / 1024 / 1024} MB limit`,
        code: 'too-large'
      })
      return true
    }
    sendJSON(res, 400, { error: read.error })
    return true
  }
  const bytes = read.bytes

  // 校验链：完整 validateFontBytes（魔数 + 大小 + opentype parse + VF + name）
  const validation = validateFontBytes(bytes)
  if (!validation.ok) {
    sendJSON(res, 400, {
      error: mapRejectionToText(validation.reason, validation.detail),
      code: validation.reason
    })
    return true
  }

  // 库存恒 sfnt：woff/woff2 由安装管线在调用端点前完成转码
  if (validation.container !== 'ttf' && validation.container !== 'otf') {
    sendJSON(res, 400, {
      error: 'woff/woff2 fonts must be transcoded to ttf/otf before install',
      code: 'sfnt-required'
    })
    return true
  }
  const ext: 'ttf' | 'otf' = validation.container

  const family = validation.family || 'Unknown'
  const styleKey = validation.style || `${validation.weight}${validation.italic ? ' Italic' : ''}`
  const hash = deps.store.hashBytes(bytes)
  const styleEntry: StyleEntry = {
    key: styleKey,
    weight: validation.weight,
    italic: validation.italic,
    variable: validation.variable,
    hash,
    ext,
    size: bytes.byteLength,
    artifact: 'full',
    source: 'local-file',
    installedAt: Date.now()
  }
  if (validation.wghtRange) {
    styleEntry.wghtRange = validation.wghtRange
  }

  const result = deps.store.installBytes({
    bytes,
    ext,
    style: styleEntry,
    family,
    artifact: 'full'
  })

  sendJSON(res, 200, {
    ok: true,
    family,
    style: styleKey,
    hash: result.hash,
    size: bytes.byteLength,
    container: validation.container,
    variable: validation.variable,
    weight: validation.weight,
    italic: validation.italic,
    wghtRange: validation.wghtRange
  })
  return true
}

// ── GET /api/pi/fonts/read?family=&style= ───────────────────────────

async function handleRead(
  deps: FontsRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (req.method !== 'GET') {
    sendJSON(res, 405, { error: 'method not allowed' })
    return true
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const family = url.searchParams.get('family')
  const style = url.searchParams.get('style')
  if (!family || !style) {
    sendJSON(res, 400, { error: 'family and style query params required', code: 'missing-params' })
    return true
  }
  const manifest = deps.store.readManifest()
  const familyEntry = manifest.families.find((f) => f.family === family)
  const styleEntry = familyEntry?.styles.find((s) => s.key === style)
  if (!styleEntry) {
    sendJSON(res, 404, { error: `font not installed: ${family} / ${style}`, code: 'not-found' })
    return true
  }
  if (styleEntry.artifact !== 'full') {
    sendJSON(res, 501, {
      error: 'subset-collection artifacts require the per-piece endpoint (not yet implemented)',
      code: 'subset-not-supported'
    })
    return true
  }
  const bytes = deps.store.readBytes(styleEntry.hash, styleEntry.ext ?? 'ttf')
  if (bytes === null) {
    sendJSON(res, 404, {
      error: `font file missing on disk: ${styleEntry.hash}`,
      code: 'file-missing'
    })
    return true
  }
  res.writeHead(200, {
    'content-type': FONT_MIME[styleEntry.ext ?? 'ttf'],
    'content-length': String(bytes.byteLength)
  })
  res.end(bytes)
  return true
}

// ── POST /api/pi/fonts/delete ────────────────────────────────────────

async function handleDelete(
  deps: FontsRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    sendJSON(res, 405, { error: 'method not allowed' })
    return true
  }
  const parsed = await readJsonBody(req)
  if (!parsed.ok) {
    sendJSON(res, 400, { error: parsed.error })
    return true
  }
  const body = parsed.body as { family?: unknown; style?: unknown }
  if (typeof body.family !== 'string' || body.family.length === 0) {
    sendJSON(res, 400, { error: 'family required', code: 'family-required' })
    return true
  }
  if (body.style !== undefined && typeof body.style !== 'string') {
    sendJSON(res, 400, { error: 'style must be a string when present', code: 'bad-style' })
    return true
  }
  const family = body.family
  const styleKey = typeof body.style === 'string' && body.style.length > 0 ? body.style : null

  if (styleKey) {
    const result = deps.store.deleteStyle(family, styleKey)
    if (!result.removed) {
      sendJSON(res, 404, { error: `style not found: ${family} / ${styleKey}`, code: 'not-found' })
      return true
    }
    sendJSON(res, 200, { ok: true, family, style: styleKey, deleted: true })
    return true
  }

  const result = deps.store.deleteFamily(family)
  if (!result.removed) {
    sendJSON(res, 404, { error: `family not found: ${family}`, code: 'not-found' })
    return true
  }
  sendJSON(res, 200, { ok: true, family, deletedFiles: result.removedFiles, deleted: true })
  return true
}

// ── 内部 helper ──────────────────────────────────────────────────────

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

type JsonReadResult = { ok: true; body: unknown } | { ok: false; error: string }

async function readJsonBody(req: IncomingMessage): Promise<JsonReadResult> {
  const raw = await readStringBody(req, 1024 * 1024)
  if (!raw.ok) return { ok: false, error: raw.error }
  try {
    const body = JSON.parse(raw.body) as unknown
    return { ok: true, body }
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

type StringBodyResult = { ok: true; body: string } | { ok: false; error: string }

function readStringBody(req: IncomingMessage, limit: number): Promise<StringBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > limit) {
        aborted = true
        resolve({ ok: false, error: `body exceeds ${limit} bytes` })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', (error) => {
      if (aborted) return
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
  })
}

type RawBytesResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string; code?: 'too-large' }

async function readRawBytesWithLimit(req: IncomingMessage, limit: number): Promise<RawBytesResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > limit) {
        aborted = true
        resolve({
          ok: false,
          error: `body exceeds ${limit} bytes`,
          code: 'too-large'
        })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      resolve({ ok: true, bytes: new Uint8Array(Buffer.concat(chunks)) })
    })
    req.on('error', (error) => {
      if (aborted) return
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
  })
}

function mapRejectionToText(reason: RejectionReason, detail: string): string {
  switch (reason) {
    case 'too-small':
      return 'font bytes are too small to be a valid font'
    case 'too-large':
      return detail
    case 'unknown-format':
      return 'this font file is corrupted and cannot be recognized'
    case 'is-collection':
      return 'this is a font collection — please extract individual fonts first'
    case 'corrupt':
      return 'this font file is corrupted and cannot be parsed'
    case 'no-name-table':
      return 'this font file has no name table — family/style cannot be derived'
  }
}
