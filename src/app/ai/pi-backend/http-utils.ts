/**
 * ai-panel-ux-consolidation：pi 后端 HTTP 共用 helper 抽离——
 * sendJSON / parseJSONBody / parsePostBody / readBody / PayloadTooLargeError / optionalString。
 *
 * server.ts 已超 oxlint max-lines 阈值（600）；抽本模块让 server.ts
 * 落回阈值内。所有 caller 已在原位（handle*Request 同源），零破坏面。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

// T27：UIMessage[] 最大合理体量——32MB 兜底多模态单回合多张大图
// （聊天文本 KB 级；图片 base64 内联按张数放大）。主体流量已由 transport 末条
// user 后缀裁剪裁掉旧消息，此处保留一个数量级余量。
export const MAX_BODY_BYTES = 32 * 1024 * 1024

export class PayloadTooLargeError extends Error {
  constructor() {
    super('request body too large')
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * T27 顺序语义：readBody 不在 reject 时同步 destroy() socket——
 * 旧行为先拆 socket 再写 413，响应字节落死连接、前端呈不透明 ECONNRESET 502。
 * 新行为 = 由调用方（parseJSONBody 等）写 413 后挂 res.on('finish') 兜底 destroy，
 * 响应字节先于 socket 关闭落地客户端。此处仅 stop listening + reject，让调用方
 * 拿到 PayloadTooLargeError 自行写响应。
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      // T27：请求体上限——超限即拒（不立即 destroy，由 parseJSONBody 写 413 后
      // 再断流，防 socket 提前关闭吞掉响应字节）
      if (size > MAX_BODY_BYTES) {
        aborted = true
        reject(new PayloadTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 解析 POST/PUT JSON body。返回 { ok: true, body } 或 { ok: false }（已写响应）。
 * 调用方拿到 ok=false 时直接 return 即可——避免各 handler 重复 try/catch + writeHead。
 * 超限按 413（readBody 拦截抛 PayloadTooLargeError），其余坏 JSON 一律 400。
 *
 * T27 顺序语义：超限写 413 时挂 'connection: close' + res.on('finish') 兜底
 * destroy socket——响应字节先落地客户端，再断流截断剩余上传；旧实现先 destroy
 * 再写 413，响应进死 socket 客户端呈不透明 ECONNRESET 502。
 */
export function sendPayloadTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(413, { connection: 'close' })
  res.end('Payload Too Large')
  res.on('finish', () => req.destroy())
}

export async function parseJSONBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const body: unknown = JSON.parse(await readBody(req))
    return { ok: true, body }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendPayloadTooLarge(req, res)
    } else {
      res.writeHead(400).end('Bad Request: invalid JSON')
    }
    return { ok: false }
  }
}

/**
 * POST JSON handler 公共头（jscpd 0 阈值纪律——各 handler 不再各自铺开
 * 405 + parseJSONBody 序列）：非 POST 写 405 返 null；body 解析失败
 * （parseJSONBody 已写 400）返 null；成功返 body。
 */
export async function parsePostBody<T>(
  req: IncomingMessage,
  res: ServerResponse
): Promise<T | null> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed')
    return null
  }
  const parsed = await parseJSONBody(req, res)
  return parsed.ok ? (parsed.body as T) : null
}

/** 从 unknown 取非空字符串；缺/类型错回 undefined——统一 T98 路由字段提取形态。 */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
