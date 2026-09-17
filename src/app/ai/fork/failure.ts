// 钉死说明（Batch 2a 路径分离，2026-09-05）：本文件此前与上游 base 字节一致，
// 自此钉死为 fork 副本、不再跟随上游——上游 2026-09 新增 5 类 reason，而 ChatPanel
// failureMessage switch 只认 3 类（insufficient-credit/output-limit/request-failed），
// 跟随会静默漂移出未处理的 reason。
// 2026-09-15：新增 'payload-too-large'——HTTP 413 / ECONNRESET 视为「请求体过大
// 或后端连接中断」归因线索（transport 主线已按末条 user 后缀裁剪；413 / ECONNRESET
// 多为多模态兜底击穿或后端短瞬中断，给用户可行动提示而非笼统 request-failed）
export type AIChatFailureReason =
  | 'insufficient-credit'
  | 'output-limit'
  | 'payload-too-large'
  | 'request-failed'

export type AIChatFailure = {
  reason: AIChatFailureReason
  detail?: string
}

export type ProviderErrorShape = {
  statusCode?: unknown
  status?: unknown
  responseStatusCode?: unknown
  responseStatus?: unknown
  code?: unknown
  response?: { status?: unknown }
}

function statusNumber(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

export function providerErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const value = error as ProviderErrorShape
  return (
    statusNumber(value.statusCode) ??
    statusNumber(value.status) ??
    statusNumber(value.responseStatusCode) ??
    statusNumber(value.responseStatus) ??
    statusNumber(value.code) ??
    statusNumber(value.response?.status)
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 2026-09-15：HTTP 413 / 502 / ECONNRESET 类错误归「payload-too-large」——
 * transport 拼出 `HTTP 413`、`HTTP 502`、`fetch failed`、`ECONNRESET`、
 * `BodyStreamBuffer was aborted` 等字面量；413/502/连接中断在前端裁剪后仍出现
 * 意味着请求体兜底击穿或后端瞬断，给用户具体归因而非笼统失败。
 */
export function isPayloadOrConnectionError(error: unknown): boolean {
  const status = providerErrorStatus(error)
  if (status === 413 || status === 502) return true
  const text = errorText(error).toLowerCase()
  return (
    text.includes('http 413') ||
    text.includes('http 502') ||
    text.includes('econnreset') ||
    text.includes('fetch failed') ||
    text.includes('failed to fetch') ||
    text.includes('socket hang up')
  )
}

export function isInsufficientCreditError(error: unknown): boolean {
  if (providerErrorStatus(error) === 402) return true
  const text = errorText(error).toLowerCase()
  return [
    'insufficient credit',
    'insufficient balance',
    'insufficient quota',
    'credit balance',
    'payment required',
    'quota exceeded',
    'billing quota',
    'top up',
    'top-up'
  ].some((phrase) => text.includes(phrase))
}

export function classifyAIChatFinish(finishReason?: string): AIChatFailure | null {
  return finishReason === 'length' ? { reason: 'output-limit' } : null
}

export function classifyAIChatError(error: unknown): AIChatFailure {
  if (isInsufficientCreditError(error)) {
    return { reason: 'insufficient-credit', detail: errorText(error) }
  }
  if (isPayloadOrConnectionError(error)) {
    return { reason: 'payload-too-large', detail: errorText(error) }
  }
  return { reason: 'request-failed', detail: errorText(error) }
}
