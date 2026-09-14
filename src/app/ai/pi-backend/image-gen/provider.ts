/**
 * T54（Phase 3 W2/T-B3）：OpenAI 兼容图像 API provider 核心（自写，路线乙
 * 主路线）——自 open-pencil 仓 feature/agent-backend @ 5d38aa4e 的
 * tools/image-gen/providers.ts 移植。T66 起去 DMX 命名（P1）：本实现是通用
 * OpenAI 兼容端（/images/generations + /images/edits，Bearer 鉴权），
 * 与任何特定中转商无关；凭证四键（providerType/baseUrl/model/apiKey）
 * 全部由用户手填（T66 P0 删预设表）。
 *
 * T77：
 * - P3：不显式指定 response_format——gpt-image 系端点拒绝该参数（400
 *   `Unknown parameter: 'response_format'`），extractImageBytes 双格式消费
 *   使显式指定无收益（据 docs/202609010000-image-gen-provider-review.md P3）。
 * - P7：legacy `background` 由 provider 侧固定——Agent 无感，req.background
 *   字段不再被读取（owner 2026-09-02 决策）。
 * - P6：抽出可复用核心 createProviderCore；createImageGenProvider 仅为
 *   OpenAI 兼容族的薄封装，Seedream 族见 provider-seedream.ts；分派见
 *   factory.ts。
 *
 * transparent_background 透传（owner 2026-09-10 裁决，详见
 * docs/202609101102-transparent-bg-research.md）：
 * - req.transparent_background === true  → 线路 background='transparent'
 * - req.transparent_background === false → 线路 background='opaque'
 * - undefined                              → 线路 background=wire.background
 *                                              （OpenAI 兼容 'auto' / Seedream 'opaque' 兜底）
 *
 * 与源的差异：
 * - ofetch → 原生 fetch（红线：不引入新 npm 依赖；pi-backend 进程不经
 *   vite 打包，原生 fetch/FormData/Blob 均可用）
 * - 模块级可变凭证（setImageGenCredentials）→ 依赖注入：凭证经
 *   createImageGenProvider({credentials}) 传入，fetch 可注入（测试 mock）
 * - 超时：源 timeout 选项保留语义，改 AbortSignal.timeout；默认 240s
 *   （生图 HTTP 超时独立于桥超时，S3 §4），env DIANJING_IMAGE_GEN_TIMEOUT_MS
 *   可覆盖（调用时读取）
 *
 * key 卫生：本模块不打印 key；错误信息取自响应体（OpenAI 兼容端点的
 * error.message），不含请求头。
 */

import { decodeBase64 } from '@open-pencil/core/bytes'
import type {
  ImageGenProvider,
  ImageGenRequest,
  ImageGenResult
} from '@open-pencil/core/tools/fork/image-gen/requests'

import { DEFAULT_IMAGE_GEN_TIMEOUT_MS, readImageGenTimeoutMs } from '@/app/orchestration/env'

import type { ImageGenCredentials } from './credentials'

/** 生图 HTTP 超时基线（S3 §4：240s，独立于桥超时）；env 可覆盖 */
export const IMAGE_GEN_DEFAULT_TIMEOUT_MS = DEFAULT_IMAGE_GEN_TIMEOUT_MS

interface ImageAPIItem {
  b64_json?: string
  url?: string
}

interface ImageAPIResponse {
  data?: ImageAPIItem[]
}

type FetchLike = typeof fetch

