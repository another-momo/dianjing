/**
 * 应用字体库（pi-backend fonts）HTTP 客户端。
 *
 * 对应 server.ts 的字体库路由（vite proxy '/api/pi' → 127.0.0.1:7700）：
 *   GET    /api/pi/fonts/list                  → { families: FamilyView[], manifestPath: string }
 *   POST   /api/pi/fonts/install               body=raw bytes（Content-Type application/octet-stream）
 *   GET    /api/pi/fonts/read?family=&style=   → bytes（按 content-type 推 mime）
 *   DELETE /api/pi/fonts/delete                body { family, style? } → 删字节 + manifest
 *
 * 字节传输：list 走 JSON 序列化；install / read 走 raw bytes（FontFace / File
 * 等二进制友好），headers 显式声明 content-type / accept。
 *
 * 错误处理：与 client.ts 同构——response.ok 检查 + 解析 {error} 字段抛
 * Error(message)；上层在 try/catch 中映射为本地化文案。
 */
import type { FamilyView } from '@open-pencil/core/text/font/installed/manifest'

export type { FamilyView } from '@open-pencil/core/text/font/installed/manifest'

const API_PREFIX = '/api/pi'

async function readErrorBody(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string } | null
    if (body && typeof body.error === 'string') return body.error
  } catch {
    // 非 JSON 错误响应（read 端点理论上不会，但兜底）
  }
  return `HTTP ${response.status}`
}

/** 拉取已装字体族聚合视图（FamilyView[]） */
export async function fetchInstalledFonts(): Promise<FamilyView[]> {
  const response = await fetch(`${API_PREFIX}/fonts/list`, { method: 'GET' })
  if (!response.ok) throw new Error(await readErrorBody(response))
  const body = (await response.json()) as { families?: unknown }
  if (!Array.isArray(body.families)) return []
  return body.families as FamilyView[]
}

/**
 * 提交字体字节安装：raw bytes body（content-type application/octet-stream）。
 * 调用方应先经 install.ts 预校验 + woff2 转码，端点侧只收 sfnt 字节。
 */
export async function installFontBytes(bytes: Uint8Array): Promise<{ family: string }> {
  const response = await fetch(`${API_PREFIX}/fonts/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  })
  if (!response.ok) throw new Error(await readErrorBody(response))
  const body = (await response.json()) as { family?: unknown }
  if (typeof body.family !== 'string') {
    throw new Error('install response missing family field')
  }
  return { family: body.family }
}

/** 读族内某 style 的字节（FamilyView 的 key 字段） */
export async function readFontBytes(family: string, styleKey: string): Promise<ArrayBuffer> {
  const params = new URLSearchParams({ family, style: styleKey })
  const response = await fetch(`${API_PREFIX}/fonts/read?${params.toString()}`, { method: 'GET' })
  if (!response.ok) throw new Error(await readErrorBody(response))
  return response.arrayBuffer()
}

/**
 * 删除：styleKey 不传 = 删整族；传 = 删单 style。
 * 端点语义（删整族 / 删单 style）由服务端在 body.style 缺省时路由——本客户端
 * 不在 URL 上区分。
 */
export async function deleteInstalledFont(
  family: string,
  styleKey?: string
): Promise<{ deleted: boolean }> {
  const payload: { family: string; style?: string } = { family }
  if (styleKey) payload.style = styleKey
  const response = await fetch(`${API_PREFIX}/fonts/delete`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!response.ok) throw new Error(await readErrorBody(response))
  return { deleted: true }
}
