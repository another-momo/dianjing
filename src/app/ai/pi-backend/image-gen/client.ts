/**
 * T54（Phase 3 W2/T-B3）：generate_image 凭证面前端客户端（同构——
 * 只依赖 fetch/vue ref，不引 node 模块；vite proxy '/api/pi' → 7700）。
 * T66（P0/P1）：preset 下拉退役——四键（providerType/baseUrl/model/key）
 * 自由配置。T71：连接测试探针移除（owner 裁决 2026-09-01：并非所有
 * provider 实现 /models 端点，探针结论不可靠）。
 * 图片本地留存：retainLocal 布尔 + dir 绝对路径——settings 路由读写、
 * open-image-gen-folder 端点打开目录。
 *
 * 凭据只进不出：状态只有 configured/providerType/baseUrl/model 元数据，
 * 后端永不回传 key 本体（对应 image-gen/routes.ts）。
 */

import { ref } from 'vue'

import type { ImageGenProviderType } from './provider-types'

export { DEFAULT_IMAGE_GEN_PROVIDER_TYPE, IMAGE_GEN_PROVIDER_TYPES } from './provider-types'
export type { ImageGenProviderType }

// DTO 单源在 ./credentials（type-only import 构建期擦除，node 依赖不进浏览器包——
// 同 T27 catalog.ts 先例）
import type { ImageGenCredentialStatus } from './credentials'
// 图片本地留存设置 DTO 同源于 ./settings（type-only，build-time 擦除）
import type { ImageGenSettingsStatus } from './settings'

export type { ImageGenCredentialStatus, ImageGenSettingsStatus }

const API_PATH = '/api/pi/image-gen/credentials'
const SETTINGS_PATH = '/api/pi/image-gen/settings'

export const imageGenCredentialStatus = ref<ImageGenCredentialStatus | null>(null)
export const imageGenCredentialError = ref<string | null>(null)
export const imageGenCredentialLoading = ref(false)

// 图片本地留存设置状态：null = 未拉取过；非空 = 后端 GET 返回的最新值（含 dir）
export const imageGenSettings = ref<ImageGenSettingsStatus | null>(null)

async function requestJSON<T>(init?: RequestInit, path: string = API_PATH): Promise<T> {
  const response = await fetch(path, init)
  if (response.ok) return (await response.json()) as T
  const envelope = (await response.json().catch(() => null)) as { error?: string } | null
  const detail = envelope?.error?.trim() ? envelope.error : `HTTP ${response.status}`
  throw new Error(detail)
}

export async function refreshImageGenCredentialStatus(): Promise<void> {
  imageGenCredentialLoading.value = true
  imageGenCredentialError.value = null
  try {
    imageGenCredentialStatus.value = await requestJSON<ImageGenCredentialStatus>()
  } catch (error) {
    imageGenCredentialStatus.value = null
    imageGenCredentialError.value = error instanceof Error ? error.message : String(error)
  } finally {
    imageGenCredentialLoading.value = false
  }
}

/** 拉取最新设置（含 dir 字段）——失败时保留旧值，前端不显示 dir 行 */
export async function refreshImageGenSettings(): Promise<void> {
  try {
    imageGenSettings.value = await requestJSON<ImageGenSettingsStatus>(undefined, SETTINGS_PATH)
  } catch (error) {
    // 失败保留旧值：设置面板照常渲染，dir 行仅在 imageGenSettings 非空时显示；
    // 同一根因（后端离线）已由凭证面 banner 承担用户告知，这里只留 console 痕迹
    console.warn(
      '[image-gen] settings 拉取失败（保留旧值）：' +
        (error instanceof Error ? error.message : String(error))
    )
  }
}

/**
 * 切换图片本地留存开关——PUT 后刷新整张 settings（dir 不会变，但状态同源便于
 * 后续加字段时零前端改动）。
 */
export async function setImageGenRetainLocal(value: boolean): Promise<void> {
  await requestJSON<ImageGenSettingsStatus>(
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retainLocal: value })
    },
    SETTINGS_PATH
  )
  await refreshImageGenSettings()
}

/**
 * 打开图片本地留存目录——POST /api/pi/open-image-gen-folder；
 * 与 openPiStudioFolder 同形：返回 {ok:true} 或后端兜底翻译的 {ok:false, error}。
 */
export async function openImageGenFolder(): Promise<{ ok: boolean; error?: string }> {
  try {
    return await requestJSON<{ ok: boolean; error?: string }>(
      { method: 'POST' },
      '/api/pi/open-image-gen-folder'
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 空 key = 清除（00 #7：清除必须生效） */
export async function setImageGenCredential(input: {
  providerType: ImageGenProviderType
  baseUrl: string
  model: string
  apiKey: string
}): Promise<void> {
  await requestJSON<{ ok: true }>({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  })
  await refreshImageGenCredentialStatus()
}

export async function clearImageGenCredential(): Promise<void> {
  await requestJSON<{ ok: true }>({ method: 'DELETE' })
  await refreshImageGenCredentialStatus()
}