async function extractImageBytes(
  data: ImageAPIResponse,
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<Uint8Array> {
  const item = data.data?.[0]
  if (!item) throw new Error('Image API returned no image data')
  if (item.b64_json) return decodeBase64(item.b64_json)
  if (item.url) {
    const response = await fetchImpl(item.url, { signal })
    if (!response.ok) throw new Error(`Download generated image: ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
  throw new Error('Image API response missing b64_json and url')
}

interface APIErrorBody {
  error?: { message?: string } | string
  detail?: string
  message?: string
}

/** 非 2xx 时从响应体提取真实错误文案（OpenAI 兼容 error.message / detail / 纯文本） */
async function apiErrorMessage(response: Response): Promise<string> {
  const fallback = `Image API: HTTP ${response.status}`
  const text = await response.text().catch(() => '')
  if (!text.trim()) return fallback
  let parsedBody: APIErrorBody | null = null
  try {
    parsedBody = JSON.parse(text) as APIErrorBody
  } catch {
    parsedBody = null // 非 JSON 错误体 → 原文返回
  }
  if (parsedBody) {
    if (
      parsedBody.error &&
      typeof parsedBody.error === 'object' &&
      typeof parsedBody.error.message === 'string'
    ) {
      return parsedBody.error.message
    }
    if (typeof parsedBody.detail === 'string' && parsedBody.detail) return parsedBody.detail
    if (typeof parsedBody.error === 'string' && parsedBody.error) return parsedBody.error
    if (typeof parsedBody.message === 'string' && parsedBody.message) return parsedBody.message
  }
  return text.slice(0, 500)
}

export interface ImageGenProviderOptions {
  credentials: ImageGenCredentials
  /** 测试注入点（CI 凭证链 mock，D34）；缺省用全局 fetch */
  fetchImpl?: FetchLike
  /** 缺省读 env DIANJING_IMAGE_GEN_TIMEOUT_MS || 240_000 */
  timeoutMs?: number
}

/**
 * T77 P6 抽出：provider 核心实现——OpenAI 兼容族与 Seedream 族共用。
 * - wire.name：provider.name（如 `openai-compatible(${model})`）
 * - wire.background：provider 兜底 background 值（P7：OpenAI 'auto'，
 *   Seedream 'opaque'——后者不接受 'auto'）。req.background 不再被读取；
 *   req.transparent_background 为 true 时改写为 'transparent'，为 false 时
 *   改写为 'opaque'，undefined 时回落 wire.background。
 * - wire.extraFields：族差异字段（如 Seedream 的 watermark: false）。
 *   FormData 路径 append(k, String(v))、JSON 路径对象展开（与
 *   withCompression 同款双形态写法）。
 *
 * 不导出——仅 createImageGenProvider / createSeedreamImageGenProvider
 * 两个工厂调用，对外通过 factory.createProviderFor 暴露。
 */
interface ProviderCoreWire {
  name: string
  background: 'auto' | 'opaque'
  extraFields?: Record<string, unknown>
}

/** T33: req.transparent_background 三态映射到 wire background 字段 */
function resolveBackground(
  wire: ProviderCoreWire,
  transparentBackground: boolean | undefined
): 'auto' | 'opaque' | 'transparent' {
  if (transparentBackground === true) return 'transparent'
  if (transparentBackground === false) return 'opaque'
  return wire.background
}

/**
 * 内部暴露给 provider-seedream.ts 共用——不写入对外 API 面（不在
 * factory.ts 重导出），仅作同目录兄弟工厂的实现依赖。导出符号而非
 * 函数体复制：以保持单源、确保族差异 wire 路径变更只在一处生效。
 */
export function createProviderCore(
  options: ImageGenProviderOptions,
  wire: ProviderCoreWire
): ImageGenProvider {
  const { credentials } = options
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? readImageGenTimeoutMs()
  const baseURL = credentials.baseUrl.replace(/\/$/, '')

  return {
    name: wire.name,
    // api 族：透传 background='transparent' 到上游；local 族（Seedream 等不支持
    // 原生透明的 provider）由调用方 runGeneratePhase 检测后走 prompt 注入 +
    // 后处理路径，本 provider 仍以 opaque baseline 收尾（transparent_background
    // =false 也走 'opaque'）。
    transparentSupport: 'api' as const,
    async generate(req: ImageGenRequest, images?: Uint8Array[]): Promise<ImageGenResult> {
      if (!credentials.apiKey) throw new Error('Image-gen API key not configured')
      const hasDims =
        req.width != null &&
        req.height != null &&
        Number.isFinite(req.width) &&
        Number.isFinite(req.height)
      const size = hasDims ? `${req.width}x${req.height}` : 'auto'
      const resultWidth = hasDims ? (req.width as number) : 1024
      const resultHeight = hasDims ? (req.height as number) : 1024
      const withCompression = (target: FormData | Record<string, unknown>) => {
        if (
          (req.outputFormat === 'jpeg' || req.outputFormat === 'webp') &&
          req.outputCompression != null
        ) {
          if (target instanceof FormData)
            target.append('output_compression', String(req.outputCompression))
          else target.output_compression = req.outputCompression
        }
      }
      // T77 P6 族差异字段注入：FormData 走 append(k, String(v))，
      // JSON 走对象展开（与 withCompression 同款双形态）。
      const applyExtraFields = (target: FormData | Record<string, unknown>) => {
        if (!wire.extraFields) return
        for (const [k, v] of Object.entries(wire.extraFields)) {
          if (target instanceof FormData) target.append(k, String(v))
          else target[k] = v
        }
      }
      // T33 transparent_background 三态映射：true→'transparent', false→'opaque',
      // undefined→wire.background（OpenAI 兼容 'auto' / Seedream 'opaque'）。
      const requestBackground = resolveBackground(wire, req.transparent_background)

      const signal = AbortSignal.timeout(timeoutMs)
      let response: Response
      if (images && images.length > 0) {
        const form = new FormData()
        form.append('model', credentials.model)
        form.append('prompt', req.prompt)
        form.append('size', size)
        form.append('n', '1')
        form.append('quality', req.quality ?? 'auto')
        form.append('output_format', req.outputFormat ?? 'png')
        withCompression(form)
        applyExtraFields(form)
        form.append('background', requestBackground)
        form.append('moderation', 'auto')
        images.forEach((bytes, index) => {
          form.append(
            'image[]',
            new Blob([bytes.slice().buffer], { type: 'image/png' }),
            `input-${index + 1}.png`
          )
        })

        response = await fetchImpl(`${baseURL}/images/edits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${credentials.apiKey}` },
          body: form,
          signal
        })
      } else {
        const body: Record<string, unknown> = {
          model: credentials.model,
          prompt: req.prompt,
          size,
          n: 1,
          quality: req.quality ?? 'auto',
          output_format: req.outputFormat ?? 'png',
          background: requestBackground,
          moderation: 'auto'
        }
        applyExtraFields(body)
        withCompression(body)

        response = await fetchImpl(`${baseURL}/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal
        })
      }

      if (!response.ok) throw new Error(await apiErrorMessage(response))
      const data = (await response.json()) as ImageAPIResponse
      const bytes = await extractImageBytes(data, fetchImpl, signal)
      return { bytes, width: resultWidth, height: resultHeight }
    }
  }
}

/** T77 P6：OpenAI 兼容族薄封装——background 'auto'，无族差异字段。 */
export function createImageGenProvider(options: ImageGenProviderOptions): ImageGenProvider {
  return createProviderCore(options, {
    name: `openai-compatible(${options.credentials.model})`,
    background: 'auto'
  })
}
