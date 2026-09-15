/**
 * T21 P2 pi 后端管理 API 前端客户端。
 *
 * 对应 server.ts 的 admin 路由（vite proxy '/api/pi' → 127.0.0.1:7700）：
 *   GET    /api/pi/catalog                       → PiCatalog（含每个 provider 的 auth 状态）
 *   POST   /api/pi/credentials        {providerId, apiKey}
 *   DELETE /api/pi/credentials        {providerId}
 *   POST   /api/pi/providers          CustomProviderInput
 *   DELETE /api/pi/providers/{id}     （T100 C1：仅自定义 provider）
 *   POST   /api/pi/credentials/verify {providerId} （T100 B1：最小 chat 验真）
 *
 * 凭据只进不出：catalog 里只有 configured/type/source，绝不回传 key 本体。
 * catalog DTO 单源在 ./catalog（T27：纯类型契约模块，type-only import 构建期
 * 擦除，不会把后端 node 依赖打进浏览器包；此前双形状可选性不同逃逸了
 * type-shapes 查重——kimi M-4）。
 */

import { ref } from 'vue'

import type { PiCatalog, PiCatalogModel, PiCatalogProvider } from './catalog'

export type { PiCatalog, PiCatalogModel, PiCatalogProvider }

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type PiModelSpec = {
  providerId: string
  modelId: string
  thinkingLevel?: PiThinkingLevel
}

export type PiCustomProviderInput = {
  id: string
  name?: string
  baseUrl: string
  api?: string
  models: string[]
}

const API_PREFIX = '/api/pi'

export const piCatalog = ref<PiCatalog | null>(null)
export const piCatalogError = ref<string | null>(null)
export const piCatalogLoading = ref(false)

async function requestJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

function jsonBody(payload: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }
}

export async function refreshPiCatalog(): Promise<void> {
  piCatalogLoading.value = true
  piCatalogError.value = null
  try {
    piCatalog.value = await requestJSON<PiCatalog>('/catalog')
  } catch (error) {
    piCatalog.value = null
    piCatalogError.value = error instanceof Error ? error.message : String(error)
  } finally {
    piCatalogLoading.value = false
  }
}

export async function setPiCredential(providerId: string, apiKey: string): Promise<void> {
  await requestJSON<{ ok: true }>('/credentials', jsonBody({ providerId, apiKey }))
  await refreshPiCatalog()
}

export async function clearPiCredential(providerId: string): Promise<void> {
  const init = jsonBody({ providerId })
  await requestJSON<{ ok: true }>('/credentials', { ...init, method: 'DELETE' })
  await refreshPiCatalog()
}

export async function upsertPiProvider(input: PiCustomProviderInput): Promise<void> {
  await requestJSON<{ ok: true }>('/providers', jsonBody(input))
  await refreshPiCatalog()
}

/** T100 C1：删除自定义 provider——内建 providerId 后端会 400 拒绝 */
export async function deletePiProvider(providerId: string): Promise<void> {
  const init: RequestInit = { method: 'DELETE' }
  await requestJSON<{ ok: true }>(`/providers/${encodeURIComponent(providerId)}`, init)
  await refreshPiCatalog()
}

/** T100 B1：凭据验证结果——{ok:true} 或 {ok:false, error:中文文案} */
export type PiVerifyResult = { ok: boolean; error?: string }

export async function verifyPiCredential(providerId: string): Promise<PiVerifyResult> {
  return requestJSON<PiVerifyResult>('/credentials/verify', jsonBody({ providerId }))
}

/** ai-panel-ux-consolidation：打开用户拓展目录结果——成功 `{ok:true}` 或
 *  后端兜底翻译的 `{ok:false, error:中文文案}`。前端在 ok=false 时回退
 *  旧「复制路径」通路（copyStatus 三态机保留）。
 *  复用 PiVerifyResult 形态避免 type-shapes 重复门禁——两形态语义同（ok + 可选
 *  error 字段）。 */
export type OpenStudioFolderResult = PiVerifyResult

export async function openPiStudioFolder(): Promise<OpenStudioFolderResult> {
  try {
    return await requestJSON<OpenStudioFolderResult>('/open-studio-folder', { method: 'POST' })
  } catch (error) {
    // fetch / 反序列化失败 → 透传成 ok:false，与服务端 ok:false 同形
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 2026-09-15：POST /api/pi/ask-answer —— 表单作答/跳过端点。
 *
 * 契约：formId 非空 string + 二选一（answers 对象 / skip=true）。
 * 成功 200 {ok:true}；404 {error:'no_pending_form'} 表中无该 formId；
 * 400 校验失败。错误处理与 setPiCredential 同律（非 2xx 抛错带后端 message）。
 * 作答形态：answers[qid] = { value: string; freeText?: string }——「其他」
 * 选项选定时 freeText 是该题自包含的一等答案。
 */
export type AskAnswerSubmission =
  | {
      formId: string
      answers: Record<string, { value: string; freeText?: string }>
    }
  | { formId: string; skip: true }

export async function postAskAnswer(submission: AskAnswerSubmission): Promise<void> {
  await requestJSON<{ ok: true }>('/ask-answer', jsonBody(submission))
}
