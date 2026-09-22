/**
 * pi 后端前端 fetch 共用 helper（jscpd 0 阈值纪律——各 client 不再各自铺开
 * requestJSON）。前端安全：纯 fetch，不引 node 模块（消费方进浏览器包）。
 *
 * 错误契约：非 2xx 时优先取 { error } 信封的文案（后端路由统一 JSON 信封），
 * 兜底 HTTP <status>。
 */
export async function requestPiJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (response.ok) return (await response.json()) as T
  const envelope = (await response.json().catch(() => null)) as { error?: string } | null
  const detail = envelope?.error?.trim() ? envelope.error : `HTTP ${response.status}`
  throw new Error(detail)
}
