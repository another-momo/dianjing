/**
 * 字体 HTTP 路由共享 helper。
 *
 * 形态：纯函数 + node:http 工具，路由层（routes.ts / store-routes.ts）双侧 import。
 * 抽出动机：store 路由同样要消费 readJSONBody / readRawBytesWithLimit / sendJSON；
 * routes.ts 旧私有函数迁移至本模块，行为一字不改。
 *
 * 出参 = JSON 信封：4xx/5xx 时返 `{ error, code? }`，5xx 不外泄细节。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { RejectionReason } from '@open-pencil/core/text/font/installed/validate'

export function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export type JSONReadResult = { ok: true; body: unknown } | { ok: false; error: string }

export async function readJSONBody(req: IncomingMessage): Promise<JSONReadResult> {
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

export function readStringBody(req: IncomingMessage, limit: number): Promise<StringBodyResult> {
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

export type RawBytesResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string; code?: 'too-large' }

export async function readRawBytesWithLimit(
  req: IncomingMessage,
  limit: number
): Promise<RawBytesResult> {
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

export function mapRejectionToText(reason: RejectionReason, detail: string): string {
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
    default:
      // RejectionReason 新增成员时的兜底文案（现有成员上方已穷举）
      return detail
  }
}
